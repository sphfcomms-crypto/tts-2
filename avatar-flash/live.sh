#!/usr/bin/env bash
# Her reading what you type, live, on your own NVIDIA card: no call, no OpenAI key, no rented GPU,
# no tunnel. It starts the whole-face server on this machine and opens its page:
#
#   bash live.sh                     she is drawn at 512 pixels (448 or 416 if memory is short)
#   FLASH_SIZE=416 bash live.sh      smaller, so a long text waits less before she starts
#   bash live.sh --stop
#
#   http://localhost:8100/live       (opened for you under WSL; any browser on this machine)
#
# On the page: type, Speak (or Ctrl+Enter). Her voice is made from the text with Microsoft's free
# neural voices (edge-tts: the internet is needed), and her pictures one slice at a time. She starts
# speaking once enough is drawn that she will not have to stop: at once on a fast card, after a
# while on a slow one for a long text (the list shows how long), and she sits in her quiet loop
# meanwhile. Untick "speak as soon as ready" to prepare texts and play each with its button.
# F: full screen; T: the panel in full screen.
#
# The look is FLASH_LOOK (default anchor). Machine needs as home.sh: Linux or Ubuntu under WSL2,
# one NVIDIA card with 12 GB or more, about 27 GB under ~/tts-2-lab the first time.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export FLASH_ROOT="${FLASH_ROOT:-$HOME/tts-2-lab}"
export FLASH_ENV="${FLASH_ENV:-$FLASH_ROOT/env}"
export FLASH_LOOK="${FLASH_LOOK:-anchor}"
L="$FLASH_ROOT"
E="$FLASH_ENV"
PORT="${FLASH_PORT:-8100}"
if [ "${1:-}" = "--stop" ]; then bash "$HERE/stop.sh"; exit 0; fi
T0=$(date +%s)
say() { echo "[live $(( $(date +%s) - T0 ))s] $*"; }
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1 \
  || { echo "nvidia-smi does not work in this shell: no NVIDIA GPU to draw her on (on Windows, run this inside Ubuntu under WSL2)"; exit 1; }
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | sed 's/^/GPU: /'
mkdir -p "$L/bin" "$L/logs"
[ -s "$L/key.txt" ] || (umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$L/key.txt")
KEY="$(cat "$L/key.txt")"
up() { curl -fsS -m 3 -H "x-avatar-key: $KEY" "http://127.0.0.1:$PORT/health" 2>/dev/null; }

# A server started for calls has a tunnel and no page: start one for this.
bash "$HERE/stop.sh" >/dev/null 2>&1
for size in ${FLASH_SIZE:-512 448 416}; do
  say "starting the server, her drawn at $size pixels (the first time this builds everything: about ten minutes)"
  FLASH_KEY_FILE="$L/key.txt" FLASH_SIZE="$size" FLASH_NO_TUNNEL=1 FLASH_LIVE_PAGE=1 bash "$HERE/start.sh" > "$L/logs/live-start.log" 2>&1
  if up | grep -q "\"size\": *$size"; then break; fi
  tail -3 "$L/logs/live-start.log"
  say "it did not start at $size pixels (see $L/logs/flash.log); trying smaller"
  bash "$HERE/stop.sh" >/dev/null 2>&1
done
HEALTH="$(up)" || { say "the server did not start; see $L/logs/live-start.log and $L/logs/flash.log"; exit 1; }
PY="$E/venv/bin/python"
"$PY" - "$HEALTH" <<'PYEOF'
import json, sys
h = json.loads(sys.argv[1])
busy = h.get("work_seconds", 0) * h["fps"] / h["slice_frames"]
wait = max(0.0, 10 * (busy - 1))
print("[live] her drawn at %s pixels; one second of her takes %.2f s to draw on this card" % (h.get("size"), busy))
print("[live] so a 10-second text starts after about %.0f s, a minute-long one after about %.0f s" % (max(2, wait + 2), max(2, 6 * wait + 2)))
PYEOF
if ! "$PY" -c "import edge_tts" 2>/dev/null; then
  say "installing edge-tts (her voice from text)"
  if [ -x "$E/uv" ]; then "$E/uv" pip install --python "$PY" -q edge-tts; else "$PY" -m pip install -q edge-tts; fi
  "$PY" -c "import edge_tts" 2>/dev/null || say "edge-tts did not install: the page can still speak voice files"
fi
URL="http://localhost:$PORT/live"
say "ready: $URL"
command -v explorer.exe >/dev/null 2>&1 && explorer.exe "$URL" >/dev/null 2>&1
say "to stop: bash $HERE/live.sh --stop"
