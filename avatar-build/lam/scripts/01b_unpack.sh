#!/usr/bin/env bash
# Unpacks what 01_download.sh fetched: LAM's assets and tracking models into the repo,
# the export template into assets/, Blender next to it. Safe to run again.
set -eu
LAM_HOME="$HOME/lam"
DL="$LAM_HOME/downloads"
cd "$LAM_HOME/LAM"
# sample inputs and driving motions (the tar carries macOS resource-fork files: skip them)
tar -xf "$DL/LAM_assets.tar" --exclude='._*' --exclude='.DS_Store' --no-same-owner
# face-tracking models + FLAME head model -> model_zoo/
tar -xf "$DL/thirdparty_models.tar" --no-same-owner
# template_file.fbx + animation.glb for the chatting-avatar export -> assets/sample_oac/
tar -xf "$DL/sample_oac.tar" -C assets/ --no-same-owner
# Blender 4.0.2 (the version LAM's export guide names)
mkdir -p "$LAM_HOME/blender"
tar -xf "$DL/blender-4.0.2-linux-x64.tar.xz" -C "$LAM_HOME/blender" --no-same-owner
"$LAM_HOME/blender/blender-4.0.2-linux-x64/blender" --background --version | head -1
ls model_zoo/flame_tracking_models model_zoo/human_parametric_models assets/sample_oac
echo "UNPACK DONE"
