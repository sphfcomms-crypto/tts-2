#!/usr/bin/env bash
# Stop the lip-sync server and its tunnel. (The GPU box itself keeps running and billing.)
ROOT="${AVATAR_ROOT:-/workspace/avatar-gpu}"
cd "$ROOT" || exit 0
for name in keeper tunnel server; do
  if [ -f "run/$name.pid" ]; then
    pid="$(cat "run/$name.pid")"
    case "$name" in server) pat="server.py" ;; tunnel) pat="cloudflared" ;; *) pat="keeper.sh" ;; esac
    # the pid file may be left over from an earlier box: only stop a process that is really ours
    if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q "$pat"; then
      kill "$pid" 2>/dev/null
      for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
      kill -9 "$pid" 2>/dev/null
      echo "stopped $name ($pid)"
    fi
    rm -f "run/$name.pid"
  fi
done
# anything started by hand (patterns are anchored so this script never matches itself)
pkill -f "^venv/bin/python server\.py" 2>/dev/null
pkill -f "^bin/cloudflared tunnel --no-autoupdate --url http://127\.0\.0\.1:${AVATAR_PORT:-8000}" 2>/dev/null
rm -f run/tunnel.url
echo "stopped"
