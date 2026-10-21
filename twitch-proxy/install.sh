#!/usr/bin/env bash
# Install the KO Twitch proxy on a Linux VPS (Ubuntu/Debian).
# Run as root from the directory that contains ko-proxy.mjs:
#   sudo bash install.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo bash install.sh" >&2
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="/opt/ko-twitch-proxy"
ENV_FILE="/etc/ko-twitch-proxy.env"
SERVICE="/etc/systemd/system/ko-twitch-proxy.service"
PORT="${KO_PROXY_PORT:-8899}"

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "==> installing Node.js 22"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y ca-certificates curl
    if ! curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; then
      echo "==> NodeSource unavailable; falling back to the distro nodejs"
    fi
    apt-get install -y nodejs
  else
    echo "unsupported distro: install Node.js >= 18 and rerun" >&2
    exit 1
  fi
fi

echo "==> installing proxy files in $APP"
install -d -m 0755 "$APP"
install -m 0644 "$DIR/ko-proxy.mjs" "$APP/ko-proxy.mjs"

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
if [ -z "${KO_PROXY_AUTH:-}" ]; then
  PASS="$(openssl rand -hex 12 2>/dev/null || head -c 18 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)"
  KO_PROXY_AUTH="ko:${PASS}"
fi

cat > "$ENV_FILE" <<EOF
KO_PROXY_HOST=${KO_PROXY_HOST:-0.0.0.0}
KO_PROXY_PORT=${PORT}
KO_PROXY_AUTH=${KO_PROXY_AUTH}
EOF
chmod 0600 "$ENV_FILE"

echo "==> writing systemd unit"
cat > "$SERVICE" <<EOF
[Unit]
Description=KO Twitch ad-free playlist proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node ${APP}/ko-proxy.mjs
Restart=always
RestartSec=2
User=nobody
Group=nogroup
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=${APP}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ko-twitch-proxy.service
systemctl restart ko-twitch-proxy.service

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  echo "==> opening ${PORT}/tcp in ufw"
  ufw allow "${PORT}/tcp" >/dev/null || true
fi

sleep 1
PUBIP="$(curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || true)"
echo
echo "============================================================"
echo " KO Twitch proxy installed and running"
echo "============================================================"
echo " Address : ${PUBIP:-<your-vps-public-ip>}:${PORT}"
echo " Auth    : ${KO_PROXY_AUTH}"
echo " Health  : curl http://${PUBIP:-<your-vps-public-ip>}:${PORT}/health"
echo
echo " In the extension popup -> 'Proxy HD (sem ads)':"
echo "   host:port = ${PUBIP:-<your-vps-public-ip>}:${PORT}"
echo "   user      = ${KO_PROXY_AUTH%%:*}"
echo "   pass      = ${KO_PROXY_AUTH#*:}"
echo "============================================================"
echo
echo " Verify the egress country with: curl -s https://ipinfo.io/country"
echo " Twitch only returns ad-free playlists in regions where it does not"
echo " fill SSAI ads; if ads remain, move the VPS to another region."
