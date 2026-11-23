#!/usr/bin/env bash
# Stop the whole-face server and its tunnel (nothing else on the box is touched).
L="${FLASH_ROOT:-/workspace/tts-2-lab}"
for part in flash flash-tunnel; do
  pid="$(cat "$L/run/$part.pid" 2>/dev/null)"
  [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo "stopped $part"
  rm -f "$L/run/$part.pid"
done
