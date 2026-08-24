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
# The checkout lives under the remote user's home, not a fixed path; every unit
# path below is derived from it so nothing hardcodes /opt or /root.
APPDIR="$RHOME/agripinaa"
for UNIT in runner tunnel; do
  if [ "$UNIT" = runner ]; then
    DESC="Agripinaa reference agents"
    EXEC="/usr/bin/env pnpm --filter @agripinaa/agents start"
    WD="WorkingDirectory=$APPDIR"
    EXTRA=""
  else
    DESC="Cloudflare tunnel for agent x402 endpoints"
    EXEC="/usr/bin/cloudflared tunnel --url http://localhost:4410"
    WD=""
    # A quick tunnel gets a new hostname on every start, so the unit reports its
    # own URL to the marketplace instead of leaving it to a manifest edit. The
    # leading '-' on both lines matters: a missing env file or a failed report
    # must not fail the unit, because Restart=always would then rotate the URL
    # again and again. ops.env is operator-created and never committed.
    # ExecStartPost runs inside the unit's start timeout (90s by default), and
    # the reporter waits for cloudflared to print its hostname, so cap the wait
    # well under that: 20 attempts x 2s, plus a bounded curl.
    EXTRA="EnvironmentFile=-$APPDIR/ops/ops.env
Environment=REPORT_ATTEMPTS=20
ExecStartPost=-$APPDIR/ops/report-runner-url.sh"
  fi
  printf '[Unit]\nDescription=%s\nAfter=network-online.target\nWants=network-online.target\n[Service]\nUser=%s\n%s\nExecStart=%s\n%s\nRestart=always\nRestartSec=10\n[Install]\nWantedBy=multi-user.target\n' \
    "$DESC" "$RUSER" "$WD" "$EXEC" "$EXTRA" | S "sudo tee /etc/systemd/system/agripinaa-$UNIT.service > /dev/null"
done
# restart (not just enable --now, which is a no-op on an already-running unit)
# so new code actually loads; the tunnel stays up to keep its URL stable.
S 'sudo systemctl daemon-reload && sudo systemctl enable agripinaa-runner agripinaa-tunnel && sudo systemctl restart agripinaa-runner && sudo systemctl start agripinaa-tunnel'
sleep 10
S 'sudo systemctl --no-pager -q is-active agripinaa-runner agripinaa-tunnel'

echo "== tunnel URL:"
S 'sudo journalctl -u agripinaa-tunnel --since "3 min ago" 2>/dev/null | grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" | tail -1'

# The tunnel is deliberately started, not restarted, so its URL stays stable,
# which also means ExecStartPost does not fire on a redeploy. Report it here so
# a deploy still leaves the marketplace pointing at the live endpoint.
echo "== reporting the tunnel URL to the marketplace…"
S "set -a; . $APPDIR/ops/ops.env 2>/dev/null || true; set +a; REPORT_ATTEMPTS=5 $APPDIR/ops/report-runner-url.sh" \
  || echo "   skipped (no OPS_TOKEN on the VM yet: see ops/launch.md)"
