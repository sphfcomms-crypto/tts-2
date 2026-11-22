#!/usr/bin/env bash
# Builds the CUDA extensions LAM needs against torch 2.7.1 + CUDA 12.8 (there are no prebuilt
# wheels for this combination). Sources are the git repositories LAM's requirements.txt names.
set -eu
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/activate.sh"
SRC="$LAM_HOME/src"
mkdir -p "$SRC"
cd "$SRC"

clone() {  # clone <url> <dir> [extra git args...]
  local url="$1" dir="$2"; shift 2
  if [ ! -d "$dir/.git" ]; then git clone "$@" "$url" "$dir"; fi
  echo "    $dir @ $(git -C "$dir" rev-parse HEAD)"
}

echo "[$(date +%H:%M:%S)] pytorch3d"
clone https://github.com/facebookresearch/pytorch3d.git pytorch3d
pip install --no-build-isolation --no-deps ./pytorch3d

echo "[$(date +%H:%M:%S)] diff-gaussian-rasterization (ashawkey fork, with its glm submodule)"
clone https://github.com/ashawkey/diff-gaussian-rasterization diff-gaussian-rasterization --recursive
pip install --no-build-isolation --no-deps ./diff-gaussian-rasterization

echo "[$(date +%H:%M:%S)] nvdiffrast (ShenhanQian fork, backface-culling branch)"
clone https://github.com/ShenhanQian/nvdiffrast nvdiffrast -b backface-culling
pip install --no-build-isolation --no-deps ./nvdiffrast

echo "[$(date +%H:%M:%S)] FaceBoxesV2 cython NMS (LAM's own make.sh)"
cd "$LAM_HOME/LAM/external/landmark_detection/FaceBoxesV2/utils"
python build.py build_ext --inplace
cd "$SRC"

echo "[$(date +%H:%M:%S)] import check"
python "$HERE/check_build.py"
echo "BUILD DONE"
