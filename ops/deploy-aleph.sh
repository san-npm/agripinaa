#!/bin/zsh
# Deploy the agent runner to a Debian/Ubuntu Aleph Cloud instance.
# Usage: ./ops/deploy-aleph.sh <user@host> [ssh-key-path]
# Idempotent: re-running updates code, resyncs secrets, restarts services.
set -e
HOST="$1"
KEY="${2:-$HOME/.ssh/agripinaa-aleph}"
[ -z "$HOST" ] && { echo "usage: $0 <user@host> [ssh-key]"; exit 1; }
S() { ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$HOST" "$@"; }
RUSER=$(S whoami)
RHOME=$(S 'echo $HOME')

echo "== provisioning node/pnpm/cloudflared (idempotent)…"
S 'node --version 2>/dev/null | grep -q "^v22" || {
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - &&
  sudo apt-get install -y nodejs git rsync
}'
S 'command -v pnpm >/dev/null 2>&1 || sudo npm install -g pnpm@10'
S 'command -v cloudflared >/dev/null 2>&1 || {
  curl -fsSL -o /tmp/cf.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb &&
  sudo dpkg -i /tmp/cf.deb
}'

echo "== syncing repo (git) and secrets (rsync)…"
S 'test -d ~/agripinaa/.git || git clone https://github.com/san-npm/agripinaa.git ~/agripinaa'
S 'cd ~/agripinaa && git fetch -q && git reset -q --hard origin/main && pnpm install --frozen-lockfile'
rsync -e "ssh -i $KEY" -a --chmod=F600 "$(dirname "$0")/../wallets/" "$HOST:agripinaa/wallets/"

echo "== installing systemd services (user: $RUSER)…"
for UNIT in runner tunnel; do
  if [ "$UNIT" = runner ]; then
    DESC="Agripinaa reference agents"
    EXEC="/usr/bin/env pnpm --filter @agripinaa/agents start"
    WD="WorkingDirectory=$RHOME/agripinaa"
  else
    DESC="Cloudflare tunnel for agent x402 endpoints"
    EXEC="/usr/bin/cloudflared tunnel --url http://localhost:4410"
    WD=""
  fi
  printf '[Unit]\nDescription=%s\nAfter=network-online.target\nWants=network-online.target\n[Service]\nUser=%s\n%s\nExecStart=%s\nRestart=always\nRestartSec=10\n[Install]\nWantedBy=multi-user.target\n' \
    "$DESC" "$RUSER" "$WD" "$EXEC" | S "sudo tee /etc/systemd/system/agripinaa-$UNIT.service > /dev/null"
done
S 'sudo systemctl daemon-reload && sudo systemctl enable --now agripinaa-runner agripinaa-tunnel'
sleep 10
S 'sudo systemctl --no-pager -q is-active agripinaa-runner agripinaa-tunnel'

echo "== tunnel URL:"
S 'sudo journalctl -u agripinaa-tunnel --since "3 min ago" 2>/dev/null | grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" | tail -1'
echo "== next: ./ops/set-x402-endpoint.sh <that-url>"
