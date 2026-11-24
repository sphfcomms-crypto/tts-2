#!/usr/bin/env bash
# Start the whole-face server and its own public tunnel on a GPU box, and tell the app where it is.
# Safe to run again; --restart stops both first.
#
#   bash start.sh [--restart]        (from wherever this folder is on the box)
#
# On a new box this first builds what is missing (setup.sh: about two minutes for Python on the
# box's own disk, three more the very first time for the model). Her first picture is ready about
# a minute after that.
#
# The app's shared secret is read from FLASH_KEY_FILE (default: the lip-sync box's key.txt, the
# AVATAR_GPU_KEY value). The tunnel's address is POSTed to <site>/api/avatar/flash/register for every
# site in FLASH_REGISTER_URLS (space separated) or, if that is not set, for every site the lip-sync
# box registers with (/workspace/avatar-gpu/register_urls.txt). Settings for server.py (FLASH_FRAMES,
# FLASH_OUT, ...) can be kept in flash.env, one NAME=value per line. FLASH_LOOK=anchor draws her as
# the news anchor (looks/anchor.env).
set -uo pipefail
L="${FLASH_ROOT:-/workspace/tts-2-lab}"
E="${FLASH_ENV:-/opt/tts-2-lab}"
HERE="$(cd "$(dirname "$0")" && pwd)"
exec 9> /tmp/flash-start.lock; flock 9      # one start at a time: a second one waits, then finds it running
# Python lives on the box's own disk, so a new box has none yet: build what is missing first.
if [ ! -f "$E/deps-ok" ] || [ ! -d "$L/SoulX-FlashHead" ]; then
  bash "$HERE/setup.sh" > /tmp/flash-setup.log 2>&1 || true
  [ -f "$E/deps-ok" ] || { echo "setup did not finish, see /tmp/flash-setup.log"; tail -5 /tmp/flash-setup.log; exit 1; }
fi
cd "$L" || { echo "missing $L: run setup.sh first"; exit 1; }
mkdir -p logs run
if [ -f flash.env ]; then set -a; . ./flash.env; set +a; fi
# FLASH_LOOK=<name>: one of the looks kept in looks/ (its picture and square; see README.md).
if [ -n "${FLASH_LOOK:-}" ]; then
  [ -f "$HERE/looks/$FLASH_LOOK.env" ] || { echo "no look called $FLASH_LOOK in $HERE/looks"; exit 1; }
  set -a; . "$HERE/looks/$FLASH_LOOK.env"; set +a
fi
PORT="${FLASH_PORT:-8100}"
export FLASH_KEY_FILE="${FLASH_KEY_FILE:-/workspace/avatar-gpu/key.txt}"
[ -s "$FLASH_KEY_FILE" ] || { echo "no key at $FLASH_KEY_FILE (the app's AVATAR_GPU_KEY value, mode 600)"; exit 1; }
KEY="$(cat "$FLASH_KEY_FILE")"
export PATH="$L/bin:$PATH"
T0=$(date +%s); say() { echo "[flash $(( $(date +%s) - T0 ))s] $*"; }
[ "${1:-}" = "--restart" ] && bash "$HERE/stop.sh" >/dev/null 2>&1
alive() { local pid; pid="$(cat "run/$1.pid" 2>/dev/null)" && [ -n "$pid" ] && grep -q "$2" "/proc/$pid/cmdline" 2>/dev/null; }
healthy() { curl -fsS -m 3 -H "x-avatar-key: $KEY" "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }

# The size the model draws her at decides whether this GPU keeps up with her voice. FLASH_SIZE set:
# that size. Not set: it starts at FLASH_SIZE_MOST (416), reads from /health how busy the GPU would
# be in a call, and while that is more than nine tenths of the time (FLASH_BUSY_MOST) goes straight
# to the size at which it should be 0.85 (the work grows with the square of the size), but not
# below FLASH_SIZE_LEAST (256). An L40S is busy 0.86 of the time at 416. Smaller is less sharp.
MOST="${FLASH_SIZE:-${FLASH_SIZE_MOST:-416}}"
LEAST="${FLASH_SIZE:-${FLASH_SIZE_LEAST:-256}}"
busy() {   # the work for one slice as a share of the slice's own length: below 1, faster than her voice
  curl -fsS -m 3 -H "x-avatar-key: $KEY" "http://127.0.0.1:$PORT/health" 2>/dev/null \
    | "$E/venv/bin/python" -c "import json,sys; h=json.load(sys.stdin); print(round(h['work_seconds']*h['fps']/h['slice_frames'],2))" 2>/dev/null
}
if healthy; then say "server already running (bash stop.sh first to have its size chosen again)"; else
  size="$MOST"
  while :; do
    say "starting server (she is drawn at $size pixels)"
    FLASH_SIZE="$size" setsid nohup "$E/venv/bin/python" "$HERE/server.py" >> logs/flash.log 2>&1 < /dev/null 9>&- &
    echo $! > run/flash.pid
    for i in $(seq 1 300); do healthy && break; alive flash server.py || break; sleep 1; done
    healthy || { say "server stopped while starting:"; tail -5 logs/flash.log; exit 1; }
    BUSY="$(busy)"
    [ "$size" -le "$LEAST" ] && break
    awk "BEGIN{exit !(${BUSY:-9} <= ${FLASH_BUSY_MOST:-0.9})}" && break
    # A multiple of 16, at least one step smaller, never below the least.
    next="$(awk "BEGIN{n=int($size*sqrt(0.85/${BUSY:-9})/16)*16; if(n>$size-16)n=$size-16; if(n<$LEAST)n=$LEAST; print n}")"
    say "too slow at $size pixels (GPU busy $BUSY of the time): trying $next"
    kill "$(cat run/flash.pid)" 2>/dev/null
    for i in $(seq 1 20); do alive flash server.py || break; sleep 1; done
    size="$next"
  done
fi
url() { grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' logs/flash-tunnel.log 2>/dev/null | tail -1; }
if alive flash-tunnel cloudflared && [ -n "$(url)" ]; then say "tunnel already running"; else
  say "starting tunnel"
  : > logs/flash-tunnel.log
  setsid nohup bin/cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >> logs/flash-tunnel.log 2>&1 < /dev/null 9>&- &
  echo $! > run/flash-tunnel.pid
fi
healthy || { say "server did not answer /health, see logs/flash.log"; exit 1; }
BUSY="$(busy)"
DRAWN="$(curl -fsS -m 3 -H "x-avatar-key: $KEY" "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -o '"size": *[0-9]*' | grep -o '[0-9]*$')"
say "server answers /health: she is drawn at ${DRAWN:-?} pixels, GPU busy ${BUSY:-?} of the time in a call"
command -v nvidia-smi >/dev/null 2>&1 && say "GPU memory in use: $(nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader 2>/dev/null | head -1)"
[ -f "$E/no-flash-attn" ] && say "(flash-attention does not run on this GPU: PyTorch's own attention is used)"
awk "BEGIN{exit !(${BUSY:-0} > 1)}" && say "WARNING: this GPU is slower than her voice: the stream will fall behind and the filmed clips will show"
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
