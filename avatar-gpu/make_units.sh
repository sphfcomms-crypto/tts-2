#!/usr/bin/env bash
# Body-language units: short clips of her that all start and end in the same seated pose, so the
# app can play any one after any other and ask /speak for the mouth on whichever one is playing.
#
#   bash make_units.sh prepare [name ...]                on the GPU box: prepare.py for each unit
#   bash make_units.sh web SRC_DIR OUT_DIR [name ...]    anywhere with ffmpeg (the PC): the files the
#                                                        browser plays, plus OUT_DIR/../units.json
#
# Without names every unit in UNITS below is done.
#
# prepare  In : clips/units/<name>.mp4   (not clips/<name>.mp4: clips/think.mp4 is the old think
#                                          loop that make_loops.sh reads)
#          Out: avatars/<name>/          restart the server afterwards, it lists them in /health
# web      In : SRC_DIR/<name>.mp4       the same source files
#          Out: OUT_DIR/<name>.mp4       960x720, 25 fps, forwards only: frame k is source frame k
#                                        (a 24 fps clip plays 4 % faster; nothing is duplicated or
#                                        blended), so it is the same picture as frame k of the
#                                        prepared clip, i.e. of /speak?clip=<name>&start=k
#               OUT_DIR/../units.json    {"fps","width","height","units":[{"name","frames","pool"}]}
#
# Colour handling and scaler are those of make_loops.sh and prepare.py. No B-frames (first frame
# at time 0, no edit list) and a keyframe every 25 frames.
set -euo pipefail
UNITS="listen_still listen_nod talk_open talk_right talk_chest talk_shrug greet think"
SIZE="${UNIT_SIZE:-960x720}"; W="${SIZE%x*}"; H="${SIZE#*x}"
KBPS="${UNIT_KBPS:-1600}"

pool_of() {
  case "$1" in
    listen_*) echo listen ;;
    talk_*) echo talk ;;
    *) echo "${1%%_*}" ;;
  esac
}

mode="${1:-}"; [ $# -gt 0 ] && shift
case "$mode" in
  prepare)
    ROOT="${AVATAR_ROOT:-/workspace/avatar-gpu}"
    cd "$ROOT"
    export HF_HOME=/tmp/hf-home
    names=("$@"); [ ${#names[@]} -eq 0 ] && names=($UNITS)
    for name in "${names[@]}"; do
      "$ROOT/venv/bin/python" prepare.py --clip "$name" --video "clips/units/$name.mp4" --size "$SIZE"
    done
    ;;
  web)
    SRC="$1"; OUT="$2"; shift 2
    names=("$@"); [ ${#names[@]} -eq 0 ] && names=($UNITS)
    FF="${FF:-ffmpeg}"; FP="${FP:-ffprobe}"
    TMP="$(mktemp -d)"
    mkdir -p "$OUT"
    list=""
    for name in "${names[@]}"; do
      src="$SRC/$name.mp4"
      n=$("$FP" -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "$src" | tr -d '\r')
      # setparams only labels the frames (the clips carry no colour tags); see make_loops.sh
      graph="[0:v]setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv,scale=${W}:${H}:flags=lanczos+accurate_rnd,setpts=N/(25*TB)[v]"
      common=(-map "[v]" -an -r 25 -c:v libx264 -preset slow -profile:v high -pix_fmt yuv420p
              -b:v "${KBPS}k" -maxrate "$((KBPS*3/2))k" -bufsize "$((KBPS*2))k"
              -g 25 -keyint_min 25 -sc_threshold 0 -bf 0
              -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv)
      "$FF" -v error -y -i "$src" -filter_complex "$graph" "${common[@]}" -pass 1 -passlogfile "$TMP/$name" -f null -
      "$FF" -v error -y -i "$src" -filter_complex "$graph" "${common[@]}" -pass 2 -passlogfile "$TMP/$name" \
            -movflags +faststart "$OUT/$name.mp4"
      m=$("$FP" -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "$OUT/$name.mp4" | tr -d '\r')
      [ "$m" = "$n" ] || { echo "$name: $n source frames but $m in the unit file"; exit 1; }
      echo "$name: $n frames, pool $(pool_of "$name")"
      list="$list${list:+, }{\"name\": \"$name\", \"frames\": $n, \"pool\": \"$(pool_of "$name")\"}"
    done
    rm -rf "$TMP"
    printf '{"fps": 25, "width": %s, "height": %s, "units": [%s]}\n' "$W" "$H" "$list" > "$OUT/../units.json"
    cat "$OUT/../units.json"
    ;;
  *)
    sed -n '2,22p' "$0"; exit 1 ;;
esac
