'use strict';

/**
 * OpenCode Go usage — shared library.
 *
 * Resolves your OpenCode Go API key from every place opencode already keeps it,
 * then reads the (unofficial but official-ish) usage endpoint that the OpenCode
 * console is built on:
 *
 *   GET https://opencode.ai/zen/go/v1/usage      Authorization: Bearer <key>
 *   -> { usage: { rolling:{percent,resetsAt}, weekly:{...}, monthly:{...} } }
 *
 * Zero dependencies: Node built-ins only.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileP = promisify(execFile);

const DEFAULT_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage';
const CONSOLE_ENDPOINT = 'https://opencode.ai/console/api/go/status';

// Cloudflare blocks clients that don't look like a browser.
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function homeDir() {
  return os.homedir();
}

function xdgConfigDir() {
  return process.env.XDG_CONFIG_HOME || path.join(homeDir(), '.config');
}

function xdgDataDir() {
  return process.env.XDG_DATA_HOME || path.join(homeDir(), '.local', 'share');
}

/** All the locations opencode uses for its data directory, most specific first. */
function opencodeDataDirs() {
  const dirs = [];
  if (process.env.OPENCODE_DATA_DIR) dirs.push(process.env.OPENCODE_DATA_DIR);
  dirs.push(path.join(xdgDataDir(), 'opencode'));
  dirs.push(path.join(homeDir(), '.opencode'));
  return [...new Set(dirs)];
}

function authJsonPaths() {
  const files = [];
  for (const dir of opencodeDataDirs()) files.push(path.join(dir, 'auth.json'));
  files.push(path.join(xdgConfigDir(), 'opencode', 'auth.json'));
  return [...new Set(files)];
}

function opencodeDbPaths() {
  return opencodeDataDirs().map((dir) => path.join(dir, 'opencode.db'));
}

/** Config file locations, lowest precedence last. */
function configPaths(projectDir) {
  const files = [];
  if (projectDir) files.push(path.join(projectDir, 'config.json'));
  files.push(path.join(xdgConfigDir(), 'opencode-widget', 'config.json'));
  return files;
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

const KEY_ENV_VARS = [
  'OPENCODE_GO_API_KEY',
  'OPENCODE_ZEN_API_KEY',
  'OPENCODE_API_KEY',
  'OCG_API_KEY',
];

function looksLikeKey(value) {
  return typeof value === 'string' && /^(oc_sk_|oc_|sk-)[A-Za-z0-9._-]{8,}$/.test(value.trim());
}

function fromEnv() {
  for (const name of KEY_ENV_VARS) {
    const value = process.env[name];
    if (looksLikeKey(value)) return { key: value.trim(), source: `env:${name}` };
  }
  return null;
}

function fromAuthJson() {
  for (const file of authJsonPaths()) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    // Prefer the Go/Zen providers, then anything else that is a plain api_key.
    const preferred = ['opencode-go', 'opencode-zen', 'opencode'];
    const order = [
      ...preferred.filter((k) => data[k]),
      ...Object.keys(data).filter((k) => !preferred.includes(k)),
    ];
    for (const name of order) {
      const entry = data[name];
      if (entry && typeof entry === 'object' && entry.type === 'api_key' && entry.key) {
        return { key: String(entry.key).trim(), source: `${file}#${name}` };
      }
    }
  }
  return null;
}

/**
 * opencode v2 keeps credentials in a SQLite database rather than auth.json.
 * The active OpenCode Console credential holds the `oc_sk_...` key.
 */
async function fromOpencodeDb() {
  const dbPath = opencodeDbPaths().find((p) => fs.existsSync(p));
  if (!dbPath) return null;

  const rows = await readCredentialRows(dbPath);
  for (const { label, value, active } of rows) {
    if (!active) continue;
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    if (parsed && parsed.type && String(parsed.type).startsWith('key') && parsed.key) {
      return { key: String(parsed.key).trim(), source: `${dbPath}#credential(${label})` };
    }
  }
  return null;
}

/** Run fn while muting Node's "SQLite is experimental" warning. */
function withoutSqliteWarning(fn) {
  const original = process.emitWarning;
  process.emitWarning = function filtered(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    if (/SQLite is an experimental feature/i.test(text)) return undefined;
    return original.call(process, warning, ...rest);
  };
  try {
    return fn();
  } finally {
    process.emitWarning = original;
  }
}

async function readCredentialRows(dbPath) {
  // Preferred: Node's built-in SQLite (Node >= 22.5).
  try {
    return withoutSqliteWarning(() => {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const stmt = db.prepare(
          'SELECT label, value, active FROM credential ORDER BY active DESC, time_updated DESC',
        );
        return stmt.all().map((r) => ({
          label: r.label || 'credential',
          value: r.value,
          active: Number(r.active) === 1,
        }));
      } finally {
        db.close();
      }
    });
  } catch {
    // Fall through to python3.
  }

  // Fallback: python3 ships with virtually every Linux/macOS box.
  try {
    const script = [
      'import sqlite3, json, sys',
      `c = sqlite3.connect(${JSON.stringify('file:' + dbPath + '?mode=ro')}, uri=True)`,
      'out = []',
      'for label, value, active in c.execute(',
      "  'SELECT label, value, active FROM credential ORDER BY active DESC, time_updated DESC'",
      '):',
      "  out.append({'label': label or 'credential', 'value': value, 'active': int(active) == 1})",
      'print(json.dumps(out))',
    ].join('\n');
    const { stdout } = await execFileP('python3', ['-c', script], { timeout: 8000 });
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

function fromKeyFile(projectDir) {
  const candidates = [
    projectDir && path.join(projectDir, 'key'),
    path.join(xdgConfigDir(), 'opencode-widget', 'key'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (looksLikeKey(value)) return { key: value, source: file };
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * @returns {Promise<{key: string|null, source: string|null}>}
 */
async function resolveApiKey(config = {}, projectDir) {
  if (looksLikeKey(config.apiKey)) {
    return { key: config.apiKey.trim(), source: 'config' };
  }
  return (
    fromEnv() ||
    fromKeyFile(projectDir) ||
    fromAuthJson() ||
    (await fromOpencodeDb()) || { key: null, source: null }
  );
}

// ---------------------------------------------------------------------------
// Parsing / fetching
// ---------------------------------------------------------------------------

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function parseWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const resetsAt = raw.resetsAt ? new Date(raw.resetsAt) : null;
  return {
    status: typeof raw.status === 'string' ? raw.status : 'unknown',
    percent: clampPercent(raw.percent),
    resetsAt: resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt.toISOString() : null,
  };
}

function parseUsagePayload(payload) {
  const usage = payload && payload.usage ? payload.usage : payload;
  if (!usage || typeof usage !== 'object') throw new Error('Unexpected usage payload');
  return {
    rolling: parseWindow(usage.rolling),
    weekly: parseWindow(usage.weekly),
    monthly: parseWindow(usage.monthly),
  };
}

class UsageError extends Error {
  constructor(message, { status = 0, code = 'error' } = {}) {
    super(message);
    this.name = 'UsageError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Fetch one fresh snapshot from the usage endpoint.
 * Never leaks the key or the response body into thrown errors.
 */
async function fetchUsage({ apiKey, endpoint = DEFAULT_ENDPOINT, timeoutMs = 15000 } = {}) {
  if (!apiKey) throw new UsageError('No OpenCode Go API key configured', { code: 'no-key' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new UsageError('Request timed out', { code: 'timeout' });
    }
    throw new UsageError('Network error reaching opencode.ai', { code: 'network' });
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
    const message =
      map[response.status] ||
      (response.status >= 500
        ? `OpenCode service unavailable (${response.status})`
        : `Usage request failed (${response.status})`);
    throw new UsageError(message, { status: response.status, code: `http-${response.status}` });
  }

  let json;
  try {
    json = await response.json();
  } catch {
    throw new UsageError('Usage response was not valid JSON', { code: 'schema' });
  }
  try {
    return parseUsagePayload(json);
  } catch {
    throw new UsageError('Usage response schema did not match', { code: 'schema' });
  }
}

// ---------------------------------------------------------------------------
// Console-accurate source
//
// The key-based endpoint above returns whole percents and FLOORS them, while
// the web console computes from exact micro-cent amounts and ROUNDS. That is
// the whole reason the widget can sit a point below the console.
//
// The console's own endpoint exposes the exact numbers, so we can reproduce
// its arithmetic exactly: percent = round(used / limit * 100).
// ---------------------------------------------------------------------------

/** Parse a /console/api/go/status payload into the shared usage shape. */
function parseConsoleMeters(payload) {
  const access = payload && payload.access;
  const meters = access && access.meters;
  if (!meters || typeof meters !== 'object') {
    throw new Error('Console response is missing access.meters');
  }

  const windowKeys = { rolling: 'fiveHour', weekly: 'week', monthly: 'month' };
  const usage = {};
  const exact = {};

  for (const [name, meterKey] of Object.entries(windowKeys)) {
    const meter = meters[meterKey];
    if (!meter) {
      usage[name] = null;
      continue;
    }
    const used = Number(meter.usedMicroCents);
    const limit = Number(meter.limitMicroCents);
    const percent = limit > 0 ? (used / limit) * 100 : 0;

    usage[name] = {
      status: 'ok',
      // Exactly what the console displays.
      percent: Math.round(percent),
      resetsAt: meter.resetsAt ? new Date(meter.resetsAt).toISOString() : null,
    };
    exact[name] = {
      percent: Math.round(percent * 100) / 100,
      used: used / 1e8, // micro-cents -> dollars
      limit: limit / 1e8,
      currency: 'USD',
    };
  }

  return { usage, exact, periodEndsAt: access.endsAt || null };
}

/**
 * Find an OAuth console session: the same bearer token the opencode CLI uses
 * to talk to the console. It lives in opencode.db alongside the API key.
 */
async function resolveConsoleAuth(config = {}, projectDir) {
  if (config.consoleToken && config.consoleOrgId) {
    return { token: config.consoleToken, orgId: config.consoleOrgId, source: 'config' };
  }
  if (process.env.OPENCODE_CONSOLE_TOKEN && process.env.OPENCODE_ORG_ID) {
    return {
      token: process.env.OPENCODE_CONSOLE_TOKEN,
      orgId: process.env.OPENCODE_ORG_ID,
      source: 'env',
    };
  }

  const dbPath = opencodeDbPaths().find((p) => fs.existsSync(p));
  if (!dbPath) return null;

  const rows = await readCredentialRows(dbPath);
  const now = Date.now();
  for (const { value } of rows) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    const meta = parsed && parsed.metadata;
    if (!meta || !meta.orgID || !parsed.access) continue;
    if (parsed.expires && Number(parsed.expires) < now) continue; // expired
    return { token: String(parsed.access), orgId: String(meta.orgID), source: `${dbPath}#oauth` };
  }
  return null;
}

async function fetchConsoleUsage({
  token,
  orgId,
  endpoint = CONSOLE_ENDPOINT,
  timeoutMs = 15000,
} = {}) {
  if (!token || !orgId) {
    throw new UsageError('No console session available', { code: 'console-auth' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-org-id': orgId,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new UsageError('Console request timed out', { code: 'timeout' });
    }
    throw new UsageError('Network error reaching the console', { code: 'network' });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const message =
      response.status === 401 || response.status === 403
        ? `Console session rejected (${response.status}) — run opencode to refresh it`
        : `Console request failed (${response.status})`;
    throw new UsageError(message, {
      status: response.status,
      code: response.status === 401 || response.status === 403 ? 'console-auth' : `http-${response.status}`,
    });
  }

  let json;
  try {
    json = await response.json();
  } catch {
    throw new UsageError('Console response was not valid JSON', { code: 'schema' });
  }
  try {
    return parseConsoleMeters(json);
  } catch {
    throw new UsageError('Console response schema did not match', { code: 'schema' });
  }
}

/**
 * Preferred entry point: use the console session (exact, matches the web
 * console) when one is available, otherwise fall back to the API key.
 *
 * @returns {Promise<{usage, exact, periodEndsAt, source, sourceDetail, note}>}
 */
async function fetchUsageSmart({ config = {}, projectDir, preferConsole = true } = {}) {
  if (preferConsole && config.preferConsole !== false) {
    const auth = await resolveConsoleAuth(config, projectDir);
    if (auth) {
      try {
        const result = await fetchConsoleUsage({
          token: auth.token,
          orgId: auth.orgId,
          endpoint: config.consoleEndpoint || CONSOLE_ENDPOINT,
          timeoutMs: config.requestTimeoutMs,
        });
        return { ...result, source: 'console', sourceDetail: auth.source, note: null };
      } catch (err) {
        const fallback = await fetchKeyUsage({ config, projectDir });
        return {
          ...fallback,
          note: `Console session unavailable (${err.message}); showing API-percent values, which round down.`,
        };
      }
    }
  }
  return fetchKeyUsage({ config, projectDir });
}

async function fetchKeyUsage({ config = {}, projectDir } = {}) {
  const { key, source } = await resolveApiKey(config, projectDir);
  const usage = await fetchUsage({
    apiKey: key,
    endpoint: config.endpoint || DEFAULT_ENDPOINT,
    timeoutMs: config.requestTimeoutMs,
  });
  return { usage, exact: null, periodEndsAt: null, source: 'key', sourceDetail: source, note: null };
}

// ---------------------------------------------------------------------------
// Formatting helpers (shared by CLI)
// ---------------------------------------------------------------------------

function formatCountdown(iso, now = Date.now()) {
  if (!iso) return '—';
  let ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'now';
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatBar(percent, width = 20) {
  const filled = Math.round((clampPercent(percent) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function severityFor(percent) {
  if (percent >= 90) return 'critical';
  if (percent >= 70) return 'warn';
  return 'ok';
}

/** Highest usage across present windows. */
function worstPercent(usage) {
  const values = ['rolling', 'weekly', 'monthly']
    .map((name) => (usage[name] ? usage[name].percent : null))
    .filter((n) => n !== null);
  return values.length ? Math.max(...values) : 0;
}

module.exports = {
  CONSOLE_ENDPOINT,
  DEFAULT_ENDPOINT,
  KEY_ENV_VARS,
  UsageError,
  configPaths,
  fetchConsoleUsage,
  fetchUsage,
  fetchUsageSmart,
  formatBar,
  formatCountdown,
  opencodeDataDirs,
  parseConsoleMeters,
  parseUsagePayload,
  resolveApiKey,
  resolveConsoleAuth,
  severityFor,
  worstPercent,
};
