#!/usr/bin/env bash
# Start the lip-sync server and its public tunnel on a GPU box. Safe to run again at any time:
# whatever is already running and healthy is left alone.
#
#   bash /workspace/avatar-gpu/start.sh              start what is not running, print the tunnel URL
#   bash /workspace/avatar-gpu/start.sh --restart    stop both first
#
# A brand-new box needs nothing else: Python, the packages, ffmpeg, cloudflared, the models and the
# prepared clip all live in /workspace/avatar-gpu. (If that folder was lost, run setup.sh and
# prepare.py again; this script does it by itself when it finds the environment missing.)
#
# After the tunnel is up its address is POSTed as {"url": "https://..."} with the header
# x-avatar-key to every address in AVATAR_REGISTER_URLS (space separated). If that variable is not
# set, the addresses are read from /workspace/avatar-gpu/register_urls.txt when it exists.
set -uo pipefail
ROOT="${AVATAR_ROOT:-/workspace/avatar-gpu}"
# Settings for the server (AVATAR_KBPS, AVATAR_X264_CRF and so on, one NAME=value per line) can be
# kept in server.env next to this script; they then also apply when the keeper restarts it.
if [ -f "$ROOT/server.env" ]; then set -a; . "$ROOT/server.env"; set +a; fi
PORT="${AVATAR_PORT:-8000}"
cd "$ROOT" || { echo "missing $ROOT"; exit 1; }
mkdir -p logs run
T0=$(date +%s)
say() { echo "[start $(( $(date +%s) - T0 ))s] $*"; }

[ "${1:-}" = "--restart" ] && bash "$ROOT/stop.sh" >/dev/null 2>&1

# --- system packages a fresh box may lack (everything else is inside /workspace/avatar-gpu) ---------
need=""
command -v curl >/dev/null 2>&1 || need="$need curl"
[ -e /etc/ssl/certs/ca-certificates.crt ] || need="$need ca-certificates"
command -v git >/dev/null 2>&1 || [ -d src/MuseTalk ] || need="$need git"
if [ -n "$need" ]; then
  say "installing:$need"
  (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $need) >> logs/apt.log 2>&1 \
    || say "apt-get failed, see logs/apt.log"
fi

# --- environment ---------------------------------------------------------------------------------------
if ! { [ -x venv/bin/python ] && venv/bin/python -c "import sys" 2>/dev/null && [ -x bin/ffmpeg ] && [ -x bin/cloudflared ] \
       && [ -f models/musetalkV15/unet_fp16.safetensors ]; }; then
  say "environment missing or broken: running setup.sh (several minutes)"
  bash "$ROOT/setup.sh" >> logs/setup.log 2>&1 || { say "setup.sh failed, see logs/setup.log"; exit 1; }
fi
[ -s key.txt ] || { say "key.txt is missing (the AVATAR_GPU_KEY value, mode 600)"; exit 1; }
chmod 600 key.txt
if [ ! -f avatars/talk/meta.json ]; then
  say "clip 'talk' is not prepared: running prepare.py"
  [ -f clips/talk.mp4 ] || { say "clips/talk.mp4 is missing"; exit 1; }
  venv/bin/python prepare.py --clip talk --size 960x720 >> logs/prepare-talk.log 2>&1 || { say "prepare.py failed"; exit 1; }
fi
KEY="$(cat key.txt)"

# run/*.pid survive on the persistent disk, so on a new box they may name some unrelated process:
# a part only counts as alive when the process with that number is really ours.
alive() {
  local pid pat
  case "$1" in server) pat="server.py" ;; tunnel) pat="cloudflared" ;; *) pat="$1.sh" ;; esac
  pid="$(cat "run/$1.pid" 2>/dev/null)" || return 1
  [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q "$pat"
}
healthy() { curl -fsS -m 3 -H "x-avatar-key: $KEY" "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }

# --- server -----------------------------------------------------------------------------------------------
if healthy; then
  say "server already running"
else
  alive server && { kill "$(cat run/server.pid)" 2>/dev/null; sleep 1; }
  say "starting server"
  HF_HOME=/tmp/hf-home setsid nohup venv/bin/python server.py >> logs/server.log 2>&1 < /dev/null &
  echo $! > run/server.pid
fi

# --- tunnel (started at the same time; it does not need the server to be ready) -----------------------------
tunnel_url() { grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' logs/tunnel.log 2>/dev/null | tail -1; }
if alive tunnel && [ -n "$(tunnel_url)" ]; then
  say "tunnel already running"
else
  alive tunnel && { kill "$(cat run/tunnel.pid)" 2>/dev/null; sleep 1; }
  say "starting tunnel"
  : > logs/tunnel.log
  setsid nohup bin/cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >> logs/tunnel.log 2>&1 < /dev/null &
  echo $! > run/tunnel.pid
fi

# --- wait for both --------------------------------------------------------------------------------------------
# A box that has just started reads Python and its packages from cold network storage: the
# first start can take five minutes or more. Later starts on the same box take seconds.
for i in $(seq 1 900); do
  healthy && break
  alive server || { say "server stopped while starting; last lines of logs/server.log:"; tail -5 logs/server.log; exit 1; }
  sleep 1
done
healthy || { say "server did not answer /health in time, see logs/server.log"; exit 1; }
say "server answers /health"
URL=""
for i in $(seq 1 60); do URL="$(tunnel_url)"; [ -n "$URL" ] && break; sleep 1; done
[ -n "$URL" ] || { say "no tunnel address, see logs/tunnel.log"; exit 1; }
echo "$URL" > run/tunnel.url
for i in $(seq 1 30); do
  curl -fsS -m 5 -H "x-avatar-key: $KEY" "$URL/health" >/dev/null 2>&1 && { say "tunnel answers /health"; break; }
  sleep 1
done

# --- tell the app where we are (failures here never stop the script) ------------------------------------------
REG="${AVATAR_REGISTER_URLS:-}"
[ -z "$REG" ] && [ -f register_urls.txt ] && REG="$(grep -v '^#' register_urls.txt | tr '\n' ' ')"
for r in $REG; do
  ok=0
  for try in 1 2 3; do
    if curl -fsS -m 15 -X POST -H "content-type: application/json" -H "x-avatar-key: $KEY" \
         -d "{\"url\":\"$URL\"}" "$r" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  [ "$ok" = 1 ] && say "registered with $r" || say "could not register with $r (ignored)"
done

# --- keeper: if the server or the tunnel dies, run this script again (new tunnel address is registered) ---------
if [ "${AVATAR_KEEPER:-1}" = "1" ] && ! alive keeper; then
  AVATAR_REGISTER_URLS="$REG" setsid nohup bash "$ROOT/keeper.sh" >> logs/keeper.log 2>&1 < /dev/null &
  echo $! > run/keeper.pid
fi

say "ready"
echo "TUNNEL_URL=$URL"
