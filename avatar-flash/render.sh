#!/usr/bin/env bash
# Her reading prepared texts aloud (news, speeches, meeting notes) as finished films, made on your
# own NVIDIA card: no call, no OpenAI key, no rented GPU. Nothing is live, so there is no hurry:
# she is drawn at the model's own size (512 pixels, 448 or 416 if the card has too little memory)
# and her lips are put on the sound (test_client.py --picture-lag 0.05).
#
#   bash render.sh <folder> [voice]
#
# In <folder>, each name.txt (Urdu, Hinglish or English) becomes name.mp4 (960x720, her voice in
# it). Her voice is made from the text with Microsoft's free neural voices (edge-tts, which needs
# the internet): ur-PK-UzmaNeural by default; ur-PK-AsadNeural, en-IN-NeerjaNeural and the others
# that `edge-tts --list-voices` shows also work. To use another voice, put name.wav or name.mp3 in
# the folder yourself (the app's VOICE download is one): it is used as it is, text or no text.
# A film already made is not made again: delete it to have it redone.
#
# At the end the folder also holds idle.mp4 (her listening quietly), playlist.js and player.html.
# Open player.html in Chrome: a full-screen bulletin with a LIVE mark and the time, her quiet loop
# between items, Space or the right arrow for the next item, A to play them all, F for full screen.
#
# The look is FLASH_LOOK (default anchor: the news anchor in looks/). The machine needs are those
# of home.sh: Linux or Ubuntu under WSL2, one NVIDIA card with 12 GB or more, about 27 GB under
# ~/tts-2-lab the first time (ten minutes to build, then under a minute to start).
# FLASH_RENDER_URL=http://... uses a server that is already running instead of starting one.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${1:-}"
VOICE="${2:-ur-PK-UzmaNeural}"
[ -n "$DIR" ] && [ -d "$DIR" ] || { echo "usage: bash render.sh <folder with .txt, .wav or .mp3 files> [voice]"; exit 1; }
DIR="$(cd "$DIR" && pwd)"
export FLASH_ROOT="${FLASH_ROOT:-$HOME/tts-2-lab}"
export FLASH_ENV="${FLASH_ENV:-$FLASH_ROOT/env}"
export FLASH_LOOK="${FLASH_LOOK:-anchor}"
L="$FLASH_ROOT"
E="$FLASH_ENV"
PORT="${FLASH_PORT:-8100}"
T0=$(date +%s)
say() { echo "[render $(( $(date +%s) - T0 ))s] $*"; }
mkdir -p "$L/bin" "$L/logs"
# The secret this script and the server share (made here; nothing else uses it).
[ -s "$L/key.txt" ] || (umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$L/key.txt")
KEY_FILE="$L/key.txt"

if [ -n "${FLASH_RENDER_URL:-}" ]; then
  URL="${FLASH_RENDER_URL%/}"
  KEY_FILE="${FLASH_RENDER_KEY_FILE:-$KEY_FILE}"
else
  command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1 \
    || { echo "nvidia-smi does not work in this shell: no NVIDIA GPU to draw her on (on Windows, run this inside Ubuntu under WSL2)"; exit 1; }
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | sed 's/^/GPU: /'
  URL="http://127.0.0.1:$PORT"
  KEY="$(cat "$KEY_FILE")"
  up() { curl -fsS -m 3 -H "x-avatar-key: $KEY" "$URL/health" 2>/dev/null; }
  # A server started for calls may be drawing her smaller, or in another look: start one for films.
  bash "$HERE/stop.sh" >/dev/null 2>&1
  for size in ${FLASH_SIZE:-512 448 416}; do
    say "starting the server, her drawn at $size pixels (the first time this builds everything: about ten minutes)"
    FLASH_KEY_FILE="$KEY_FILE" FLASH_SIZE="$size" FLASH_NO_TUNNEL=1 bash "$HERE/start.sh" > "$L/logs/render-start.log" 2>&1
    if up | grep -q "\"size\": *$size"; then break; fi
    tail -3 "$L/logs/render-start.log"
    say "it did not start at $size pixels (see $L/logs/flash.log); trying smaller"
    bash "$HERE/stop.sh" >/dev/null 2>&1
  done
  up >/dev/null || { say "the server did not start; see $L/logs/render-start.log and $L/logs/flash.log"; exit 1; }
fi
KEY="$(cat "$KEY_FILE")"
HEALTH="$(curl -fsS -m 5 -H "x-avatar-key: $KEY" "$URL/health")" || { say "no server at $URL"; exit 1; }
PY="${FLASH_PYTHON:-$E/venv/bin/python}"
"$PY" -c "import numpy, soundfile, soxr" 2>/dev/null || { say "$PY lacks numpy, soundfile or soxr"; exit 1; }
"$PY" - "$HEALTH" <<'PYEOF'
import json, sys
h = json.loads(sys.argv[1])
busy = h.get("work_seconds", 0) * h["fps"] / h["slice_frames"]
print("[render] server: her drawn at %s pixels in %sx%s frames, own look %s; one second of her takes %.2f s to draw"
      % (h.get("size"), h.get("width"), h.get("height"), h.get("own_look"), busy))
PYEOF

# ffmpeg: this machine's, or a static build fetched once.
FFMPEG="$(command -v ffmpeg || true)"
[ -x "$L/bin/ffmpeg" ] && FFMPEG="$L/bin/ffmpeg"
if [ -z "$FFMPEG" ]; then
  say "fetching ffmpeg (a static build, into $L/bin)"
  T="$(mktemp -d)"
  curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar xJ -C "$T" \
    && cp "$T"/ffmpeg-*-static/ffmpeg "$T"/ffmpeg-*-static/ffprobe "$L/bin/" && FFMPEG="$L/bin/ffmpeg"
  rm -rf "$T"
  [ -n "$FFMPEG" ] || { say "no ffmpeg: install it (sudo apt-get install -y ffmpeg) and run this again"; exit 1; }
fi

# Her voice from text: edge-tts, into the server's Python.
TTS="$(dirname "$PY")/edge-tts"
need_tts=0
for t in "$DIR"/*.txt; do [ -e "$t" ] || continue; n="${t%.txt}"; [ -s "$n.wav" ] || [ -s "$n.mp3" ] || need_tts=1; done
if [ "$need_tts" = 1 ] && [ ! -x "$TTS" ]; then
  say "installing edge-tts (her voice from text)"
  if [ -x "$E/uv" ]; then "$E/uv" pip install --python "$PY" -q edge-tts; else "$PY" -m pip install -q edge-tts; fi
fi

# Her quiet loop, for between items.
curl -fsS -m 30 -H "x-avatar-key: $KEY" -o "$DIR/idle.mp4" "$URL/idle.mp4" 2>/dev/null || rm -f "$DIR/idle.mp4"

# The items, in name order: every .txt, .wav or .mp3 (one item per name).
mapfile -t NAMES < <(cd "$DIR" && ls -1 -- *.txt *.wav *.mp3 2>/dev/null | grep -v -E '\.16k\.wav$' | sed -E 's/\.(txt|wav|mp3)$//' | sort -u)
[ "${#NAMES[@]}" -gt 0 ] || { say "nothing to read in $DIR (put .txt, .wav or .mp3 files there)"; exit 1; }
made=0
for name in "${NAMES[@]}"; do
  n="$DIR/$name"
  if [ -s "$n.mp4" ]; then say "$name.mp4 is already made"; continue; fi
  if [ -s "$n.wav" ]; then voice_file="$n.wav"
  elif [ -s "$n.mp3" ]; then voice_file="$n.mp3"
  else
    say "$name: her voice ($VOICE)"
    "$TTS" --voice "$VOICE" --file "$n.txt" --write-media "$n.mp3" 2> "$n.tts.log" \
      || { say "$name: no voice (see $n.tts.log; edge-tts needs the internet)"; rm -f "$n.mp3"; continue; }
    voice_file="$n.mp3"
  fi
  "$FFMPEG" -v error -y -i "$voice_file" -ac 1 -ar 16000 "$n.16k.wav" || { say "$name: could not read $voice_file"; continue; }
  seconds="$("$PY" -c 'import sys, soundfile as sf; i = sf.info(sys.argv[1]); print(round(i.frames / i.samplerate))' "$n.16k.wav")"
  say "$name: drawing her for $seconds s of speech"
  started=$(date +%s)
  if "$PY" "$HERE/test_client.py" "$URL" "$n.16k.wav" "$n.mp4.part.mp4" --key-file "$KEY_FILE" --fast \
       --picture-lag "${FLASH_PICTURE_LAG:-0.05}" --ffmpeg "$FFMPEG" > "$n.render.log" 2>&1; then
    mv "$n.mp4.part.mp4" "$n.mp4"
    made=$((made + 1))
    say "$name.mp4 made in $(( $(date +%s) - started )) s"
  else
    rm -f "$n.mp4.part.mp4"
    say "$name: drawing failed (see $n.render.log)"
    tail -3 "$n.render.log"
  fi
  rm -f "$n.16k.wav"
done

# The player.
"$PY" - "$DIR" <<'PYEOF'
import json, os, re, sys
d = sys.argv[1]
items = []
for f in sorted(os.listdir(d)):
    if not f.endswith(".mp4") or f in ("idle.mp4",) or f.endswith(".part.mp4"):
        continue
    stem = f[:-4]
    title = re.sub(r"^[0-9]+[ ._-]*", "", stem).replace("_", " ").replace("-", " ").strip()
    items.append({"file": f, "title": title})
idle = "idle.mp4" if os.path.exists(os.path.join(d, "idle.mp4")) else ""
with open(os.path.join(d, "playlist.js"), "w", encoding="utf-8") as out:
    out.write("window.ITEMS = " + json.dumps(items, ensure_ascii=False) + ";\nwindow.IDLE = " + json.dumps(idle) + ";\n")
PYEOF
cp "$HERE/player.html" "$DIR/player.html"
say "$made new film(s) in $DIR"
say "to watch: open player.html from that folder in Chrome. Under WSL: cd \"$DIR\" && explorer.exe player.html"
say "(for the day itself, copying the folder to Windows is safest, e.g. cp -r \"$DIR\" /mnt/c/Users/<you>/Desktop/)"
