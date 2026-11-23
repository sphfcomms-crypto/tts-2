#!/usr/bin/env bash
# Try a branch of the app with the whole-face server before it is deployed: build and run the app
# itself on the GPU box, behind its own public link. Safe to run again (it rebuilds only when the
# branch has moved).
#
#   bash preview.sh [branch]         last lines: APP_URL=https://....trycloudflare.com
#   bash preview.sh --stop
#
# The page, her clips and the whole-face video come from this box. What needs the OpenAI key (the
# call itself, Play, transcripts) is passed on to a copy of the app that has it: PREVIEW_UPSTREAM,
# or else the first site the lip-sync box registers with. No key of any kind is put on this box
# except the shared secret between the app and the video server, and for a preview that is a
# random one made here (FLASH_ROOT/key.txt).
#
# The link lives as long as the box does. It is a preview, not a deployment: nothing restarts it.
set -uo pipefail
L="${FLASH_ROOT:-/workspace/tts-2-lab}"
P="${PREVIEW_DIR:-/opt/tts-2-preview}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${PREVIEW_REPO:-https://github.com/sphfcomms-crypto/tts-2}"
PORT="${PREVIEW_PORT:-3190}"
mkdir -p "$P" "$L/logs"
stop() { local pid; pid="$(cat "$P/$1.pid" 2>/dev/null)"; [ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -f "$P/$1.pid"; }
if [ "${1:-}" = "--stop" ]; then stop app; stop tunnel; echo "preview stopped"; exit 0; fi
BRANCH="${1:-feature/urdu-hinglish-avatar-sync}"
T0=$(date +%s); say() { echo "[preview $(( $(date +%s) - T0 ))s] $*"; }

UPSTREAM="${PREVIEW_UPSTREAM:-}"
if [ -z "$UPSTREAM" ] && [ -f /workspace/avatar-gpu/register_urls.txt ]; then
  UPSTREAM="$(grep -v '^#' /workspace/avatar-gpu/register_urls.txt | head -1 | sed -E 's#(https://[^/]*).*#\1#')"
fi
[ -n "$UPSTREAM" ] || { echo "set PREVIEW_UPSTREAM to the address of a running copy of the app (it holds the OpenAI key)"; exit 1; }
[ -s "$L/key.txt" ] || { (umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$L/key.txt"); }
KEY="$(cat "$L/key.txt")"

[ -x "$P/node/bin/node" ] || { mkdir -p "$P/node" && curl -fsSL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.gz | tar xz --strip-components=1 -C "$P/node"; }
export PATH="$P/node/bin:$L/bin:$PATH" NEXT_TELEMETRY_DISABLED=1

if [ -d "$P/app/.git" ]; then
  git -C "$P/app" fetch -q --depth 1 origin "$BRANCH" && git -C "$P/app" checkout -q -f FETCH_HEAD
else
  git clone -q --depth 1 -b "$BRANCH" "$REPO" "$P/app"
fi || { echo "could not fetch $BRANCH from $REPO"; exit 1; }
cd "$P/app"
NOW="$(git rev-parse HEAD) $UPSTREAM"
if [ "$(cat "$P/built" 2>/dev/null)" != "$NOW" ]; then
  say "building $(git rev-parse --short HEAD) of $BRANCH (the OpenAI routes go to $UPSTREAM)"
  stop app
  npm ci --no-audit --no-fund > "$P/build.log" 2>&1 || { tail -5 "$P/build.log"; exit 1; }
  # The address the other routes are passed on to is fixed when the app is built.
  TTS_UPSTREAM="$UPSTREAM" AVATAR_GPU_KEY="$KEY" npx next build >> "$P/build.log" 2>&1 || { tail -15 "$P/build.log"; exit 1; }
  echo "$NOW" > "$P/built"
fi

if ! curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
  say "starting the app"
  TTS_UPSTREAM="$UPSTREAM" AVATAR_GPU_KEY="$KEY" NODE_ENV=production setsid nohup npx next start -p "$PORT" > "$P/app.log" 2>&1 < /dev/null &
  echo $! > "$P/app.pid"
fi
url() { grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$P/tunnel.log" 2>/dev/null | tail -1; }
if ! { [ -f "$P/tunnel.pid" ] && kill -0 "$(cat "$P/tunnel.pid")" 2>/dev/null && [ -n "$(url)" ]; }; then
  say "starting its link"
  : > "$P/tunnel.log"
  setsid nohup cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >> "$P/tunnel.log" 2>&1 < /dev/null &
  echo $! > "$P/tunnel.pid"
fi
for i in $(seq 1 60); do curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break; sleep 1; done
curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null || { say "the app did not start:"; tail -5 "$P/app.log"; exit 1; }
URL=""; for i in $(seq 1 60); do URL="$(url)"; [ -n "$URL" ] && break; sleep 1; done
[ -n "$URL" ] || { say "no link, see $P/tunnel.log"; exit 1; }

# The video server: started with the same secret, and told to this app (which is on this machine).
FLASH_KEY_FILE="$L/key.txt" FLASH_REGISTER_URLS="http://127.0.0.1:$PORT/api/avatar/flash/register" bash "$HERE/start.sh" | sed 's/^/  /'
SEEN="$(curl -fsS -m 10 "http://127.0.0.1:$PORT/api/avatar/status" | grep -o '"sliceFrames":[0-9]*')"
say "the app reports the video server: ${SEEN:-NO (see $L/logs/flash.log and $P/app.log)}"
echo "APP_URL=$URL"
