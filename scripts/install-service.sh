#!/usr/bin/env bash
# Install (or refresh) the widget as a systemd user service.
#
#   ./scripts/install-service.sh
#
# Runs on boot and restarts on failure. Logs: journalctl --user -u opencode-go-widget -f
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/opencode-go-widget.service"

if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found on PATH. Install Node 20+ first." >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"

cat > "$UNIT" <<EOF
[Unit]
Description=OpenCode Go usage widget
Documentation=file://$ROOT/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$NODE_BIN $ROOT/server.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

# Pick up a token / port override from an env file if the user made one.
if [[ -f "$ROOT/widget.env" ]]; then
  sed -i "/^\[Service\]/a EnvironmentFile=$ROOT/widget.env" "$UNIT"
fi

systemctl --user daemon-reload
systemctl --user enable --now opencode-go-widget.service

echo
echo "Installed: $UNIT"
systemctl --user --no-pager --lines=0 status opencode-go-widget.service || true
echo
echo "Logs:    journalctl --user -u opencode-go-widget -f"
echo "Restart: systemctl --user restart opencode-go-widget"
