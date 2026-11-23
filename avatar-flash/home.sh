#!/usr/bin/env bash
# Her whole face in a live call, drawn on your own machine instead of a rented GPU box.
#
#   bash home.sh <address of a running copy of the app> [branch]
#   bash home.sh --stop
#
# Needs one NVIDIA card with 12 GB or more, on Linux or on Ubuntu under WSL2 on Windows. She is
# drawn at the size the card keeps up with: 416 pixels on an L40S, smaller and less sharp on a
# slower card. Several cards in different machines cannot share one call.
#
# It builds what is missing (about 27 GB under ~/tts-2-lab: the model 17, Python 8, the app 2; ten
# minutes the first time, then under a minute), starts the video server, builds and starts the
# app, and prints its link:
#
#   APP_URL=https://....trycloudflare.com
#
# The link works from any phone or computer for as long as this machine and this program run. The
# routes that need the OpenAI key are passed on to the copy of the app named in the first argument,
# so no key is needed here. Nothing outside ~/tts-2-lab is changed.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export FLASH_ROOT="${FLASH_ROOT:-$HOME/tts-2-lab}"
export FLASH_ENV="${FLASH_ENV:-$FLASH_ROOT/env}"
export PREVIEW_DIR="${PREVIEW_DIR:-$FLASH_ROOT/preview}"
if [ "${1:-}" = "--stop" ]; then
  bash "$HERE/preview.sh" --stop; bash "$HERE/stop.sh"; exit 0
fi
case "${1:-}" in
  https://*) export PREVIEW_UPSTREAM="${1%/}" ;;
  *) echo "usage: bash home.sh https://<a running copy of the app> [branch]"; exit 1 ;;
esac

missing=""
for tool in git curl tar flock awk; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
[ -z "$missing" ] || { echo "missing:$missing   (Ubuntu: sudo apt-get install -y git curl tar util-linux gawk)"; exit 1; }
if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi >/dev/null 2>&1; then
  echo "nvidia-smi does not work in this shell, so there is no NVIDIA GPU to draw her on."
  echo "On Windows: install the NVIDIA driver on Windows itself, then run this inside Ubuntu (wsl --install -d Ubuntu)."
  exit 1
fi
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | sed 's/^/GPU: /'
mkdir -p "$FLASH_ROOT"
FREE=$(df -Pk "$FLASH_ROOT" | awk 'NR==2{print int($4/1048576)}')
[ -d "$FLASH_ROOT/models/SoulX-FlashHead-1_3B" ] || [ "$FREE" -ge 30 ] || { echo "only $FREE GB free under $FLASH_ROOT; the first build needs 30"; exit 1; }
curl -fsS -m 15 -o /dev/null "$PREVIEW_UPSTREAM/" || { echo "$PREVIEW_UPSTREAM does not answer from here: the call itself would not start"; exit 1; }

exec bash "$HERE/preview.sh" "${2:-feature/urdu-hinglish-avatar-sync}"
