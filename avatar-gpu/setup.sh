#!/usr/bin/env bash
# One-time build of the lip-sync environment on a GPU box.
#
# Everything lands under /workspace/avatar-gpu (persistent storage): Python itself,
# the virtualenv, ffmpeg, cloudflared, the MuseTalk source and all model weights.
# A brand-new box therefore only needs start.sh. Safe to re-run: finished steps are skipped.
#
#   bash /workspace/avatar-gpu/setup.sh
set -euo pipefail

ROOT="${AVATAR_ROOT:-/workspace/avatar-gpu}"
MUSETALK_REPO="https://github.com/TMElyralab/MuseTalk.git"
MUSETALK_COMMIT="${MUSETALK_COMMIT:-}"   # empty = current default branch head

mkdir -p "$ROOT"/{bin,models,avatars,loops,logs,run,src,python,clips}
cd "$ROOT"

export UV_PYTHON_INSTALL_DIR="$ROOT/python"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uv-cache}"
export UV_LINK_MODE=copy
export UV_PYTHON_PREFERENCE=only-managed
export HF_HOME=/tmp/hf-home          # download cache only; the box image's own HF_HOME is not writable
unset HUGGINGFACE_HUB_CACHE TRANSFORMERS_CACHE
export HF_HUB_DISABLE_TELEMETRY=1
PY="$ROOT/venv/bin/python"

step() { echo; echo "=== $* ($(date +%T)) ==="; }

step "uv"
if [ ! -x bin/uv ]; then
  curl -fsSL https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz \
    | tar xz --strip-components=1 -C bin
fi
bin/uv --version

step "python 3.11 + venv"
if [ ! -x "$PY" ]; then
  bin/uv python install 3.11
  bin/uv venv --python 3.11 venv
fi
"$PY" --version

step "python packages"
if ! cmp -s requirements.txt run/.deps-ok 2>/dev/null; then
  bin/uv pip install --python "$PY" --exclude-newer 2025-03-01 -r requirements.txt
  bin/uv pip freeze --python "$PY" > requirements.lock
  cp requirements.txt run/.deps-ok
fi

step "ffmpeg (static build with NVENC and x264)"
if [ ! -x bin/ffmpeg ]; then
  url=$(curl -fsSL https://github.com/BtbN/FFmpeg-Builds/releases/expanded_assets/latest \
        | grep -o '/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n[0-9.]*-latest-linux64-gpl-[0-9.]*\.tar\.xz' \
        | sort -V | tail -1 || true)
  [ -n "$url" ] || url="/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
  echo "ffmpeg build: $url"
  rm -rf /tmp/ffmpeg-dl && mkdir -p /tmp/ffmpeg-dl
  curl -fL -o /tmp/ffmpeg-dl/ffmpeg.tar.xz "https://github.com$url"
  # the box image has no xz; Python's tarfile can read it
  "$PY" -c "import sys,tarfile; tarfile.open(sys.argv[1]).extractall(sys.argv[2])" /tmp/ffmpeg-dl/ffmpeg.tar.xz /tmp/ffmpeg-dl
  cp /tmp/ffmpeg-dl/ffmpeg-*/bin/ffmpeg /tmp/ffmpeg-dl/ffmpeg-*/bin/ffprobe bin/
  chmod +x bin/ffmpeg bin/ffprobe
  echo "$url" > bin/ffmpeg.source
  rm -rf /tmp/ffmpeg-dl
fi
bin/ffmpeg -hide_banner -version | head -1

step "cloudflared"
if [ ! -x bin/cloudflared ]; then
  curl -fL -o bin/cloudflared.tmp https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x bin/cloudflared.tmp && mv bin/cloudflared.tmp bin/cloudflared
fi
bin/cloudflared --version

step "MuseTalk source"
if [ ! -d src/MuseTalk/.git ]; then
  git clone "$MUSETALK_REPO" src/MuseTalk
  [ -z "$MUSETALK_COMMIT" ] || git -C src/MuseTalk checkout -q "$MUSETALK_COMMIT"
fi
git -C src/MuseTalk log -1 --format='MuseTalk commit %H (%cd)' --date=short
# MuseTalk's own code looks for ./models relative to its folder
[ -e src/MuseTalk/models ] || ln -s "$ROOT/models" src/MuseTalk/models

step "model weights"
hf() { "$ROOT/venv/bin/huggingface-cli" download "$@"; }
[ -f models/musetalkV15/unet.pth ] || hf TMElyralab/MuseTalk musetalkV15/musetalk.json musetalkV15/unet.pth --local-dir models
[ -f models/sd-vae/diffusion_pytorch_model.bin ] || hf stabilityai/sd-vae-ft-mse config.json diffusion_pytorch_model.bin --local-dir models/sd-vae
[ -f models/whisper/pytorch_model.bin ] || hf openai/whisper-tiny config.json pytorch_model.bin preprocessor_config.json --local-dir models/whisper

# Wav2Vec2 recognizes the contact in p, b and m on the actual voice waveform.
# Publish the optional directory only when all three pinned files are complete.
if [ -z "${AVATAR_PHONE_MODEL+x}" ]; then
  phone_revision=ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4
  phone_store="models/speech-phones-$phone_revision"
  verify_phones() {
    (cd "$1" && sha256sum --check --status <<'SHA256'
4609fb49b7e1d28aecb2840da1926c40bd915bc6f1120a940afacf7159bbfb13  config.json
d732ab2456c0c017930001dc9af0b41b3b93d25b2eb9740bf9d925508d7d87d0  vocab.json
3173bde9e9ce490fa0f989e413c42f25bc1820c020adc1e6b9b87025b3cfcc5e  pytorch_model.bin
SHA256
    )
  }
  if ! verify_phones models/speech-phones 2>/dev/null; then
    if ! { hf facebook/wav2vec2-lv-60-espeak-cv-ft config.json vocab.json pytorch_model.bin \
        --revision "$phone_revision" --local-dir "$phone_store" && verify_phones "$phone_store" && \
        ln -sfnT "${phone_store#models/}" models/speech-phones; }; then
      echo "Could not install the optional phone model. Existing files are preserved." >&2
    fi
  fi
fi
[ -f models/dwpose/dw-ll_ucoco_384.onnx ] || hf yzd-v/DWPose dw-ll_ucoco_384.onnx --local-dir models/dwpose
mkdir -p models/face-parse-bisent
[ -f models/face-parse-bisent/resnet18-5c106cde.pth ] || \
  curl -fL -o models/face-parse-bisent/resnet18-5c106cde.pth https://download.pytorch.org/models/resnet18-5c106cde.pth
if [ ! -f models/face-parse-bisent/79999_iter.pth ]; then
  # same Google Drive file MuseTalk's download_weights.sh uses; the Hugging Face copy used by
  # MuseTalk's own demo app is the fallback when Drive refuses the download
  "$ROOT/venv/bin/gdown" 154JgKpzCPW82qINcVieuPH3fZ2e0P812 -O models/face-parse-bisent/79999_iter.pth \
    || hf ManyOtherFunctions/face-parse-bisent 79999_iter.pth --local-dir models/face-parse-bisent
fi
ls -la models/musetalkV15 models/sd-vae models/whisper models/dwpose models/face-parse-bisent

step "half-precision UNet file (loads in a few seconds instead of the 3.4 GB original)"
if [ ! -f models/musetalkV15/unet_fp16.safetensors ]; then
  "$PY" - <<'EOF'
import torch
from safetensors.torch import save_file
sd = torch.load("models/musetalkV15/unet.pth", map_location="cpu", weights_only=True)
sd = {k: (v.half() if v.is_floating_point() else v) for k, v in sd.items()}
save_file(sd, "models/musetalkV15/unet_fp16.safetensors")
print("tensors:", len(sd))
EOF
fi

step "setup done"
du -sh "$ROOT" 2>/dev/null || true
echo "next: put the clips in $ROOT/clips (talk.mp4, idle.mp4, think.mp4), the voice sample in"
echo "      $ROOT/samples/long.wav and the key in $ROOT/key.txt, then run build_assets.sh and start.sh"
