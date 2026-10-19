/**
 * OpenCode Go usage widget — Cloudflare Worker edition.
 *
 * Serves the same static UI from ../../public and answers /api/* at the edge.
 * No server to keep running: deploy once, view from any device, forever.
 *
 * Secrets:
 *   npx wrangler secret put OPENCODE_GO_API_KEY   # required (oc_sk_...)
 *   npx wrangler secret put AUTH_TOKEN            # optional shared secret
 */

const ENDPOINT = 'https://opencode.ai/zen/go/v1/usage';

// Keep this short. The cache exists only to collapse bursts from several
// devices polling at once — NOT to save upstream load. Cloudflare's Cache API
// is per-colo, so a long TTL makes different requests serve different ages and
// the number can visibly trail (or jump back behind) the web console.
const FRESH_TTL = 15; // seconds
const LAST_GOOD_TTL = 86400;

const WINDOWS = ['rolling', 'weekly', 'monthly'];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const left = enc.encode(String(a));
  const right = enc.encode(String(b));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function authorized(request, url, env) {
  if (!env.AUTH_TOKEN) return true;
  const header = request.headers.get('x-auth-token');
  const query = url.searchParams.get('token');
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return [header, query, bearer].some((v) => v && constantTimeEqual(v, env.AUTH_TOKEN));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function parseWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const resets = raw.resetsAt ? new Date(raw.resetsAt) : null;
  return {
    status: typeof raw.status === 'string' ? raw.status : 'unknown',
    percent: clampPercent(raw.percent),
    resetsAt: resets && !Number.isNaN(resets.getTime()) ? resets.toISOString() : null,
  };
}

function parseUsage(payload) {
  const usage = payload && payload.usage ? payload.usage : payload;
  if (!usage || typeof usage !== 'object') throw new Error('schema');
  const out = {};
  for (const name of WINDOWS) out[name] = parseWindow(usage[name]);
  return out;
}

function worstPercent(usage) {
  const values = WINDOWS.map((n) => (usage && usage[n] ? usage[n].percent : null)).filter(
    (n) => n !== null,
  );
  return values.length ? Math.max(...values) : 0;
}

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

function cacheKey(kind) {
  return new Request(`https://opencode-go-widget.internal/__cache/${kind}`, { method: 'GET' });
}

async function readCache(kind) {
  try {
    const hit = await caches.default.match(cacheKey(kind));
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

async function writeCache(kind, ttl, body) {
  try {
    await caches.default.put(
      cacheKey(kind),
      new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
      }),
    );
  } catch {
    /* cache is best-effort */
  }
}

// ---------------------------------------------------------------------------
// upstream
// ---------------------------------------------------------------------------

async function fetchUsage(env) {
  if (!env.OPENCODE_GO_API_KEY) {
    const err = new Error('No OpenCode Go API key configured');
    err.code = 'no-key';
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(ENDPOINT, {
      headers: { Authorization: `Bearer ${env.OPENCODE_GO_API_KEY}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch {
    const err = new Error('Network error reaching opencode.ai');
    err.code = 'network';
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const map = {
      401: 'API key rejected (401)',
      403: 'Access denied (403) — no active Go plan on this key?',
      404: 'Usage endpoint not found (404)',
      429: 'Rate limited (429) — slow down polling',
    };
    const err = new Error(
      map[response.status] ||
        (response.status >= 500
          ? `OpenCode service unavailable (${response.status})`
          : `Usage request failed (${response.status})`),
    );
    err.code = `http-${response.status}`;
    throw err;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    const err = new Error('Usage response was not valid JSON');
    err.code = 'schema';
    throw err;
  }
  try {
    return parseUsage(payload);
  } catch {
    const err = new Error('Usage response schema did not match');
    err.code = 'schema';
    throw err;
  }
}

function withAge(body) {
  const fetched = body && body.fetchedAt ? Date.parse(body.fetchedAt) : NaN;
  return {
    ...body,
    // Never claim "0 seconds old" for a cached body — report the real age.
    ageSeconds: Number.isNaN(fetched) ? null : Math.max(0, Math.round((Date.now() - fetched) / 1000)),
  };
}

async function getSnapshot(env, { force = false } = {}) {
  if (!force) {
    const fresh = await readCache('fresh');
    if (fresh) return withAge(fresh);
  }

  try {
    const usage = await fetchUsage(env);
    const body = {
      usage,
      fetchedAt: new Date().toISOString(),
      ageSeconds: 0,
      stale: false,
      error: null,
      errorCode: null,
      worstPercent: worstPercent(usage),
      hasKey: Boolean(env.OPENCODE_GO_API_KEY),
      keySource: 'worker secret',
    };
    await writeCache('fresh', FRESH_TTL, body);
    await writeCache('lastgood', LAST_GOOD_TTL, body);
    return body;
  } catch (err) {
    const lastGood = await readCache('lastgood');
    if (lastGood) {
      return {
        ...lastGood,
        stale: true,
        error: err.message,
        errorCode: err.code || 'error',
        hasKey: Boolean(env.OPENCODE_GO_API_KEY),
      };
    }
    return {
      usage: null,
      fetchedAt: null,
      ageSeconds: null,
      stale: false,
      error: err.message,
      errorCode: err.code || 'error',
      worstPercent: null,
      hasKey: Boolean(env.OPENCODE_GO_API_KEY),
      keySource: 'worker secret',
    };
  }
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      // Static UI, manifest and icon come from Workers Static Assets.
      return env.ASSETS.fetch(request);
    }

    if (!authorized(request, url, env)) return json({ error: 'Unauthorized' }, 401);

    switch (url.pathname) {
      case '/api/health':
        return json({
          ok: true,
          version: '1.0.0',
          hasKey: Boolean(env.OPENCODE_GO_API_KEY),
          keySource: 'worker secret',
        });

      case '/api/config':
        return json({
          version: '1.0.0',
          clientRefreshSeconds: Number(env.CLIENT_REFRESH_SECONDS) || 30,
          cacheSeconds: FRESH_TTL,
          authRequired: Boolean(env.AUTH_TOKEN),
        });

      case '/api/usage':
        return json(await getSnapshot(env));

      case '/api/refresh':
        return json(await getSnapshot(env, { force: true }));

      default:
        return json({ error: 'Unknown endpoint' }, 404);
    }
  },
};
