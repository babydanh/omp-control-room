#!/usr/bin/env bash
# Install fleet-hub on the hub machine as a systemd service listening on 127.0.0.1:18430.
# Keys live in fleet-data/keys.json (public keys only). Publish the port separately.
set -euo pipefail
HUB_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA="$(dirname "$HUB_DIR")/fleet-data"
mkdir -p "$DATA"; chmod 700 "$DATA"
[ -f "$DATA/keys.json" ] || echo '{}' > "$DATA/keys.json"
chmod 600 "$DATA/keys.json"
sudo tee /etc/systemd/system/fleet-hub.service >/dev/null <<EOF
[Unit]
Description=fleet-hub
After=network.target
[Service]
User=$(id -un)
Environment=FLEET_KEYS=$DATA/keys.json FLEET_STATE=$DATA/state.json PORT=18430 HOST=127.0.0.1
ExecStart=$(command -v node) $HUB_DIR/hub.mjs
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now fleet-hub
sleep 2
systemctl is-active fleet-hub
curl -s -o /dev/null -w "local khong khoa -> %{http_code}\n" http://127.0.0.1:18430/v1/fleet
