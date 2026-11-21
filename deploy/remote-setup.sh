#!/usr/bin/env bash
# Sets up and (re)starts the TTS app on the server. Run as root on the server
# by deploy.sh; safe to run again for every new deploy.
#
#   /opt/tts/app        the code (replaced on each deploy)
#   /opt/tts/.env       the secrets (OPENAI_API_KEY, optional APP_PASSWORD)
#   tts.service         the app, on 127.0.0.1:$PORT, restarted if it stops
#
# The app is published with Tailscale Funnel, which gives it a public HTTPS
# address without touching the nginx that already serves ports 80 and 443 on
# this machine. Nothing else on the server is changed.
set -euo pipefail

PORT="${1:?usage: remote-setup.sh <local port> <funnel https port>}"
FUNNEL_PORT="${2:?usage: remote-setup.sh <local port> <funnel https port>}"
APP_DIR=/opt/tts

say() { printf '\n==> %s\n' "$*"; }

command -v node >/dev/null || { echo "Node.js is not installed on the server."; exit 2; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node.js 20 or newer is needed (found $(node -v))."; exit 2; }
command -v tailscale >/dev/null || { echo "Tailscale is not installed on the server."; exit 2; }

# The port must be free, or already ours from an earlier deploy.
owner=$(ss -ltnpH "( sport = :$PORT )" 2>/dev/null || true)
if [ -n "$owner" ] && ! systemctl is-active --quiet tts; then
  echo "Port $PORT is already used by something else:"
  echo "$owner"
  echo "Nothing was changed."
  exit 3
fi

say "Unpacking the app"
id tts >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin tts
mkdir -p "$APP_DIR"
chown tts:tts "$APP_DIR"
rm -rf "$APP_DIR/app.new"
mkdir "$APP_DIR/app.new"
tar -xzf /tmp/tts-app.tar.gz -C "$APP_DIR/app.new"
if [ -f /tmp/tts.env ]; then
  install -m 600 -o tts -g tts /tmp/tts.env "$APP_DIR/.env"
  rm -f /tmp/tts.env
fi
[ -f "$APP_DIR/.env" ] || { echo "No $APP_DIR/.env on the server and none was uploaded."; exit 4; }
ln -sf "$APP_DIR/.env" "$APP_DIR/app.new/.env"
chown -R tts:tts "$APP_DIR/app.new"

say "Installing packages and building (a few minutes the first time)"
cd "$APP_DIR/app.new"
sudo -u tts env HOME="$APP_DIR" npm ci --no-audit --no-fund --loglevel=error
sudo -u tts env HOME="$APP_DIR" NODE_ENV=production npx next build | tail -14

say "Switching to the new build"
systemctl stop tts 2>/dev/null || true
rm -rf "$APP_DIR/app.old"
[ -d "$APP_DIR/app" ] && mv "$APP_DIR/app" "$APP_DIR/app.old"
mv "$APP_DIR/app.new" "$APP_DIR/app"

cat > /etc/systemd/system/tts.service <<UNIT
[Unit]
Description=TTS web app
After=network-online.target
Wants=network-online.target

[Service]
User=tts
WorkingDirectory=$APP_DIR/app
Environment=NODE_ENV=production
Environment=HOME=$APP_DIR
ExecStart=$(command -v npx) next start -H 127.0.0.1 -p $PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now tts >/dev/null 2>&1

say "Waiting for the app to answer"
up=no
for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then
    up=yes
    break
  fi
  sleep 1
done
if [ "$up" != yes ]; then
  echo "The app did not come up. Last log lines:"
  journalctl -u tts -n 25 --no-pager
  exit 5
fi
echo "app is up on 127.0.0.1:$PORT"

say "Publishing with Tailscale Funnel on port $FUNNEL_PORT"
tailscale funnel --bg --https="$FUNNEL_PORT" "http://127.0.0.1:$PORT"
tailscale funnel status

rm -f /tmp/tts-app.tar.gz
echo
echo "Done."
