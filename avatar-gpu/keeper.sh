#!/usr/bin/env bash
# Started by start.sh. Looks every 20 s whether the server and the tunnel are still alive and runs
# start.sh again if one of them is gone (a new tunnel gets a new address, which start.sh registers).
ROOT="${AVATAR_ROOT:-/workspace/avatar-gpu}"
cd "$ROOT" || exit 1
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
done
