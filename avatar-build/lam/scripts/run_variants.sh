#!/usr/bin/env bash
# Runs the two input variations one after the other (preview only, no ZIP), for comparison with the main run.
set -u
source "$HOME/lam/scripts/activate.sh"
V=/mnt/c/Users/SPHF/openai-fm/avatar-build/video
python "$LAM_HOME/scripts/make_variants.py" "$V/call-still.png" "$V/units/body-still.png" "$LAM_HOME/inputs"
for v in call-still-tight body-still-crop; do
  echo "=== $v"
  "$LAM_HOME/make_avatar.sh" "$LAM_HOME/inputs/$v.png" "$LAM_HOME/runs/$v/avatar.zip" \
      --out_dir "$LAM_HOME/runs/$v/out" --work "$LAM_HOME/work/var" \
      --motion Look_In_My_Eyes --max_frames 300 --no_zip
done
echo "VARIANTS DONE"
