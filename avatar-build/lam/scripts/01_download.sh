#!/usr/bin/env bash
# Downloads everything LAM needs into ~/lam (weights, assets, Blender, FBX wheel, export template).
# Sources: huggingface.co/3DAIGC, download.blender.org, and the two files LAM's AVATAR_EXPORT_GUIDE.md names.
set -u
LAM_HOME="$HOME/lam"
DL="$LAM_HOME/downloads"
REPO="$LAM_HOME/LAM"
mkdir -p "$DL" "$REPO/model_zoo/lam_models/releases/lam/lam-20k/step_045500"

get() {  # get <url> <dest>
  local url="$1" dest="$2"
  echo "[$(date +%H:%M:%S)] GET $url"
  curl -L --fail --retry 5 --retry-delay 5 -C - -sS -o "$dest" "$url"
  local rc=$?
  echo "[$(date +%H:%M:%S)] rc=$rc $(ls -la "$dest" 2>/dev/null | awk '{print $5}') bytes  $dest"
  return $rc
}

HF=https://huggingface.co/3DAIGC
OSS=https://virutalbuy-public.oss-cn-hangzhou.aliyuncs.com/share/aigc3d/data/LAM

get "$OSS/fbx-2020.3.4-cp310-cp310-manylinux1_x86_64.whl" "$DL/fbx-2020.3.4-cp310-cp310-manylinux1_x86_64.whl"
get "$OSS/sample_oac.tar" "$DL/sample_oac.tar"
get "https://download.blender.org/release/Blender4.0/blender-4.0.2-linux-x64.tar.xz" "$DL/blender-4.0.2-linux-x64.tar.xz"
get "$HF/LAM-assets/resolve/main/README.md" "$DL/LAM-assets-README.md"
get "$HF/LAM-assets/resolve/main/LAM_assets.tar" "$DL/LAM_assets.tar"
get "$HF/LAM-assets/resolve/main/thirdparty_models.tar" "$DL/thirdparty_models.tar"
get "$HF/LAM-20K/resolve/main/config.json" "$REPO/model_zoo/lam_models/releases/lam/lam-20k/step_045500/config.json"
get "$HF/LAM-20K/resolve/main/README.md" "$DL/LAM-20K-README.md"
get "$HF/LAM-20K/resolve/main/model.safetensors" "$REPO/model_zoo/lam_models/releases/lam/lam-20k/step_045500/model.safetensors"
echo "ALL DOWNLOADS DONE"
