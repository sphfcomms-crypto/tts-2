#!/usr/bin/env bash
# Start the whole-face server and its own public tunnel on a GPU box, and tell the app where it is.
# Safe to run again; --restart stops both first.
#
#   bash /workspace/tts-2-lab/server/start.sh [--restart]
#
# The app's shared secret is read from FLASH_KEY_FILE (default: the lip-sync box's key.txt, the
# AVATAR_GPU_KEY value). The tunnel's address is POSTed to <site>/api/avatar/flash/register for every
# site in FLASH_REGISTER_URLS (space separated) or, if that is not set, for every site the lip-sync
# box registers with (/workspace/avatar-gpu/register_urls.txt). Settings for server.py (FLASH_FRAMES,
# FLASH_OUT, ...) can be kept in flash.env, one NAME=value per line.
set -uo pipefail
L="${FLASH_ROOT:-/workspace/tts-2-lab}"
cd "$L" || { echo "missing $L: run setup.sh first"; exit 1; }
mkdir -p logs run
if [ -f flash.env ]; then set -a; . ./flash.env; set +a; fi
PORT="${FLASH_PORT:-8100}"
export FLASH_KEY_FILE="${FLASH_KEY_FILE:-/workspace/avatar-gpu/key.txt}"
[ -s "$FLASH_KEY_FILE" ] || { echo "no key at $FLASH_KEY_FILE (the app's AVATAR_GPU_KEY value, mode 600)"; exit 1; }
KEY="$(cat "$FLASH_KEY_FILE")"
export PATH="$L/bin:$PATH"
T0=$(date +%s); say() { echo "[flash $(( $(date +%s) - T0 ))s] $*"; }
[ "${1:-}" = "--restart" ] && bash "$L/server/stop.sh" >/dev/null 2>&1
alive() { local pid; pid="$(cat "run/$1.pid" 2>/dev/null)" && [ -n "$pid" ] && grep -q "$2" "/proc/$pid/cmdline" 2>/dev/null; }
healthy() { curl -fsS -m 3 -H "x-avatar-key: $KEY" "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }

if healthy; then say "server already running"; else
  say "starting server"
  setsid nohup venv/bin/python server/server.py >> logs/flash.log 2>&1 < /dev/null &
  echo $! > run/flash.pid
fi
url() { grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' logs/flash-tunnel.log 2>/dev/null | tail -1; }
if alive flash-tunnel cloudflared && [ -n "$(url)" ]; then say "tunnel already running"; else
  say "starting tunnel"
  : > logs/flash-tunnel.log
  setsid nohup bin/cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >> logs/flash-tunnel.log 2>&1 < /dev/null &
  echo $! > run/flash-tunnel.pid
fi
for i in $(seq 1 300); do healthy && break; alive flash server.py || { say "server stopped while starting:"; tail -5 logs/flash.log; exit 1; }; sleep 1; done
healthy || { say "server did not answer /health, see logs/flash.log"; exit 1; }
say "server answers /health"
URL=""; for i in $(seq 1 60); do URL="$(url)"; [ -n "$URL" ] && break; sleep 1; done
[ -n "$URL" ] || { say "no tunnel address, see logs/flash-tunnel.log"; exit 1; }
for i in $(seq 1 30); do curl -fsS -m 5 -H "x-avatar-key: $KEY" "$URL/health" >/dev/null 2>&1 && break; sleep 1; done

SITES="${FLASH_REGISTER_URLS:-}"
if [ -z "$SITES" ] && [ -f /workspace/avatar-gpu/register_urls.txt ]; then
  SITES="$(grep -v '^#' /workspace/avatar-gpu/register_urls.txt | sed 's#/api/avatar/register#/api/avatar/flash/register#' | tr '\n' ' ')"
fi
for r in $SITES; do
  curl -fsS -m 15 -X POST -H "content-type: application/json" -H "x-avatar-key: $KEY" -d "{\"url\":\"$URL\"}" "$r" >/dev/null 2>&1 \
    && say "registered with $r" || say "could not register with $r (ignored)"
done
say "ready"
echo "FLASH_URL=$URL"
