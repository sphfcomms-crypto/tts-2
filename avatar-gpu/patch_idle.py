#!/usr/bin/env python3
"""Adds the idle switch-off to an older copy of server.py and keeper.sh (both in this folder).

The box bills by the hour whether she speaks or not. With this, the server remembers when someone
last made her speak and reports it in /health as "idle_seconds"; keeper.sh stops the server and the
tunnel after AVATAR_IDLE_MINUTES of silence (default 30, 0 = never). A box with nothing running
pauses by itself, and billing ends. Safe to run twice.

    python3 patch_idle.py [folder]      (default: the folder this file is in)
"""
import os
import sys

root = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))


def patch(name, steps, done_mark):
    path = os.path.join(root, name)
    with open(path, encoding="utf-8", newline="") as f:
        text = f.read()
    if done_mark in text:
        print(f"{name}: already patched")
        return
    for old, new in steps:
        if text.count(old) != 1:
            sys.exit(f"{name}: expected exactly one place to change, found {text.count(old)}:\n{old}")
        text = text.replace(old, new)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    print(f"{name}: patched")


patch("server.py", [
    (
        'KEY = load_key()\nENGINE = None\n',
        'KEY = load_key()\nENGINE = None\n'
        '# When someone last made her speak. The box bills by the hour whether she speaks or not, so\n'
        '# /health reports how long she has been silent ("idle_seconds") and keeper.sh stops everything\n'
        '# after AVATAR_IDLE_MINUTES of that; the box then pauses by itself and billing ends.\n'
        'LAST_USED = time.time()\n',
    ),
    (
        '"gpu_memory": e.gpu_memory(), "uptime_seconds": round(time.time() - e.started)}',
        '"gpu_memory": e.gpu_memory(), "uptime_seconds": round(time.time() - e.started),\n'
        '            "idle_seconds": round(time.time() - LAST_USED)}',
    ),
    (
        '                keep_piece: int = Query(0, alias="keep")):\n    e = ENGINE\n',
        '                keep_piece: int = Query(0, alias="keep")):\n'
        '    global LAST_USED\n    LAST_USED = time.time()\n    e = ENGINE\n',
    ),
    (
        'def _startup():\n    global ENGINE\n    ENGINE = Engine()\n',
        'def _startup():\n    global ENGINE, LAST_USED\n    ENGINE = Engine()\n'
        '    LAST_USED = time.time()          # the idle clock starts when she is ready, not while loading\n',
    ),
], "LAST_USED")

patch("keeper.sh", [
    (
        'cd "$ROOT" || exit 1\n',
        'cd "$ROOT" || exit 1\n'
        '# Minutes of nobody making her speak after which everything is stopped (0 = never). The box\n'
        '# then has nothing running, pauses by itself, and billing ends. Set in server.env.\n'
        'IDLE_MIN="${AVATAR_IDLE_MINUTES:-30}"\n',
    ),
    (
        '    AVATAR_KEEPER=0 bash "$ROOT/start.sh" 2>&1 | tail -3\n  fi\n',
        '    AVATAR_KEEPER=0 bash "$ROOT/start.sh" 2>&1 | tail -3\n  fi\n'
        '  if [ "$IDLE_MIN" != "0" ]; then\n'
        '    idle="$(curl -fsS -m 3 -H "x-avatar-key: $(cat key.txt)" "http://127.0.0.1:${AVATAR_PORT:-8000}/health" 2>/dev/null \\\n'
        '            | grep -o \'"idle_seconds":[0-9]*\' | cut -d: -f2)"\n'
        '    if [ -n "$idle" ] && [ "$idle" -ge $(( IDLE_MIN * 60 )) ]; then\n'
        '      echo "$(date +%FT%T) nobody has made her speak for ${idle}s: stopping (the box pauses by itself)"\n'
        '      setsid nohup bash "$ROOT/stop.sh" >> logs/keeper.log 2>&1 < /dev/null &\n'
        '      exit 0\n'
        '    fi\n'
        '  fi\n',
    ),
], "IDLE_MIN")
