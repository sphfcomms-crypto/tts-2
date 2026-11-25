#!/usr/bin/env bash
# A whole day of the news anchor on your own NVIDIA card, in one command, at no cost:
#
#   bash demo.sh [folder] [voice]        folder: ~/bulletin by default; voice: ur-PK-UzmaNeural
#
# 1. Every text in the folder (name.txt, numbered for their order: 01-..., 02-...) becomes a finished
#    film in her voice (render.sh): drawn at the best size, so on the day there is no waiting.
#    player.html in that folder plays them as a live bulletin (Space: next, A: all, F: full screen).
# 2. Then the live page starts (live.sh, http://localhost:8100/live): anything typed there she says
#    too, after a wait that depends on the card for long texts.
# Run it the evening before: the first time it also builds everything (about 27 GB, ten minutes or
# more with a slow line). Run it again after adding texts: films already made are kept.
# FLASH_LIVE_SIZE=416 makes the live page draw her smaller, so typed texts wait less.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${1:-$HOME/bulletin}"
VOICE="${2:-ur-PK-UzmaNeural}"
mkdir -p "$DIR"
# A folder with nothing to read in it (just made, or made empty by hand) gets the three samples.
has_items() { local f; for f in "$1"/*.txt "$1"/*.wav "$1"/*.mp3; do [ -e "$f" ] && return 0; done; return 1; }
if ! has_items "$DIR"; then
  cp "$HERE"/samples/*.txt "$DIR"/
  echo "[demo] $DIR had nothing to read: put the three sample texts there; add your own .txt files too (01-..., 02-...)"
fi
echo "[demo] 1 of 2: films of the texts in $DIR"
# Even when no film could be made (no internet for her voice, say), the live page still starts.
bash "$HERE/render.sh" "$DIR" "$VOICE" || echo "[demo] the films could not all be made: see the lines above; the live page starts anyway"
echo "[demo] 2 of 2: the live page"
FLASH_SIZE="${FLASH_LIVE_SIZE:-}" bash "$HERE/live.sh" || { echo "[demo] the live page did not start: the films still play from $DIR/player.html"; exit 1; }
command -v explorer.exe >/dev/null 2>&1 && (cd "$DIR" && explorer.exe player.html >/dev/null 2>&1)
cat <<EOF
[demo] ready
  the bulletin:   $DIR/player.html   (Space: next item, A: all of them, F: full screen)
  live typing:    http://localhost:8100/live
  to stop:        bash $HERE/live.sh --stop
EOF
