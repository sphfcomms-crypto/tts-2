#!/usr/bin/env bash
# JupyterLab on the GPU box, opened through its own private tunnel link.
# On the box this file is /workspace/jupyter/start.sh.
#
#   bash /workspace/jupyter/start.sh           start what is not running, print the link
#   bash /workspace/jupyter/start.sh --stop    stop both
#
# The box's own Python (/opt/venv, which has PyTorch with CUDA) runs the notebooks, so a notebook
# sees the GPU at once. JupyterLab is installed into it on first use: the box's own disk is wiped
# when the box stops. /workspace is not, so keep notebooks and results under /workspace.
#
# The link carries a secret token (token.txt, made once and reused). Whoever has the link has a
# root shell on the box, so it is given to the owner only. The address changes every time the
# tunnel starts.
set -uo pipefail
ROOT=/workspace/jupyter
PORT="${JUPYTER_PORT:-8888}"
PY="${JUPYTER_PYTHON:-/opt/venv/bin/python}"
CLOUDFLARED=/workspace/avatar-gpu/bin/cloudflared
mkdir -p "$ROOT/logs" "$ROOT/run" /workspace/notebooks
cd "$ROOT" || exit 1

# run/*.pid survive on the persistent disk, so on a new box they may name an unrelated process:
# a part only counts as alive when the process with that number is really ours.
alive() {
  local pid
  pid="$(cat "run/$1.pid" 2>/dev/null)" || return 1
  [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q "$2"
}
stop_one() {
  alive "$1" "$2" && kill "$(cat "run/$1.pid")" 2>/dev/null
  rm -f "run/$1.pid"
}

if [ "${1:-}" = "--stop" ]; then
  stop_one tunnel cloudflared
  stop_one lab jupyter
  rm -f run/url.txt
  echo "stopped"
  exit 0
fi

[ -s token.txt ] || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > token.txt
chmod 600 token.txt
TOKEN="$(cat token.txt)"

if ! "$PY" -c "import jupyterlab" 2>/dev/null; then
  echo "installing JupyterLab (about a minute)"
  "$PY" -m pip install -q jupyterlab >> logs/install.log 2>&1 \
    || { echo "install failed, see $ROOT/logs/install.log"; exit 1; }
fi

# The token is handed over in the environment, so it does not show in the list of processes.
if ! alive lab jupyter; then
  echo "starting JupyterLab"
  JUPYTER_TOKEN="$TOKEN" setsid nohup "$PY" -m jupyterlab --no-browser --allow-root \
    --ip=127.0.0.1 --port="$PORT" --ServerApp.port_retries=0 \
    --ServerApp.allow_remote_access=True --ServerApp.root_dir=/workspace \
    >> logs/lab.log 2>&1 < /dev/null &
  echo $! > run/lab.pid
fi
up() { curl -fsS -m 3 -o /dev/null "$1/api"; }
for i in $(seq 1 90); do up "http://127.0.0.1:$PORT" 2>/dev/null && break; sleep 1; done
up "http://127.0.0.1:$PORT" 2>/dev/null || { echo "JupyterLab did not start, see $ROOT/logs/lab.log"; exit 1; }

tunnel_url() { grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' logs/tunnel.log 2>/dev/null | tail -1; }
if ! alive tunnel cloudflared || [ -z "$(tunnel_url)" ]; then
  alive tunnel cloudflared && { kill "$(cat run/tunnel.pid)" 2>/dev/null; sleep 1; }
  echo "starting tunnel"
  : > logs/tunnel.log
  setsid nohup "$CLOUDFLARED" tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" \
    >> logs/tunnel.log 2>&1 < /dev/null &
  echo $! > run/tunnel.pid
fi
URL=""
for i in $(seq 1 60); do URL="$(tunnel_url)"; [ -n "$URL" ] && break; sleep 1; done
[ -n "$URL" ] || { echo "no tunnel address, see $ROOT/logs/tunnel.log"; exit 1; }
for i in $(seq 1 40); do up "$URL" 2>/dev/null && break; sleep 1; done

( umask 077; echo "$URL/lab?token=$TOKEN" > run/url.txt )
echo "ready"
echo "JUPYTER_URL=$URL/lab?token=<the token in $ROOT/token.txt>"
