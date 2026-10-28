#!/usr/bin/env bash
# Harden the shared hub machine: log rotation, a health watchdog that restarts hung services,
# and private permissions on fleet state. Idempotent.
set -euo pipefail
HUB=/data/home/hub

# 1. Cắt log: máy không có logrotate trong apt, nên hub-health cắt log > 20 MB còn 5 MB cuối.
sudo rm -f /etc/logrotate.d/hub

# 2. Giám sát sống: systemd chỉ khởi động lại khi tiến trình chết, không khi treo.
sudo tee /usr/local/bin/hub-health >/dev/null <<'EOF'
#!/usr/bin/env bash
check() { curl -s -o /dev/null -m 15 -w '%{http_code}' "$2" | grep -qE "$3" || { logger -t hub-health "$1 khong tra loi, khoi dong lai"; systemctl restart "$1"; }; }
check llama-embed http://127.0.0.1:8081/health '^200$'
check openviking  http://127.0.0.1:18420/health '^200$'
check 9router     http://127.0.0.1:20128/ '^(200|30[0-9])$'
check fleet-hub   http://127.0.0.1:18430/v1/fleet '^401$'
for f in /data/home/hub/*.log; do
  [ "$(stat -c %s "$f")" -gt 20971520 ] && { tail -c 5242880 "$f" > "$f.cut" && cat "$f.cut" > "$f" && rm -f "$f.cut"; logger -t hub-health "cat log $f"; }
done
exit 0
EOF
sudo chmod 755 /usr/local/bin/hub-health
sudo tee /etc/systemd/system/hub-health.service >/dev/null <<'EOF'
[Unit]
Description=Kiem tra song dich vu tram chung
[Service]
Type=oneshot
ExecStart=/usr/local/bin/hub-health
EOF
sudo tee /etc/systemd/system/hub-health.timer >/dev/null <<'EOF'
[Unit]
Description=Kiem tra song moi 5 phut
[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now hub-health.timer >/dev/null
sudo systemctl start hub-health.service
echo "hub-health: $(systemctl is-active hub-health.timer), lan chay: $(systemctl show hub-health.service -p Result --value)"

# 3. Quyền: state.json chứa đường dẫn file/nhánh của mọi máy.
chmod 600 "$HUB/fleet-data/state.json" 2>/dev/null || true
stat -c '%a %n' "$HUB/fleet-data/state.json"
