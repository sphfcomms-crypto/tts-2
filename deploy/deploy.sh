#!/usr/bin/env bash
# Deploys the TTS app to the server. Run from Git Bash in the project folder:
#
#   bash deploy/deploy.sh                 code only (the server keeps its .env)
#   bash deploy/deploy.sh --with-env      also upload this PC's .env (first deploy,
#                                         or after changing a key or password)
#
# SSH must already work without a password (a key installed on the server).
set -euo pipefail

SERVER="${TTS_SERVER:-root@156.67.29.15}"
SSH_KEY="${TTS_SSH_KEY:-$HOME/.ssh/rafay-wsl-public-ed25519}"
PORT="${TTS_PORT:-3190}"               # where the app listens on the server
FUNNEL_PORT="${TTS_FUNNEL_PORT:-443}"  # public HTTPS port: 443, 8443 or 10000

cd "$(dirname "$0")/.."
SSH=(ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$SERVER")

echo "==> Packing the code"
PACK="$(mktemp -d)/tts-app.tar.gz"
# Everything git tracks or would track; never .env, builds, packages, samples
# or the avatar's build and GPU-box files (the site only needs public/avatar).
git ls-files -co --exclude-standard -z \
  | grep -zvE '^(samples/|deploy/|avatar-build/|avatar-gpu/|run-prod\.bat$)' \
  | tar -czf "$PACK" --null -T -
echo "    $(du -h "$PACK" | cut -f1)"

echo "==> Uploading to $SERVER"
scp -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -q "$PACK" "$SERVER:/tmp/tts-app.tar.gz"
scp -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -q deploy/remote-setup.sh "$SERVER:/tmp/tts-remote-setup.sh"
if [ "${1:-}" = "--with-env" ]; then
  # Only the settings the server needs; dev-only lines stay on this PC.
  grep -E '^(OPENAI_API_KEY|AVATAR_GPU_KEY|APP_PASSWORD|LIMIT_[A-Z_]*|USAGE_LIMITS|CALL_MAX_MINUTES|OPENAI_TRANSCRIBE_LANGUAGES)=' .env \
    | "${SSH[@]}" "umask 077 && cat > /tmp/tts.env"
  echo "    .env uploaded"
fi

echo "==> Setting up on the server"
"${SSH[@]}" "bash /tmp/tts-remote-setup.sh '$PORT' '$FUNNEL_PORT'; code=\$?; rm -f /tmp/tts-remote-setup.sh; exit \$code"
