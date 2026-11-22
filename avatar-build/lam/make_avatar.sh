#!/usr/bin/env bash
# Build one LAM Gaussian-head avatar from one picture and export the ZIP the WebGL renderer loads.
#
#   ~/lam/make_avatar.sh <image> <out.zip> [--out_dir DIR] [--motion NAME] [--max_frames N] [--name NAME]
#
# Run it inside WSL (Ubuntu-22.04). From Windows:
#   wsl -d Ubuntu-22.04 -e bash -lc '~/lam/make_avatar.sh /mnt/c/path/photo.png /mnt/c/path/avatar.zip --out_dir /mnt/c/path/preview'
#
# <image>    head-and-shoulders picture, face to the camera (png/jpg). Windows paths (C:\...) are accepted.
# <out.zip>  avatar for gaussian-splat-renderer-for-lam: <name>/skin.glb, offset.ply, animation.glb, vertex_order.json
# --out_dir  where the model's own preview goes: preview.mp4, contact-sheet.jpg, input-cropped.png, run-report.json
#            (default: ~/lam/work/<name>/out)
# --motion   which sample motion drives the preview (folder name in ~/lam/LAM/assets/sample_motion/export)
set -eu
if [ $# -lt 2 ]; then
  sed -n '2,13p' "$0"
  exit 2
fi
source "$HOME/lam/scripts/activate.sh"

to_unix() {  # accept C:\... or C:/... as well as /mnt/c/...
  case "$1" in
    [A-Za-z]:\\*|[A-Za-z]:/*) wslpath -u "$1" ;;
    *) printf '%s\n' "$1" ;;
  esac
}
IMG="$(readlink -f "$(to_unix "$1")")"
ZIP="$(readlink -m "$(to_unix "$2")")"
shift 2
[ -f "$IMG" ] || { echo "no such image: $IMG" >&2; exit 1; }

exec python "$LAM_HOME/scripts/lam_avatar.py" "$IMG" "$ZIP" "$@"
