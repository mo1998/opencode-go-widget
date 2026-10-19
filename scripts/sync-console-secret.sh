#!/usr/bin/env bash
# Push the current console session token to the Cloudflare Worker.
#
# The console OAuth token that gives console-exact numbers expires roughly
# monthly. When it does, just run this again — it re-reads the fresh token that
# opencode stores in opencode.db and re-uploads both secrets.
#
#   ./scripts/sync-console-secret.sh
#
# Nothing is printed except the expiry date; the token goes straight from
# sqlite into wrangler over a pipe.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/deploy/cloudflare-worker"

read_cred() {
  python3 - "$1" <<'PY'
import json, os, sqlite3, sys

want = sys.argv[1]
base = os.environ.get('OPENCODE_DATA_DIR') or os.path.join(
    os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share'), 'opencode')
path = os.path.join(base, 'opencode.db')

if not os.path.exists(path):
    sys.exit(f"error: {path} not found — is opencode installed?", )

best = None
for (value,) in sqlite3.connect(f'file:{path}?mode=ro', uri=True).execute('select value from credential'):
    try:
        d = json.loads(value)
    except Exception:
        continue
    meta = d.get('metadata') or {}
    if not (meta.get('orgID') and d.get('access')):
        continue
    exp = int(d.get('expires') or 0)
    if best is None or exp > best[0]:
        best = (exp, d, meta)

if best is None:
    sys.exit('error: no console session found in opencode.db — run `opencode` once to sign in')

exp, d, meta = best
import datetime
when = datetime.datetime.fromtimestamp(exp / 1000, datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
now = datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000
if exp and exp < now:
    sys.exit(f'error: console session expired at {when} — run `opencode` to refresh it')

print(f"console session valid until {when}", file=sys.stderr)
print(d['access'] if want == 'token' else meta['orgID'])
PY
}

echo "Reading console session from opencode.db…"
read_cred token | npx --yes wrangler@4 secret put OPENCODE_CONSOLE_TOKEN
read_cred org | npx --yes wrangler@4 secret put OPENCODE_ORG_ID

echo
echo "Done. The Worker now reads console-exact numbers."
echo "Verify:  curl -s https://<your-worker>/api/health   # expect \"source\":\"console\""
