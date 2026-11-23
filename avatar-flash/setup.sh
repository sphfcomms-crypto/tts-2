#!/usr/bin/env bash
# Build the whole-face server on a GPU box. Safe to run again: finished steps are skipped.
#
#   bash setup.sh        then: bash start.sh (which runs this by itself when something is missing)
#
# Two places are filled:
#   /workspace/tts-2-lab   (FLASH_ROOT)  the model's code, its weights (15 GB), her picture, logs.
#                          Persistent storage: built once, about three minutes.
#   /opt/tts-2-lab         (FLASH_ENV)   Python and its packages (8 GB), on the box's own disk.
#                          Gone when the box stops, so built on every new box: about two minutes.
#                          (Kept on the persistent storage instead, the first import on a new box
#                          took more than ten minutes: tens of thousands of small files.)
set -uo pipefail
L="${FLASH_ROOT:-/workspace/tts-2-lab}"
E="${FLASH_ENV:-/opt/tts-2-lab}"
mkdir -p "$L"/{bin,logs,inputs,models/taehv,run,server} "$E" && cd "$L"
export UV_PYTHON_INSTALL_DIR=$E/python UV_CACHE_DIR=/tmp/uv-cache-lab UV_LINK_MODE=copy UV_PYTHON_PREFERENCE=only-managed
export HF_HOME=/tmp/hf-home-lab HF_HUB_DISABLE_TELEMETRY=1
unset HUGGINGFACE_HUB_CACHE TRANSFORMERS_CACHE HF_HUB_CACHE
PY=$E/venv/bin/python
step() { echo; echo "=== $* ($(date +%T)) ==="; }

step "tools (uv, ffmpeg, cloudflared: the lip-sync box's copies when they are there)"
for tool in uv ffmpeg ffprobe cloudflared; do
  [ -x bin/$tool ] || cp /workspace/avatar-gpu/bin/$tool bin/ 2>/dev/null || true
done
[ -x bin/uv ] || curl -fsSL https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz | tar xz --strip-components=1 -C bin
[ -x bin/cloudflared ] || { curl -fL -o bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x bin/cloudflared; }
[ -x bin/ffmpeg ] || echo "bin/ffmpeg is missing: copy a static ffmpeg there (only the test client needs it)"
[ -x "$E/uv" ] || cp bin/uv "$E/uv"          # run from the box's own disk
UV=$E/uv

step "the model's code (SoulX-FlashHead, the commit this was measured with)"
[ -d SoulX-FlashHead/.git ] || { git clone -q https://github.com/Soul-AILab/SoulX-FlashHead.git && git -C SoulX-FlashHead checkout -q 9bc03de06bb0de82cd6bc477804512ae06144bf2; }

step "python 3.10 and packages, in $E"
[ -x $PY ] || { $UV python install 3.10 && (cd "$E" && $UV venv --python 3.10 venv); }
$PY -c "import torch" 2>/dev/null || $UV pip install --python $PY torch==2.7.1 torchvision==0.22.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu128
if [ ! -f "$E/deps-ok" ]; then
  # The model's own list asks for an nvidia-nccl that this PyTorch does not accept, and for a
  # demo page that is not used here. xfuser newer than 0.4.3 does not load with PyTorch 2.7.
  grep -v -E "^nvidia-nccl|^gradio|^xfuser" SoulX-FlashHead/requirements.txt > "$E/requirements-lab.txt"
  $UV pip install --python $PY -r "$E/requirements-lab.txt" "xfuser==0.4.3" "huggingface_hub[cli]" soundfile soxr scipy av fastapi uvicorn && touch "$E/deps-ok"
fi
$PY -c "import flash_attn" 2>/dev/null || $UV pip install --python $PY \
  "https://github.com/Dao-AILab/flash-attention/releases/download/v2.8.0.post2/flash_attn-2.8.0.post2+cu12torch2.7cxx11abiTRUE-cp310-cp310-linux_x86_64.whl"
$PY -c "import torch, flash_attn, xformers, xfuser; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"

step "model weights (15 GB)"
[ -d models/SoulX-FlashHead-1_3B/Model_Lite ] || $E/venv/bin/huggingface-cli download Soul-AILab/SoulX-FlashHead-1_3B --local-dir models/SoulX-FlashHead-1_3B | tail -1
[ -f models/wav2vec2-base-960h/config.json ] || $E/venv/bin/huggingface-cli download facebook/wav2vec2-base-960h --local-dir models/wav2vec2-base-960h | tail -1

step "the small decoder (TAEHV for Wan 2.1 latents, MIT licence, 45 MB)"
[ -s models/taehv/taehv.py ] || curl -fsSL -o models/taehv/taehv.py https://raw.githubusercontent.com/madebyollin/taehv/main/taehv.py
[ -s models/taehv/taew2_1.pth ] || curl -fsSL -o models/taehv/taew2_1.pth https://github.com/madebyollin/taehv/raw/main/taew2_1.pth
[ -s models/taehv/taew2_1.pth ] || echo "could not fetch the small decoder: start the server with FLASH_TAE=0 (it then needs a GPU about twice as fast)"

step "her rest picture"
# The still she is drawn from: 4:3, mouth closed, looking at the camera (1664x1248 here). Put any
# other picture at inputs/start.jpg, or name one with FLASH_PICTURE, and set FLASH_BOX to the square
# around her head and shoulders (see README.md).
[ -s inputs/start.jpg ] || curl -fsSL -o inputs/start.jpg \
  https://cdn.openart.ai/openart-uploads/production/attachment-transfers/bd4f8bc1d09a27d6777bff741e052da38d730360cde3c7aabe98d9a52c8ef044.jpg \
  || echo "could not fetch the rest picture: put one at inputs/start.jpg"

step "setup done"
