#!/usr/bin/env node
'use strict';

/**
 * OpenCode Go usage — terminal client.
 *
 *   node cli.js            one-shot table
 *   node cli.js --json     raw JSON
 *   node cli.js --watch    live-refreshing table (Ctrl-C to quit)
 *   node cli.js --compact  single line (handy for tmux/status bars)
 *   node cli.js --source   show where the API key was found
 */

const {
  DEFAULT_ENDPOINT,
  UsageError,
  formatBar,
  formatCountdown,
  resolveApiKey,
  fetchUsage,
  worstPercent,
} = require('./lib/usage');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const PROJECT_DIR = __dirname;

const WINDOWS = [
  { key: 'rolling', name: 'Rolling 5h' },
  { key: 'weekly', name: 'Weekly  7d' },
  { key: 'monthly', name: 'Monthly 30d' },
];

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s),
};

function severity(percent, status) {
  if (status && status !== 'ok' && status !== 'unknown') return 'critical';
  if (percent >= 90) return 'critical';
  if (percent >= 70) return 'warn';
  return 'ok';
}

function colorize(sev, text) {
  if (sev === 'critical') return c.red(text);
  if (sev === 'warn') return c.yellow(text);
  return c.green(text);
}

function render(usage) {
  const lines = [];
  lines.push('');
  lines.push(`  ${c.bold('OpenCode Go usage')}`);
  lines.push('');
  for (const win of WINDOWS) {
    const w = usage[win.key];
    if (!w) {
      lines.push(`  ${win.name}  ${c.dim('not reported')}`);
      continue;
    }
    const pct = `${String(w.percent).padStart(3)}%`;
    const bar = formatBar(w.percent, 20);
    const reset = `resets in ${formatCountdown(w.resetsAt)}`;
    const limited = w.status !== 'ok' ? ` ${c.red('[limited]')}` : '';
    lines.push(
      `  ${win.name}  ${colorize(severity(w.percent, w.status), bar)} ` +
        `${c.bold(pct)}  ${c.dim(reset)}${limited}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function renderCompact(usage) {
  const parts = WINDOWS.map((win) => {
    const w = usage[win.key];
    if (!w) return null;
    const label = { rolling: '5h', weekly: 'wk', monthly: 'mo' }[win.key];
    return `${label} ${w.percent}%`;
  }).filter(Boolean);
  return `Go ${parts.join(' · ')}`;
}

async function once() {
  const { key, source } = await resolveApiKey({}, PROJECT_DIR);

  if (has('--source')) {
    console.log(key ? `key found: ${source}` : 'key: NOT FOUND');
    if (!key) return 1;
  }

  const usage = await fetchUsage({ apiKey: key, endpoint: DEFAULT_ENDPOINT });

  if (has('--json')) {
    console.log(JSON.stringify({ usage, worstPercent: worstPercent(usage), source }, null, 2));
  } else if (has('--compact')) {
    console.log(renderCompact(usage));
  } else {
    console.log(render(usage));
  }
  return 0;
}

async function watch() {
  const intervalMs = 30000;
  process.stdout.write('\x1b[?25l'); // hide cursor
  const cleanup = () => {
    process.stdout.write('\x1b[?25h\n'); // restore cursor
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  for (;;) {
    const { key } = await resolveApiKey({}, PROJECT_DIR);
    process.stdout.write('\x1b[2J\x1b[H');
    try {
      const usage = await fetchUsage({ apiKey: key, endpoint: DEFAULT_ENDPOINT });
      console.log(render(usage));
      console.log(`  ${c.dim(`updated ${new Date().toLocaleTimeString()} · refreshing every ${intervalMs / 1000}s · Ctrl-C to quit`)}`);
    } catch (err) {
      console.log(`  ${c.red(err.message)}`);
      console.log(`  ${c.dim('retrying…')}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

(async () => {
  try {
    process.exitCode = has('--watch') ? (await watch(), 0) : await once();
  } catch (err) {
    const message = err instanceof UsageError ? err.message : String(err && err.message);
    console.error(`\n  ${c.red('error:')} ${message}\n`);
    process.exitCode = 1;
  }
})();
