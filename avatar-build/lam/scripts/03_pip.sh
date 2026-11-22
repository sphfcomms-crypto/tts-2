#!/usr/bin/env bash
# PyTorch for CUDA 12.8 (needed by RTX 50-series cards) + LAM's Python dependencies.
set -eu
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/activate.sh"

echo "[$(date +%H:%M:%S)] torch"
pip install torch==2.7.1 torchvision==0.22.1 --index-url https://download.pytorch.org/whl/cu128

echo "[$(date +%H:%M:%S)] requirements"
pip install -r "$HERE/requirements-5070.txt"

echo "[$(date +%H:%M:%S)] chumpy (its setup.py imports pip, so it cannot build in an isolated env)"
pip install --no-build-isolation chumpy==0.70

echo "[$(date +%H:%M:%S)] FBX SDK python wheel (from LAM's export guide)"
pip install "$LAM_HOME/downloads/fbx-2020.3.4-cp310-cp310-manylinux1_x86_64.whl"

python - <<'EOF'
import torch, torchvision, numpy
print("torch", torch.__version__, "cuda", torch.version.cuda, "torchvision", torchvision.__version__, "numpy", numpy.__version__)
print("cuda available:", torch.cuda.is_available(), torch.cuda.get_device_name(0), "arch list:", torch.cuda.get_arch_list())
x = torch.randn(1024, 1024, device="cuda"); print("gpu matmul ok:", float((x @ x).abs().mean()) > 0)
EOF
echo "PIP DONE"
