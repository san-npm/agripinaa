#!/bin/zsh
# Deploy the agent runner to a Debian/Ubuntu Aleph Cloud instance.
# Usage: ./ops/deploy-aleph.sh <user@host> [ssh-key-path]
# Idempotent: re-running updates code, resyncs secrets, restarts services.
set -e
HOST="$1"
KEY="${2:-$HOME/.ssh/agripinaa-aleph}"
[ -z "$HOST" ] && { echo "usage: $0 <user@host> [ssh-key]"; exit 1; }
# Reject anything that could be read as an ssh/rsync option (e.g. a HOST of
# "-oProxyCommand=..." would run a local command). Accept a user@host or a
# bare ssh_config alias, but nothing with a leading dash or shell metachars.
case "$HOST" in -*) echo "refusing HOST starting with '-'"; exit 1;; esac
case "$KEY"  in -*) echo "refusing KEY starting with '-'"; exit 1;; esac
echo "$HOST" | grep -qE '^([A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$' || { echo "HOST has invalid characters"; exit 1; }
[ -f "$KEY" ] || { echo "key file not found: $KEY"; exit 1; }
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
# -a preserves the local 600 modes (macOS rsync lacks modern --chmod syntax).
rsync -e "ssh -i $KEY" -av "$(dirname "$0")/../wallets/" "$HOST:agripinaa/wallets/"
S 'test -f ~/agripinaa/wallets/agent-grid.json' || { echo "FATAL: wallet sync did not land"; exit 1; }
# Enforce 0600 on the remote regardless of what the local modes were (some
# key files predate the chmod-on-write and could be 0644).
S 'chmod 700 ~/agripinaa/wallets && chmod 600 ~/agripinaa/wallets/*.json'

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
