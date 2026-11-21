#!/usr/bin/env bash
# Build the two loops the browser plays by itself when she is not speaking, plus the poster.
#
#   bash /workspace/avatar-gpu/make_loops.sh [WIDTHxHEIGHT]        (default 960x720)
#
# In : clips/idle.mp4, clips/think.mp4
# Out: loops/idle.mp4, loops/think.mp4, loops/poster.jpg
#
# Each loop is the clip played forwards then backwards (the two turning frames are not repeated),
# so it restarts without a jump. Every source frame is used once per direction and simply shown
# at 25 fps (a 24 fps clip plays 4 % faster; nothing is duplicated or blended). Scaling uses the
# same filter as prepare.py, so the loops and the speaking video are pixel-aligned.
set -euo pipefail
ROOT="${AVATAR_ROOT:-/workspace/avatar-gpu}"
FF="$ROOT/bin/ffmpeg"; FP="$ROOT/bin/ffprobe"
SIZE="${1:-960x720}"; W="${SIZE%x*}"; H="${SIZE#*x}"
KBPS="${LOOP_KBPS:-2000}"
mkdir -p "$ROOT/loops"; cd "$ROOT"

for name in idle think; do
  src="clips/$name.mp4"
  n=$("$FP" -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "$src")
  # frames 0..n-1 forwards, then n-2..1 backwards = 2n-2 frames
  # setparams only labels the frames (the clips carry no colour tags). Without it ffmpeg takes the
  # untagged input for BT.601 and converts the pixels to the BT.709 asked for on the output,
  # which shifts every colour a little against the speaking video.
  graph="[0:v]setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv,scale=${W}:${H}:flags=lanczos+accurate_rnd,split[f][b];[b]reverse,select='between(n,1,$((n-2)))'[r];[f][r]concat=n=2:v=1:a=0,setpts=N/(25*TB)[v]"
  common=(-map "[v]" -an -r 25 -c:v libx264 -preset slow -profile:v high -pix_fmt yuv420p
          -b:v "${KBPS}k" -maxrate "$((KBPS*3/2))k" -bufsize "$((KBPS*2))k" -g 50 -bf 2
          -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv)
  "$FF" -v error -y -i "$src" -filter_complex "$graph" "${common[@]}" -pass 1 -passlogfile "/tmp/loop-$name" -f null /dev/null
  "$FF" -v error -y -i "$src" -filter_complex "$graph" "${common[@]}" -pass 2 -passlogfile "/tmp/loop-$name" \
        -movflags +faststart "loops/$name.mp4"
  echo "$name: $n source frames -> $("$FP" -v error -select_streams v:0 -count_frames \
        -show_entries stream=nb_read_frames,width,height,r_frame_rate,bit_rate,duration -of csv=p=0 "loops/$name.mp4")"
done

# poster = first frame of idle, converted with the same BT.709 maths the videos are tagged with
"$FF" -v error -y -i clips/idle.mp4 -frames:v 1 \
  -vf "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv,scale=${W}:${H}:flags=lanczos+accurate_rnd,scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24" /tmp/poster.png
"$FF" -v error -y -i /tmp/poster.png -frames:v 1 -q:v 2 loops/poster.jpg
ls -la loops
