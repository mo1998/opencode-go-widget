#!/usr/bin/env node
'use strict';

/**
 * OpenCode Go usage widget — self-hosted web server.
 *
 * Serves a responsive page plus a small JSON API:
 *   GET  /api/usage     -> cached snapshot (rolling / weekly / monthly + resets)
 *   GET  /api/refresh   -> force a fresh upstream fetch
 *   GET  /api/health    -> liveness + whether a key was found
 *   GET  /api/config    -> non-secret client config
 *
 * Binds to 0.0.0.0 by default so your Windows browser, a phone on the LAN,
 * and anything over SSH port-forward can all reach it.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const {
  DEFAULT_ENDPOINT,
  UsageError,
  configPaths,
  fetchUsage,
  resolveApiKey,
  worstPercent,
} = require('./lib/usage');

const VERSION = '1.0.0';
const PROJECT_DIR = __dirname;
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8787,
  // Deliberately short: a long cache makes the widget trail the web console,
  // which reads the same meters at full precision. One user polling a 3-table
  // join every 20s is nothing.
  cacheSeconds: 20,
  clientRefreshSeconds: 30,
  requestTimeoutMs: 15000,
  endpoint: DEFAULT_ENDPOINT,
  authToken: '',
  apiKey: '',
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function loadConfig() {
  const config = { ...DEFAULTS };
  for (const file of configPaths(PROJECT_DIR)) {
    try {
      Object.assign(config, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[config] ignoring ${file}: ${err.message}`);
      }
    }
  }

  // Environment overrides.
  const envMap = {
    WIDGET_HOST: 'host',
    WIDGET_PORT: 'port',
    WIDGET_TOKEN: 'authToken',
    WIDGET_CACHE_SECONDS: 'cacheSeconds',
    WIDGET_CLIENT_REFRESH_SECONDS: 'clientRefreshSeconds',
    WIDGET_ENDPOINT: 'endpoint',
  };
  for (const [envName, key] of Object.entries(envMap)) {
    if (process.env[envName] != null && process.env[envName] !== '') {
      config[key] = process.env[envName];
    }
  }

  config.port = Number(config.port) || DEFAULTS.port;
  config.cacheSeconds = Math.max(5, Number(config.cacheSeconds) || DEFAULTS.cacheSeconds);
  config.clientRefreshSeconds = Math.max(
    5,
    Number(config.clientRefreshSeconds) || DEFAULTS.clientRefreshSeconds,
  );
  config.requestTimeoutMs = Math.max(
    1000,
    Number(config.requestTimeoutMs) || DEFAULTS.requestTimeoutMs,
  );

  // Simple CLI flags win over everything.
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) config.port = Number(argv[i + 1]);
    else if (arg === '--host' && argv[i + 1]) config.host = argv[i + 1];
    else if (arg === '--token' && argv[i + 1]) config.authToken = argv[i + 1];
  }

  return config;
}

const CONFIG = loadConfig();
let API_KEY = { key: null, source: null };

// ---------------------------------------------------------------------------
// Snapshot cache
// ---------------------------------------------------------------------------

const snapshot = {
  usage: null,
  fetchedAt: 0,
  stale: false,
  error: null,
  errorCode: null,
};

let inflight = null;

function snapshotAge() {
  return Date.now() - snapshot.fetchedAt;
}

function isFresh() {
  return snapshot.fetchedAt > 0 && snapshotAge() < CONFIG.cacheSeconds * 1000;
}

async function refresh({ force = false } = {}) {
  if (!API_KEY.key) {
    API_KEY = await resolveApiKey(CONFIG, PROJECT_DIR);
  }

  if (!force && isFresh()) return publicSnapshot();

  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const usage = await fetchUsage({
        apiKey: API_KEY.key,
        endpoint: CONFIG.endpoint,
        timeoutMs: CONFIG.requestTimeoutMs,
      });
      snapshot.usage = usage;
      snapshot.fetchedAt = Date.now();
      snapshot.stale = false;
      snapshot.error = null;
      snapshot.errorCode = null;
    } catch (err) {
      const known = err instanceof UsageError;
      snapshot.error = known ? err.message : 'Unexpected error';
      snapshot.errorCode = known ? err.code : 'error';
      // Keep showing the last good numbers, flagged stale.
      snapshot.stale = snapshot.usage != null;
    } finally {
      inflight = null;
    }
    return publicSnapshot();
  })();

  return inflight;
}

function publicSnapshot() {
  const usage = snapshot.usage;
  return {
    usage,
    fetchedAt: snapshot.fetchedAt ? new Date(snapshot.fetchedAt).toISOString() : null,
    ageSeconds: snapshot.fetchedAt ? Math.round(snapshotAge() / 1000) : null,
    stale: snapshot.stale,
    error: snapshot.error,
    errorCode: snapshot.errorCode,
    worstPercent: usage ? worstPercent(usage) : null,
    hasKey: Boolean(API_KEY.key),
    keySource: API_KEY.source || null,
  };
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, relPath) {
  const safe = path
    .normalize(relPath)
    .replace(/^(\.\.[/\\])+/, '')
    .replace(/^[/\\]+/, '');
  const full = path.join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');

  try {
    const data = await fsp.readFile(full);
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    send(res, 404, 'Not found');
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function isAuthorized(req, url) {
  if (!CONFIG.authToken) return true;
  const header = req.headers['x-auth-token'];
  const query = url.searchParams.get('token');
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return [header, query, bearer].some((value) => value && timingSafeEqual(value, CONFIG.authToken));
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  if (!isAuthorized(req, url)) return send(res, 401, { error: 'Unauthorized' });

  if (url.pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      version: VERSION,
      hasKey: Boolean(API_KEY.key),
      keySource: API_KEY.source || null,
      fetchedAt: snapshot.fetchedAt ? new Date(snapshot.fetchedAt).toISOString() : null,
    });
  }

  if (url.pathname === '/api/config') {
    return send(res, 200, {
      version: VERSION,
      clientRefreshSeconds: CONFIG.clientRefreshSeconds,
      cacheSeconds: CONFIG.cacheSeconds,
      authRequired: Boolean(CONFIG.authToken),
    });
  }

  if (url.pathname === '/api/usage') {
    const data = await refresh();
    return send(res, 200, data);
  }

  if (url.pathname === '/api/refresh') {
    const data = await refresh({ force: true });
    return send(res, 200, data);
  }

  return send(res, 404, { error: 'Unknown endpoint' });
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return send(res, 400, { error: 'Bad request' });
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error('[api]', err);
      send(res, 500, { error: 'Internal error' });
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return void serveStatic(res, 'index.html');
  }

  return void serveStatic(res, url.pathname.slice(1));
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function lanAddresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

async function main() {
  API_KEY = await resolveApiKey(CONFIG, PROJECT_DIR);

  const token = CONFIG.authToken ? `?token=${encodeURIComponent(CONFIG.authToken)}` : '';
  const shownHost = CONFIG.host === '0.0.0.0' ? 'localhost' : CONFIG.host;

  console.log(`\n  OpenCode Go usage widget  v${VERSION}`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  local     http://${shownHost}:${CONFIG.port}/${token}`);
  for (const addr of lanAddresses()) {
    console.log(`  network   http://${addr}:${CONFIG.port}/${token}`);
  }
  console.log(`  key       ${API_KEY.key ? `found (${API_KEY.source})` : 'NOT FOUND — set OPENCODE_GO_API_KEY or config.json'}`);
  console.log(`  cache     ${CONFIG.cacheSeconds}s server · ${CONFIG.clientRefreshSeconds}s page`);
  if (CONFIG.authToken) console.log(`  auth      token required (kept out of the URL after first load)`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  Ctrl-C to stop.\n`);

  // Warm the cache so the first page load is instant (non-fatal if it fails).
  refresh().catch(() => {});

  server.listen(CONFIG.port, CONFIG.host, () => {
    if (CONFIG.host === '0.0.0.0') {
      console.log(`  Listening on all interfaces (0.0.0.0:${CONFIG.port}).`);
    }
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${CONFIG.port} is already in use. Try: node server.js --port 8788`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { server, CONFIG };
