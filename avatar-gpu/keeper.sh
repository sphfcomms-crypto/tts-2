#!/usr/bin/env bash
# Started by start.sh. Looks every 20 s whether the server and the tunnel are still alive and runs
# start.sh again if one of them is gone (a new tunnel gets a new address, which start.sh registers).
ROOT="${AVATAR_ROOT:-/workspace/avatar-gpu}"
cd "$ROOT" || exit 1
# Minutes of nobody making her speak after which everything is stopped (0 = never). The box
# then has nothing running, pauses by itself, and billing ends. Set in server.env.
IDLE_MIN="${AVATAR_IDLE_MINUTES:-30}"
alive() {
  local pid pat
  case "$1" in server) pat="server.py" ;; *) pat="cloudflared" ;; esac
  pid="$(cat "run/$1.pid" 2>/dev/null)" || return 1
  [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q "$pat"
}
while sleep 20; do
  [ -f run/keeper.pid ] && [ "$(cat run/keeper.pid)" = "$$" ] || exit 0     # stop.sh or a newer keeper took over
  if ! alive server || ! alive tunnel; then
    echo "$(date +%FT%T) server or tunnel gone: starting again"
    AVATAR_KEEPER=0 bash "$ROOT/start.sh" 2>&1 | tail -3
  fi
  if [ "$IDLE_MIN" != "0" ]; then
    idle="$(curl -fsS -m 3 -H "x-avatar-key: $(cat key.txt)" "http://127.0.0.1:${AVATAR_PORT:-8000}/health" 2>/dev/null \
            | grep -o '"idle_seconds":[0-9]*' | cut -d: -f2)"
    if [ -n "$idle" ] && [ "$idle" -ge $(( IDLE_MIN * 60 )) ]; then
      echo "$(date +%FT%T) nobody has made her speak for ${idle}s: stopping (the box pauses by itself)"
      setsid nohup bash "$ROOT/stop.sh" >> logs/keeper.log 2>&1 < /dev/null &
      exit 0
    fi
  fi
done
