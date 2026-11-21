#!/usr/bin/env bash
# Everything that depends on the base clips. Run it again whenever a clip is replaced:
#
#   bash /workspace/avatar-gpu/build_assets.sh [WIDTHxHEIGHT]      (default 960x720)
#
# In : clips/talk.mp4 (base for speech), clips/idle.mp4, clips/think.mp4, samples/long.wav (the app's voice)
# Out: avatars/talk/ (and avatars/idle/, an alternative base for speech with a closed mouth),
#      models/closed_mouth.npy, loops/idle.mp4, loops/think.mp4, loops/poster.jpg
# Takes about three minutes. Restart the server afterwards (start.sh --restart).
set -euo pipefail
ROOT="${AVATAR_ROOT:-/workspace/avatar-gpu}"
SIZE="${1:-960x720}"
cd "$ROOT"
export HF_HOME=/tmp/hf-home
PY="$ROOT/venv/bin/python"

"$PY" prepare.py --clip talk --size "$SIZE"
"$PY" prepare.py --clip idle --size "$SIZE"
if [ -f samples/long.wav ]; then
  "$PY" calibrate_silence.py --wav samples/long.wav --clip talk
else
  echo "samples/long.wav missing: keeping the existing models/closed_mouth.npy (if any)"
fi
bash "$ROOT/make_loops.sh" "$SIZE"
