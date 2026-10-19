'use strict';

/**
 * OpenCode Go usage widget — client.
 * Vanilla JS, no build step, no dependencies.
 */

const WINDOWS = [
  { key: 'rolling', name: 'Rolling', tag: '5h' },
  { key: 'weekly', name: 'Weekly', tag: '7d' },
  { key: 'monthly', name: 'Monthly', tag: 'cycle' },
];

const TOKEN_KEY = 'ocw_token';

const el = {
  body: document.body,
  app: document.getElementById('app'),
  dot: document.getElementById('statusDot'),
  subtitle: document.getElementById('subtitle'),
  worstNum: document.getElementById('worstNum'),
  refreshBtn: document.getElementById('refreshBtn'),
  banner: document.getElementById('banner'),
  cards: document.getElementById('cards'),
  updated: document.getElementById('updated'),
  autorefresh: document.getElementById('autorefresh'),
  authPanel: document.getElementById('authPanel'),
  authForm: document.getElementById('authForm'),
  authInput: document.getElementById('authInput'),
};

const state = {
  token: '',
  clientRefreshSeconds: 30,
  data: null,
  resetsAt: {}, // key -> epoch ms
  refreshTimer: null,
  tickTimer: null,
  loading: false,
};

// ---------------------------------------------------------------------------
// Token handling
// ---------------------------------------------------------------------------

function captureToken() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete('token');
    history.replaceState({}, '', url.pathname + (url.search ? url.search : '') + url.hash);
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_KEY) || '';
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function authHeaders() {
  return state.token ? { 'X-Auth-Token': state.token } : {};
}

async function api(path) {
  const res = await fetch(path, { headers: authHeaders(), cache: 'no-store' });
  if (res.status === 401) {
    const err = new Error('unauthorized');
    err.code = 'unauthorized';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.code = `http-${res.status}`;
    throw err;
  }
  return res.json();
}

async function load({ force = false, spin = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (spin) el.refreshBtn.classList.add('spinning');

  try {
    const data = await api(force ? '/api/refresh' : '/api/usage');
    state.data = data;
    el.authPanel.hidden = true;
    render();
  } catch (err) {
    if (err.code === 'unauthorized') {
      el.authPanel.hidden = false;
      el.subtitle.textContent = 'Locked';
      showBanner('Enter the access token to continue.', 'error');
    } else {
      showBanner(`Could not reach the widget server (${err.message}).`, 'error');
      el.dot.dataset.sev = 'error';
      el.subtitle.textContent = 'Offline';
    }
  } finally {
    state.loading = false;
    el.refreshBtn.classList.remove('spinning');
  }
}

async function loadConfig() {
  try {
    const cfg = await api('/api/config');
    if (cfg.clientRefreshSeconds) state.clientRefreshSeconds = cfg.clientRefreshSeconds;
    el.autorefresh.textContent = `auto ${state.clientRefreshSeconds}s`;
  } catch {
    /* defaults are fine */
  }
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => load(), state.clientRefreshSeconds * 1000);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function sevFor(percent, status) {
  if (status && status !== 'ok' && status !== 'unknown') return 'critical';
  if (percent >= 90) return 'critical';
  if (percent >= 70) return 'warn';
  return 'ok';
}

function cardMarkup(win, data) {
  const w = data && data.usage ? data.usage[win.key] : null;
  const percent = w ? w.percent : 0;
  const status = w ? w.status : 'unknown';
  const limited = status !== 'ok' && status !== 'unknown';
  const e = data && data.exact ? data.exact[win.key] : null;

  return `
    <article class="card${w ? '' : ' skeleton'}" data-win="${win.key}" data-state="${limited ? 'limited' : 'ok'}">
      ${limited ? '<span class="pill-limited">limited</span>' : ''}
      <div class="card-top">
        <div class="card-name">
          <h2>${win.name}</h2>
          <span class="win">${win.tag}</span>
        </div>
        <span class="card-pct" data-sev="${sevFor(percent, status)}">${w ? `${percent}%` : '–'}</span>
      </div>
      <div class="bar"><div class="bar-fill" data-sev="${sevFor(percent, status)}" style="width:${w ? percent : 0}%"></div></div>
      <div class="card-meta">
        <span class="reset">resets in <b data-reset-key="${win.key}">–</b></span>
        <span class="abs" data-abs-key="${win.key}">–</span>
      </div>
      ${e ? `<div class="exact">$${e.used.toFixed(2)} of $${e.limit.toFixed(2)} &middot; ${e.percent}% exact</div>` : ''}
    </article>`;
}

function render() {
  const data = state.data || {};
  el.app.setAttribute('aria-busy', 'false');

  el.cards.innerHTML = WINDOWS.map((win) => cardMarkup(win, data)).join('');

  state.resetsAt = {};
  for (const win of WINDOWS) {
    const w = data.usage ? data.usage[win.key] : null;
    if (w && w.resetsAt) state.resetsAt[win.key] = Date.parse(w.resetsAt);
  }

  const worst = data.worstPercent != null ? Math.round(data.worstPercent) : null;
  el.worstNum.textContent = worst != null ? `${worst}%` : '–';
  el.dot.dataset.sev = data.error && !data.usage ? 'error' : sevFor(worst ?? 0, 'ok');
  document.title = worst != null ? `Go ${worst}% · Usage` : 'OpenCode Go Usage';

  if (data.error) {
    showBanner(
      data.stale
        ? `Showing last known data — ${data.error}`
        : data.error,
      data.stale ? 'stale' : 'error',
    );
  } else if (data.note) {
    showBanner(data.note, 'stale');
  } else if (!data.hasKey) {
    showBanner('No API key found. Set OPENCODE_GO_API_KEY or add one to config.json.', 'error');
  } else {
    hideBanner();
  }

  el.subtitle.textContent = data.source === 'console'
    ? 'console-accurate'
    : data.hasKey
      ? 'api key · rounds down'
      : 'no key configured';

  tick();
}

function showBanner(text, kind) {
  el.banner.textContent = text;
  el.banner.dataset.kind = kind;
  el.banner.hidden = false;
}
function hideBanner() {
  el.banner.hidden = true;
}

// ---------------------------------------------------------------------------
// Live countdown
// ---------------------------------------------------------------------------

function humanize(ms) {
  if (!Number.isFinite(ms)) return '–';
  if (ms <= 0) return 'now';
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  const seconds = Math.floor((ms % 60000) / 1000);
  if (totalMinutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function tick() {
  const now = Date.now();
  for (const [key, epoch] of Object.entries(state.resetsAt)) {
    const rel = document.querySelector(`[data-reset-key="${key}"]`);
    if (rel) rel.textContent = humanize(epoch - now);
    const abs = document.querySelector(`[data-abs-key="${key}"]`);
    if (abs) {
      abs.textContent = new Date(epoch).toLocaleString(undefined, {
        weekday: 'short', hour: '2-digit', minute: '2-digit',
      });
    }
  }

  if (state.data && state.data.fetchedAt) {
    const age = Math.max(0, Math.round((now - Date.parse(state.data.fetchedAt)) / 1000));
    el.updated.textContent = age < 5 ? 'updated just now' : `updated ${humanize(age * 1000)} ago`;
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

el.refreshBtn.addEventListener('click', () => load({ force: true, spin: true }));

el.authForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = el.authInput.value.trim();
  if (!value) return;
  state.token = value;
  localStorage.setItem(TOKEN_KEY, value);
  el.authInput.value = '';
  load({ force: true, spin: true });
});

// Refresh immediately when the phone screen wakes / tab refocuses.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.data) load();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  state.token = captureToken();
  state.tickTimer = setInterval(tick, 1000);
  await loadConfig();
  await load();
}

boot();
