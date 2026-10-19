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

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes('opencode.ai')) {
    upstreamCalls += 1;
    if (upstreamMode === 'ok') {
      return new Response(JSON.stringify(GOOD), { status: 200 });
    }
    return new Response('nope', { status: 429 });
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

// ---- force refresh ---------------------------------------------------------

{
  await call('/api/refresh');
  ok('/api/refresh bypasses the cache', upstreamCalls === 2);
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

// ---- misc ------------------------------------------------------------------

{
  const health = await (await call('/api/health')).json();
  ok('/api/health ok', health.ok === true && health.hasKey === true);
  const cfg = await (await call('/api/config')).json();
  ok('/api/config exposes refresh + auth flag', cfg.clientRefreshSeconds === 30);
  ok('unknown api route -> 404', (await call('/api/nope')).status === 404);
}

console.log(`\n  ${passed} assertions passed\n`);
