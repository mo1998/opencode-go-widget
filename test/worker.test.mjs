/**
 * Local test harness for deploy/cloudflare-worker/worker.js.
 * Runs the worker under Node with stubbed caches/fetch/ASSETS so the routing,
 * auth, caching and stale-fallback logic are verified without deploying.
 */
import assert from 'node:assert/strict';

// ---- stubs -----------------------------------------------------------------

const cacheStore = new Map();
globalThis.caches = {
  default: {
    async match(req) {
      const hit = cacheStore.get(req.url);
      return hit ? hit.clone() : undefined;
    },
    async put(req, res) {
      cacheStore.set(req.url, res.clone());
    },
  },
};

let upstreamCalls = 0;
let upstreamMode = 'ok';
const GOOD = {
  usage: {
    rolling: { status: 'ok', percent: 12, resetsAt: '2026-10-19T10:41:37.000Z' },
    weekly: { status: 'ok', percent: 40, resetsAt: '2026-10-26T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 91, resetsAt: '2026-10-22T07:03:14.000Z' },
  },
};

// Real values captured from the live console endpoint, where the key-based API
// floored to 5 / 2 / 47 but the console displayed 6 / 2 / 48.
const CONSOLE_PAYLOAD = {
  access: {
    endsAt: '2026-10-22T07:03:14.000Z',
    meters: {
      fiveHour: {
        resetsAt: '2026-10-19T10:41:37.000Z',
        limitMicroCents: '1200000000',
        usedMicroCents: '70030000', //  5.8358%
      },
      week: {
        resetsAt: '2026-10-26T00:00:00.000Z',
        limitMicroCents: '3000000000',
        usedMicroCents: '70030000', //  2.3343%
      },
      month: {
        resetsAt: '2026-10-22T07:03:14.000Z',
        limitMicroCents: '6000000000',
        usedMicroCents: '2857050000', // 47.6175%
      },
    },
  },
};

const KEY_FLOORED = {
  usage: {
    rolling: { status: 'ok', percent: 5, resetsAt: '2026-10-19T10:41:37.000Z' },
    weekly: { status: 'ok', percent: 2, resetsAt: '2026-10-26T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 47, resetsAt: '2026-10-22T07:03:14.000Z' },
  },
};

let keyPayload = GOOD;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes('/console/api/')) {
    upstreamCalls += 1;
    if (upstreamMode === 'fail' || upstreamMode === 'console-fail') {
      return new Response('nope', { status: 401 });
    }
    return new Response(JSON.stringify(CONSOLE_PAYLOAD), { status: 200 });
  }
  if (target.includes('opencode.ai')) {
    upstreamCalls += 1;
    if (upstreamMode === 'fail') {
      return new Response('nope', { status: 429 });
    }
    return new Response(JSON.stringify(keyPayload), { status: 200 });
  }
  return realFetch(url);
};

const worker = (await import('../deploy/cloudflare-worker/worker.js')).default;

const ENV = {
  OPENCODE_GO_API_KEY: 'oc_sk_test_test_test_test_test',
  ASSETS: { fetch: async () => new Response('<html>ui</html>', { status: 200 }) },
};

const call = (path, env = ENV, headers = {}) =>
  worker.fetch(new Request(`https://w.example.com${path}`, { headers }), env);

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ok  ${name}`);
};

// ---- static ----------------------------------------------------------------

{
  const res = await call('/index.html');
  ok('static asset served from public/', (await res.text()).includes('ui'));
}

// ---- usage -----------------------------------------------------------------

{
  cacheStore.clear();
  upstreamCalls = 0;
  const res = await call('/api/usage');
  const body = await res.json();
  ok('/api/usage returns 200', res.status === 200);
  ok('rolling parsed', body.usage.rolling.percent === 12);
  ok('weekly parsed', body.usage.weekly.percent === 40);
  ok('monthly parsed', body.usage.monthly.percent === 91);
  ok('worstPercent = max window', body.worstPercent === 91);
  ok('hasKey true', body.hasKey === true);
  ok('has ISO fetchedAt', !Number.isNaN(Date.parse(body.fetchedAt)));
  ok('not stale on success', body.stale === false);
  ok('one upstream call', upstreamCalls === 1);

  await call('/api/usage');
  ok('second request served from edge cache (no extra upstream call)', upstreamCalls === 1);
}

// ---- forced refresh + abuse floor ------------------------------------------

{
  // Within the floor a forced refresh is served from cache...
  await call('/api/refresh');
  ok('refresh within the 5s floor does not hit upstream', upstreamCalls === 1);

  // ...past it, refresh does go upstream.
  const older = {
    usage: GOOD.usage,
    fetchedAt: new Date(Date.now() - 10000).toISOString(),
    ageSeconds: 10,
    stale: false,
    error: null,
    errorCode: null,
    worstPercent: 91,
    hasKey: true,
    keySource: 'worker secret',
  };
  cacheStore.set(
    'https://opencode-go-widget.internal/__cache/fresh',
    new Response(JSON.stringify(older), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=15' },
    }),
  );
  await call('/api/refresh');
  ok('refresh past the floor hits upstream', upstreamCalls === 2);
}

// ---- stale fallback --------------------------------------------------------

{
  // Simulate the fresh entry expiring while last-good survives.
  cacheStore.delete('https://opencode-go-widget.internal/__cache/fresh');
  upstreamMode = 'fail';
  const body = await (await call('/api/usage')).json();
  ok('keeps last good numbers when upstream fails', body.usage.monthly.percent === 91);
  ok('flags the data stale', body.stale === true);
  ok('surfaces the error', body.errorCode === 'http-429');
  upstreamMode = 'ok';
}

// ---- missing key -----------------------------------------------------------

{
  cacheStore.clear();
  const body = await (await call('/api/usage', { ...ENV, OPENCODE_GO_API_KEY: '' })).json();
  ok('no key -> nulls, not a fake zero', body.usage === null && body.errorCode === 'no-key');
}

// ---- auth ------------------------------------------------------------------

{
  const secured = { ...ENV, AUTH_TOKEN: 'hunter2' };
  const noTok = await call('/api/usage', secured);
  ok('rejects missing token with 401', noTok.status === 401);
  ok(
    'accepts header token',
    (await call('/api/usage', secured, { 'x-auth-token': 'hunter2' })).status === 200,
  );
  ok('accepts query token', (await call('/api/usage?token=hunter2', secured)).status === 200);
  ok('rejects wrong token', (await call('/api/usage', secured, { 'x-auth-token': 'x' })).status === 401);
}

// ---- served age is real, not hardcoded --------------------------------

{
  const thirtyAgo = new Date(Date.now() - 30000).toISOString();
  const stale = {
    usage: GOOD.usage,
    fetchedAt: thirtyAgo,
    ageSeconds: 0, // what the old code always claimed
    stale: false,
    error: null,
    errorCode: null,
    worstPercent: 91,
    hasKey: true,
    keySource: 'worker secret',
  };
  cacheStore.set(
    'https://opencode-go-widget.internal/__cache/fresh',
    new Response(JSON.stringify(stale), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=15' },
    }),
  );
  upstreamCalls = 0;
  const body = await (await call('/api/usage')).json();
  ok('cache hit reports the true data age', body.ageSeconds >= 30);
  ok('cache hit still avoids a redundant upstream call', upstreamCalls === 0);
  cacheStore.clear();
}

// ---- console-accurate mode -------------------------------------------------

{
  const CONSOLE_ENV = {
    ...ENV,
    OPENCODE_CONSOLE_TOKEN: 'oauth-token',
    OPENCODE_ORG_ID: 'wrk_test0000000000000000000000',
  };

  cacheStore.clear();
  upstreamMode = 'ok';
  const res = await call('/api/usage', CONSOLE_ENV);
  const body = await res.json();

  ok('console mode reports source=console', body.source === 'console');
  ok('rolling matches the console (round, not floor): 6', body.usage.rolling.percent === 6);
  ok('weekly matches the console: 2', body.usage.weekly.percent === 2);
  ok('monthly matches the console: 48', body.usage.monthly.percent === 48);
  ok('exposes exact dollars', Math.abs(body.exact.rolling.used - 0.7003) < 1e-9);
  ok('exposes exact limit', body.exact.rolling.limit === 12);
  ok('exposes the exact percent', body.exact.rolling.percent === 5.84);
  ok('no fallback note when the console works', body.note === null);

  // The key-only path must still floor, which is exactly the console mismatch.
  cacheStore.clear();
  keyPayload = KEY_FLOORED;
  const keyOnly = await (await call('/api/usage', ENV)).json();
  ok('key mode floors (the original mismatch): 5/2/47',
    keyOnly.usage.rolling.percent === 5 &&
      keyOnly.usage.weekly.percent === 2 &&
      keyOnly.usage.monthly.percent === 47);
  ok('key mode reports source=key', keyOnly.source === 'key');
  ok('console mode and key mode differ by the expected 1 point on rolling/monthly',
    body.usage.rolling.percent - keyOnly.usage.rolling.percent === 1 &&
      body.usage.monthly.percent - keyOnly.usage.monthly.percent === 1);
  ok('weekly is equal in both (would have been 3 with ceil — proving round, not ceil)',
    body.usage.weekly.percent === keyOnly.usage.weekly.percent);

  // An expired/rejected console session must degrade, not fail.
  cacheStore.clear();
  keyPayload = GOOD;
  upstreamMode = 'console-fail';
  const degraded = await (await call('/api/usage', CONSOLE_ENV)).json();
  ok('rejected console session falls back to the key API', degraded.source === 'key');
  ok('fallback still returns data', degraded.usage && degraded.usage.rolling.percent === 12);
  ok('fallback is explained in a note',
    typeof degraded.note === 'string' && degraded.note.includes('Console session'));
  upstreamMode = 'ok';
  cacheStore.clear();
}

// ---- misc ------------------------------------------------------------------

{
  const health = await (await call('/api/health')).json();
  ok('/api/health ok', health.ok === true && health.hasKey === true);
  const cfg = await (await call('/api/config')).json();
  ok('/api/config exposes refresh + auth flag', cfg.clientRefreshSeconds === 30);
  ok('unknown api route -> 404', (await call('/api/nope')).status === 404);
}

console.log(`\n  ${passed} assertions passed\n`);
