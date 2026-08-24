#!/usr/bin/env bash
# Report this host's current public runner URL to the marketplace, so a rotated
# quick tunnel is picked up without a redeploy and without editing manifests.
#
#   ./ops/report-runner-url.sh                # discover from the tunnel log, then post
#   ./ops/report-runner-url.sh https://x.tld  # post a URL you already know
#   ./ops/report-runner-url.sh --dry-run      # discover and print it, post nothing
#
# Env:
#   OPS_TOKEN        required to post; must equal the OPS_TOKEN var on Vercel
#   AGRIPINAA_SITE   marketplace origin (default https://agripinaa.vercel.app)
#   TUNNEL_UNIT      systemd unit whose journal carries the URL
#   CLOUDFLARED_LOG  read this file instead of the journal
set -euo pipefail

SITE="${AGRIPINAA_SITE:-https://agripinaa.vercel.app}"
TUNNEL_UNIT="${TUNNEL_UNIT:-agripinaa-tunnel}"
ATTEMPTS="${REPORT_ATTEMPTS:-30}"

DRY_RUN=0
URL=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) URL="$arg" ;;
  esac
done

# cloudflared prints the assigned hostname once per start; the last one wins.
extract_tunnel_url() {
  grep -oE 'https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com' | tail -1
}

read_tunnel_log() {
  if [ -n "${CLOUDFLARED_LOG:-}" ]; then
    cat -- "$CLOUDFLARED_LOG" 2>/dev/null
  else
    # The tunnel runs under systemd here, so its output goes to the journal and
    # not to a file. Bounded window: an older start's URL is already dead.
    journalctl -u "$TUNNEL_UNIT" --since "10 min ago" --no-pager 2>/dev/null
  fi
}

# Called as ExecStartPost, so the URL is usually not in the log yet.
if [ -z "$URL" ]; then
  for _ in $(seq 1 "$ATTEMPTS"); do
    URL="$(read_tunnel_log | extract_tunnel_url || true)"
    [ -n "$URL" ] && break
    sleep 2
  done
fi

[ -n "$URL" ] || {
  echo "no tunnel url found (unit=$TUNNEL_UNIT log=${CLOUDFLARED_LOG:-journal})" >&2
  exit 1
}
# The server validates this too. Checking here keeps a hostile value out of the
# curl config below, and turns a typo into an error rather than a 400.
printf '%s' "$URL" | grep -qE '^https://[A-Za-z0-9._~/:?=&%+-]+$' || {
  echo "refusing a url that is not plain https: $URL" >&2
  exit 1
}

if [ "$DRY_RUN" = 1 ]; then
  echo "$URL"
  exit 0
fi

: "${OPS_TOKEN:?OPS_TOKEN must be set (same value as the OPS_TOKEN var on Vercel)}"
# Never echoed, and never printed on failure.
printf '%s' "$OPS_TOKEN" | grep -qE '^[A-Za-z0-9._~+/=-]+$' || {
  echo "OPS_TOKEN has characters this script will not quote; use hex or base64url" >&2
  exit 1
}

echo "reporting $URL to $SITE"
# Options come in on stdin rather than argv, so the token is not visible in the
# process list to anything else sharing the host.
curl -fsS --connect-timeout 10 --max-time 20 --config - <<EOF
url = "$SITE/api/ops/runner-url"
request = "POST"
header = "authorization: Bearer $OPS_TOKEN"
header = "content-type: application/json"
data-raw = "{\"url\":\"$URL\"}"
EOF
echo
