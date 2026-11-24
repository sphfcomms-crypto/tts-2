#!/usr/bin/env bash
# Her reading what you type, live, on your own NVIDIA card: no call, no rented GPU, no tunnel.
# It starts the whole-face server on this machine and opens its page:
#
#   bash live.sh --key               once per key: paste your ElevenLabs key (sk_...) or your
#                                    OpenAI key (sk-...); it is not shown nor kept in history
#   bash live.sh                     she is drawn at 512 pixels (448 or 416 if memory is short)
#   FLASH_SIZE=416 bash live.sh      smaller, so a long text waits less before she starts
#   bash live.sh --stop
#   bash live.sh --forget-key        removes the saved keys (revoke them at ElevenLabs and OpenAI too)
#
#   http://localhost:8100/live       (opened for you under WSL; any browser on this machine)
#
# On the page: type, Speak (or Ctrl+Enter). Her voice is made from the text: with the ElevenLabs
# key, by native Urdu voices on ElevenLabs' newest model (Saira, Reva); with the OpenAI key, by
# OpenAI's speech model (Marin, Coral, Shimmer, Sage), and OpenAI's transcriber also hears each
# piece of her voice back so that no word is left out; with neither, by Microsoft's free voices
# (edge-tts). All need the internet. The keys are kept in ~/tts-2-lab (elevenlabs.key,
# openai.key), readable by you only, and are sent to their own service and nowhere else. She starts
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
OPENAI_FILE="$L/openai.key"
ELEVEN_FILE="$L/elevenlabs.key"
if [ "${1:-}" = "--forget-key" ]; then
  rm -f "$OPENAI_FILE" "$ELEVEN_FILE"; echo "[live] no ElevenLabs or OpenAI key is kept here any more"; exit 0
fi
if [ "${1:-}" = "--key" ]; then
  mkdir -p "$L"
  printf 'Paste your ElevenLabs or OpenAI key (it is not shown), then press Enter: '
  IFS= read -rs k; echo
  k="$(printf '%s' "$k" | tr -d '[:space:]')"
  case "$k" in
    sk-*) f="$OPENAI_FILE"; what="OpenAI" ;;
    *) if printf '%s' "$k" | grep -Eq '^[A-Za-z0-9_]{24,}$'; then f="$ELEVEN_FILE"; what="ElevenLabs"
       else echo "[live] that does not look like an ElevenLabs key (sk_...) or an OpenAI key (sk-...): nothing saved"; exit 1; fi ;;
  esac
  (umask 077; printf '%s\n' "$k" > "$f")
  echo "[live] your $what key is saved in $f (readable by you only). Now: bash $HERE/live.sh"
  exit 0
fi
# A key already in this shell (OPENAI_API_KEY, ELEVENLABS_API_KEY) is used as it is; else the saved one.
[ -z "${OPENAI_API_KEY:-}" ] && [ -s "$OPENAI_FILE" ] && export FLASH_OPENAI_KEY_FILE="$OPENAI_FILE"
[ -z "${ELEVENLABS_API_KEY:-}" ] && [ -s "$ELEVEN_FILE" ] && export FLASH_ELEVEN_KEY_FILE="$ELEVEN_FILE"
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
  say "installing edge-tts (her free voices)"
  if [ -x "$E/uv" ]; then "$E/uv" pip install --python "$PY" -q edge-tts; else "$PY" -m pip install -q edge-tts; fi
  "$PY" -c "import edge_tts" 2>/dev/null || say "edge-tts did not install: the page can still speak voice files"
fi
# Each voice service with a key is tried once with two words, so a refused key or a blocked line
# shows now and not in front of anyone.
try_voice() {   # try_voice <voice> <service> <what the page offers>
  local out
  if out="$(cd "$HERE" && "$PY" -c 'import sys, voices; print("%.1f" % voices.selftest(sys.argv[1]))' "$1" 2>&1)"; then
    say "her $2 voice works: $3"
  else
    say "her $2 voice did NOT work: $(printf '%s' "$out" | tail -1 | cut -c1-240)"
    say "check that key (bash $HERE/live.sh --key) and the internet; her other voices still work"
  fi
}
have_eleven=0; have_openai=0
{ [ -n "${ELEVENLABS_API_KEY:-}" ] || [ -n "${FLASH_ELEVEN_KEY_FILE:-}" ]; } && have_eleven=1
{ [ -n "${OPENAI_API_KEY:-}" ] || [ -n "${FLASH_OPENAI_KEY_FILE:-}" ]; } && have_openai=1
[ "$have_eleven" = 1 ] && try_voice saira ElevenLabs "Saira (first on the page), Reva, Reva (soft)"
[ "$have_openai" = 1 ] && try_voice marin OpenAI "Marin, Coral, Shimmer, Sage; and every piece of her voice is heard back so no word is left out"
if [ "$have_eleven" = 0 ] && [ "$have_openai" = 0 ]; then
  say "no ElevenLabs or OpenAI key: only the free voices. For her natural voice: bash $HERE/live.sh --key, then this again"
elif [ "$have_openai" = 0 ]; then
  say "no OpenAI key: her ElevenLabs voice is not heard back for left-out words (bash $HERE/live.sh --key adds one)"
fi
URL="http://localhost:$PORT/live"
say "ready: $URL"
command -v explorer.exe >/dev/null 2>&1 && explorer.exe "$URL" >/dev/null 2>&1
say "to stop: bash $HERE/live.sh --stop"
