# OpenCode Go Usage Widget

A small, **zero-dependency, self-hosted web widget** that shows your OpenCode Go
subscription usage — **rolling (5h)**, **weekly**, and **monthly** — with
percentages, progress bars, and live reset countdowns.

Open it from anywhere you work:

- WSL / local Linux → `http://localhost:8787`
- Windows browser → `http://localhost:8787`
- Phone on the same Wi-Fi → `http://<your-pc-lan-ip>:8787` (installable as a home-screen app)
- SSH session → `node cli.js`, or port-forward the web UI

```
┌──────────────────────────────────────────┐
│  ● OpenCode Go                    46%    │
│    subscription usage             PEAK    │
│                                          │
│  Rolling    5h                        1% │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
│  resets in 4h 42m        Mon 01:41 PM    │
│                                          │
│  Weekly     7d                        0% │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
│  resets in 6d 18h        Mon 03:00 AM    │
│                                          │
│  Monthly    cycle                    46% │
│  ██████████████░░░░░░░░░░░░░░░░░░░░░░░   │
│  resets in 3d 1h         Thu 10:03 AM    │
└──────────────────────────────────────────┘
```

---

## Did something like this already exist?

Yes — a lot. Before writing this I checked, and these cover the same ground:

| Project | Platform | Notes |
|---|---|---|
| [`@mellena1/opencode-go-usage`](https://www.npmjs.com/package/@mellena1/opencode-go-usage) | OpenCode TUI sidebar | Closest drop-in; needs opencode v2 |
| [`opencode-go-limits`](https://www.opendock.net/plugins/opencode-go-limits/) | OpenCode TUI sidebar | v1 + v2 |
| [`slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota) | OpenCode sidebar | Multi-provider, ~1k stars |
| [`Mayanktaker/OpencodeGo-KDE-GNOME`](https://github.com/Mayanktaker/OpencodeGo-KDE-GNOME) | Linux KDE/GNOME + CLI | Needs a real Linux desktop |
| `OpenCode Go Usage Tracker` (extensions.gnome.org) | GNOME panel | GNOME only |
| [`opgginc/opencode-bar`](https://github.com/opgginc/opencode-bar/) | macOS menu bar + CLI | Also supports many providers |
| `wiscaksono/opencode-usage`, `saadjs/Runway`, `huakwan/quotix`, `headroom` | macOS menu bar | macOS only |
| `P1N2O/ocg-usage-plugin` | Windows TrafficMonitor | Windows taskbar only |
| `shsr07`, `xueayi`, `zzh799`, `logan0116`, `xiaweiliang060035` `dsh-*` | DeepSeek Harness web | Only useful if you use DSH |

**Why this one:** nothing was a good fit for **WSL2 + SSH + Windows + Android at
the same time**. Desktop applets assume a host desktop, the TUI plugins only
exist inside opencode, and the macOS/Windows apps are platform-locked. This is
a single web page on your own machine, so every device just needs a browser.

All of these read the same endpoint, which the OpenCode console is built on:

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <your Go API key>

{
  "usage": {
    "rolling": { "status": "ok", "percent": 1,  "resetsAt": "2026-10-19T10:41:37.000Z" },
    "weekly":  { "status": "ok", "percent": 0,  "resetsAt": "2026-10-26T00:00:00.000Z" },
    "monthly": { "status": "ok", "percent": 46, "resetsAt": "2026-10-22T07:03:14.000Z" }
  }
}
```

---

## Quick start

Requires **Node 20+** (you have v24). No `npm install` needed — there are no
dependencies.

```bash
cd ~/OpencodeWidget
node server.js
```

Open <http://localhost:8787>. That's it.

The server prints the URLs it's reachable on, including LAN addresses.

### Run it permanently

```bash
./scripts/install-service.sh
```

Installs a systemd **user** service (`opencode-go-widget`) that starts on login
and restarts on failure.

```bash
systemctl --user status opencode-go-widget
journalctl --user -u opencode-go-widget -f
```

---

## Hosting it 24/7 (laptop closed)

**The widget is only a viewer.** OpenCode tallies your usage server-side, so
nothing is lost when your laptop sleeps — you just can't reach a process running
inside WSL. Every option below moves the *viewer* to something that stays up.

| Option | Always on | Needs a domain | Cost | Best when |
|---|---|---|---|---|
| **A. Tailscale on an always-on box** | yes | no | box only | you have a VPS / Pi / SSH dev box |
| **B. VPS + Docker + Caddy** | yes | yes | ~$4–6/mo | you want a real URL + HTTPS |
| **C. Cloudflare Worker** | yes | no | free | you own no hardware at all |
| **D. Keep the laptop awake** | no | no | — | you only meant "lid closed", not "off" |

> Closing the lid on Windows almost always **suspends** the machine, which stops
> WSL2 entirely. No config change makes WSL survive that.

**Free with zero hardware? Option C.** No card, no machine, nothing to keep
running. Option A is also free if you already pay for an always-on box.

### A. Tailscale — recommended if you already have a server

Works on your VPS, home server, Raspberry Pi, or that always-on SSH dev box. No
public exposure, no certificates, no firewall changes.

```bash
# on the server
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
git clone <this repo> ~/OpencodeWidget && cd ~/OpencodeWidget
./scripts/install-service.sh          # systemd user service
tailscale ip -4                        # e.g. 100.101.102.103
```

Install Tailscale on your phone too, then open `http://100.101.102.103:8787/`.
The Tunnel is encrypted end-to-end by Tailscale, so plain HTTP is fine here.

### B. Docker on a VPS with a public URL

```bash
# on the VPS
git clone <this repo> ~/OpencodeWidget && cd ~/OpencodeWidget
export OPENCODE_GO_API_KEY=oc_sk_...
export WIDGET_TOKEN=$(openssl rand -hex 16)
docker compose up -d --build

sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the hostname first
sudo systemctl reload caddy
```

The compose file binds to `127.0.0.1` only; Caddy terminates HTTPS in front of
it. Full details in `deploy/Caddyfile`.

Use a Cloudflare Tunnel instead of opening ports, if you prefer:

```bash
cloudflared tunnel create ocw
cloudflared tunnel route dns ocw go.example.com
cloudflared tunnel run --url http://127.0.0.1:8787 ocw
```

**In a container the widget can't read your opencode database**, so the key must
come from the environment (`OPENCODE_GO_API_KEY`) — that's why it's required in
`docker-compose.yml`.

### C. Cloudflare Worker — nothing to keep running

Deploy once, get a `*.workers.dev` HTTPS URL, view it from anywhere. Static
assets are free; the API is one subrequest per refresh.

```bash
cd deploy/cloudflare-worker
npx wrangler login
npx wrangler secret put OPENCODE_GO_API_KEY
npx wrangler secret put AUTH_TOKEN          # optional
npx wrangler deploy
```

It serves the same UI straight out of `public/` (verified against Wrangler 4 —
`total upload: 6.68 KiB`) and caches at the edge for 60 s, so a glance from your
phone is a fraction of a request. The free plan allows 100k requests/day and
needs no credit card, so this is the cheapest honest answer to "always on".

Test it before you trust it:

```bash
npm test        # 23 assertions: routing, auth, edge cache, stale fallback
```

### D. Keeping WSL awake instead

If you literally only close the lid while plugged in, tell Windows to keep
running: **Power Options → Choose what closing the lid does → Do nothing**, and
disable sleep while plugged in. Then `./scripts/install-service.sh` keeps the
widget alive for as long as Windows stays awake. This burns power and defeats
the point of a laptop; prefer A or C.

### Before you expose it

- Set `authToken` / `AUTH_TOKEN` (or front it with Tailscale). The usage
  endpoint needs a key that can read your subscription.
- A `403` with "no active Go plan" usually means the key isn't the Go one.
- `cacheSeconds` floors at 5 s — the API is a three-table join, so don't poll it
  like a heartbeat.

---

## Your API key

The widget reuses the key opencode already has. It looks in this order:

1. `config.json` → `"apiKey"`
2. Environment: `OPENCODE_GO_API_KEY`, `OPENCODE_ZEN_API_KEY`, `OPENCODE_API_KEY`, `OCG_API_KEY`
3. `./key` or `~/.config/opencode-widget/key`
4. `~/.local/share/opencode/auth.json` → provider `opencode-go` / `opencode-zen` / `opencode`
5. The **opencode v2 database** (`~/.local/share/opencode/opencode.db`, active
   credential labelled *OpenCode Console*) — this is where v2 stores it

Check what it found:

```bash
node cli.js --source
```

Nothing is ever sent anywhere except `opencode.ai`. The key is never exposed by
the web API or rendered in the page.

---

## Configuration

Copy `config.example.json` → `config.json`, or put it at
`~/.config/opencode-widget/config.json`.

| Key | Default | Meaning |
|---|---|---|
| `host` | `0.0.0.0` | Bind address. Use `127.0.0.1` to make it local-only. |
| `port` | `8787` | HTTP port. |
| `cacheSeconds` | `60` | Server-side cache; prevents hot-polling the API. |
| `clientRefreshSeconds` | `30` | How often the page refreshes. |
| `authToken` | `""` | If set, the API requires `?token=…` or `X-Auth-Token`. |
| `apiKey` | auto | Override key detection. |
| `endpoint` | official | Only change if OpenCode moves the route. |

Environment overrides: `WIDGET_HOST`, `WIDGET_PORT`, `WIDGET_TOKEN`,
`WIDGET_CACHE_SECONDS`, `WIDGET_CLIENT_REFRESH_SECONDS`, `WIDGET_ENDPOINT`.

CLI flags: `--port`, `--host`, `--token`.

### Locking it down on a shared network

```bash
node server.js --token "$(openssl rand -hex 16)"
```

Open the printed `…/?token=…` URL once; the browser stores it and strips it from
the address bar. Without the token the page loads but the API returns `401`, so
no usage data is exposed.

---

## Opening it from your phone (WSL2)

WSL2 in the default **NAT** mode is not reachable from your LAN, so pick one:

**Option A — port forward (works with any mode).** In an **Administrator**
PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows-portproxy.ps1
```

It prints `http://<lan-ip>:8787/`. Re-run after a reboot if the WSL IP changes.
Remove with `-Remove`.

**Option B — mirrored networking (cleaner).** Add to
`%UserProfile%\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

Then `wsl --shutdown` and restart. Windows' own LAN IP now serves the widget
directly (allow Node through the Windows firewall the first time).

**Then on Android:** open the URL in Chrome → ⋮ → **Add to Home screen**. The
page has a web manifest, so it launches standalone like an app. The title shows
the peak percentage, and countdowns tick live.

---

## SSH / headless use

Eight-hour countdowns are easier as text:

```bash
node cli.js            # table
node cli.js --compact  # Go 5h 1% · wk 0% · mo 46%
node cli.js --json     # machine-readable
node cli.js --watch    # live refresh every 30s
```

Or keep the web UI and forward the port:

```bash
# on your laptop
ssh -L 8787:localhost:8787 you@dev-box
# then open http://localhost:8787
```

---

## API

| Endpoint | Returns |
|---|---|
| `GET /api/usage` | Cached snapshot (auto-refreshes when stale) |
| `GET /api/refresh` | Forces a fresh upstream fetch |
| `GET /api/health` | Liveness + whether a key was found |
| `GET /api/config` | Non-secret client settings |

If a fetch fails, the last good numbers stay visible flagged `stale` — the
widget never blanks out or shows a confident zero.

---

## Exact console numbers (console mode)

By default the widget now reproduces the **web console's** arithmetic exactly, so
you should not see any difference.

Two data sources exist, and they do **not** agree:

| Source | What it returns | Rounding |
|---|---|---|
| `GET /zen/go/v1/usage` (API key) | whole percents, e.g. `percent: 5` | **floors** |
| `GET /console/api/go/status` (console session) | exact `usedMicroCents` / `limitMicroCents` | **rounds** |

Measured with the same instant:

| window | exact | API key says | console shows | widget shows |
|---|---|---|---|---|
| Rolling | 6.88 % | 6 | **7** | **7** ✓ |
| Weekly | 2.75 % | 2 | **3** | **3** ✓ |
| Monthly | 47.83 % | 47 | **48** | **48** ✓ |

The widget prefers the console session when one is available, computes
`round(used / limit * 100)` — the same thing the console does — and falls back to
the API key automatically if the session is missing or expired (with a note in
the UI). It also shows the exact figures it used, e.g. `$0.83 of $12.00 · 6.88% exact`.

**Why not just round up (`ceil`)?** Because the console rounds to *nearest*, not
up. Weekly above is 2.75 % → the console says 3 and `ceil` also says 3, but a
value like 2.33 % shows as **2** in the console while `ceil` would wrongly show
**3**. Rounding up over-reports roughly half the time; reading the exact value
and rounding it is correct every time.

### Where the console session comes from

The widget reuses the OAuth token the opencode CLI already stores in
`opencode.db` (credentials with `metadata.orgID`), so there is nothing to set up
locally. That token expires (roughly monthly) — running opencode refreshes it,
and until then the widget quietly falls back to API-key values.

To supply one explicitly instead:

```bash
export OPENCODE_CONSOLE_TOKEN='...'   # the console bearer token
export OPENCODE_ORG_ID='wrk_...'      # from opencode.ai/console/<wrk_...>/go
```

### On the Cloudflare Worker

A Worker has no access to `opencode.db`, so it uses the API key (floored) unless
you give it a console session:

```bash
cd deploy/cloudflare-worker
npx wrangler secret put OPENCODE_CONSOLE_TOKEN
npx wrangler secret put OPENCODE_ORG_ID
```

Note the trade-off: that token is a session credential that expires, so you'd
re-upload it periodically. Without it the Worker stays accurate to within one
point and says so.

## Behavior notes

- **Thresholds:** green under 70 %, amber 70–89 %, red 90 %+ (or when the API
  reports a window as limited).
- **Caching:** the server caches for 15–20 s regardless of how many devices
  poll, so a phone plus a laptop still costs one upstream request per window.
- **Unofficial endpoint:** `/zen/go/v1/usage` powers the OpenCode console but is
  not in the public Go docs. If it changes, the widget reports the failure
  rather than inventing numbers.
- **Account-wide:** percentages are for the whole subscription. The Go meters
  are aggregate — they include every identity spending on the workspace, not
  per device and not per user. There is no per-user meter to miss.

---

## Files

```
server.js                     HTTP server + API + static hosting
cli.js                        terminal client (--json, --watch, --compact)
lib/usage.js                  key detection + usage fetching + formatting
public/                       the web UI (no build step)
scripts/install-service.sh    systemd user service
scripts/windows-portproxy.ps1 WSL2 → LAN port forward for phones
Dockerfile                    container image for an always-on host
docker-compose.yml            compose service (binds to 127.0.0.1)
deploy/Caddyfile              HTTPS reverse proxy example
deploy/cloudflare-worker/     serverless edition (no machine needed)
config.example.json           copy to config.json
```
