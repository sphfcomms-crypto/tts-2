#!/usr/bin/env python3
r"""Adds GET /clip/<name>.mp4 to an older copy of server.py, and to start.sh the step that copies
the clips from the app (both files in this folder).

The browser plays her body-language clips from memory and needs them whole and quickly. The app's
own line was measured slower than the clips play (150 to 235 KB/s against 200 KB/s of video), so
she froze while they loaded. The box's tunnel is many times faster, so the box serves the same
files: web/units/<name>.mp4, copied from the app by start.sh. Safe to run twice.

    python3 patch_clips.py [folder]      (default: the folder this file is in)
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
        r'''        allowed = (method == "GET" and path.startswith("/piece/")) or \
''',
        r'''        allowed = (method == "GET" and (path.startswith("/piece/") or path.startswith("/clip/"))) or \
''',
    ),
    (
        '''    its address for POST /speak (a browser), or asks for a kept piece by its secret id. Anything else''',
        '''    its address for POST /speak (a browser), or asks for a kept piece by its secret id, or for one
    of her body-language clips (the same files the app serves to anyone). Anything else''',
    ),
    (
        '''@app.post("/speak")
async def speak(''',
        '''# Her body-language clips as the browser plays them (web/units/<name>.mp4, copied from the app by
# start.sh). The app's own line was measured slower than the clips play; this one is not.
WEB_CLIPS = os.path.join(ROOT, "web", "units")


@app.get("/clip/{name}.mp4")
def clip_file(name: str):
    path = os.path.join(WEB_CLIPS, name + ".mp4")
    if not name.replace("_", "").isalnum() or not os.path.isfile(path):
        return _err(404, "no such clip")
    with open(path, "rb") as f:
        return Response(f.read(), media_type="video/mp4", headers={"Cache-Control": "public, max-age=3600"})


@app.post("/speak")
async def speak(''',
    ),
], "WEB_CLIPS")

patch("start.sh", [
    (
        '''KEY="$(cat key.txt)"
''',
        r'''KEY="$(cat key.txt)"

# --- her body-language clips as the browser plays them: copied from the app once, served by /clip ---------
SITES="${AVATAR_REGISTER_URLS:-}"
[ -z "$SITES" ] && [ -f register_urls.txt ] && SITES="$(grep -v '^#' register_urls.txt | tr '\n' ' ')"
mkdir -p web/units
for r in $SITES; do
  base="${r%/api/avatar/register}"
  names="$(curl -fsS -m 20 "$base/avatar/video/units.json" 2>/dev/null | grep -o '"name": *"[a-z_0-9]*"' | grep -o '[a-z_0-9]*"$' | tr -d '"')"
  for n in $names; do
    [ -s "web/units/$n.mp4" ] && continue
    curl -fsS -m 120 -o "web/units/$n.mp4.part" "$base/avatar/video/units/$n.mp4" 2>/dev/null \
      && mv "web/units/$n.mp4.part" "web/units/$n.mp4" && say "fetched clip $n"
  done
  [ -n "$names" ] && break
done
rm -f web/units/*.part
''',
    ),
], "web/units")
