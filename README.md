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

## Behavior notes

- **Thresholds:** green under 70 %, amber 70–89 %, red 90 %+ (or when the API
  reports a window as limited).
- **Caching:** the server caches for 60 s regardless of how many devices poll,
  so a phone plus a laptop still costs one request per minute at most.
- **Unofficial endpoint:** `/zen/go/v1/usage` powers the OpenCode console but is
  not in the public Go docs. If it changes, the widget reports the failure
  rather than inventing numbers.
- **Account-wide:** percentages are for the whole subscription, not per device.

---

## Files

```
server.js                     HTTP server + API + static hosting
cli.js                        terminal client (--json, --watch, --compact)
lib/usage.js                  key detection + usage fetching + formatting
public/                       the web UI (no build step)
scripts/install-service.sh    systemd user service
scripts/windows-portproxy.ps1 WSL2 → LAN port forward for phones
config.example.json           copy to config.json
```
