#!/usr/bin/env bash
# Report this host's current public runner URL to the marketplace, so a rotated
# quick tunnel is picked up without a redeploy and without editing manifests.
#
#   ./ops/report-runner-url.sh                # discover from the tunnel log, then post
#   ./ops/report-runner-url.sh https://x.tld  # post a URL you already know
#   ./ops/report-runner-url.sh --dry-run      # discover and check it, post nothing
#
# The candidate is the LAST hostname cloudflared printed since the tunnel's most
# recent start, and it is only reported once GET <url>/healthz answers: after a
# restart the journal still carries the previous, dead hostname, and reporting
# that one would point the marketplace at nothing until the next rotation.
#
# Env:
#   OPS_TOKEN        required to post; must equal the OPS_TOKEN var on Vercel
#   AGRIPINAA_SITE   marketplace origin (default https://agripinaa.vercel.app)
#   TUNNEL_UNIT      systemd unit whose journal carries the URL
#   CLOUDFLARED_LOG  read this file instead of the journal
#   REPORT_ATTEMPTS  polls (2s apart) waiting for the hostname to be logged
#   PROBE_ATTEMPTS   polls (3s apart, 5s timeout each) waiting for /healthz
set -euo pipefail

SITE="${AGRIPINAA_SITE:-https://agripinaa.vercel.app}"
TUNNEL_UNIT="${TUNNEL_UNIT:-agripinaa-tunnel}"
ATTEMPTS="${REPORT_ATTEMPTS:-30}"
PROBES="${PROBE_ATTEMPTS:-5}"

DRY_RUN=0
URL=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) URL="$arg" ;;
  esac
done

# grep matches per line, so a value carrying a newline can pass a whole-line
# pattern on one line and smuggle the rest into the curl config below.
refuse_multiline() {
  case "$1" in
    *$'\n'*|*$'\r'*) echo "refusing a $2 that spans more than one line" >&2; exit 1 ;;
  esac
}

# Keep only the lines after the most recent tunnel start. cloudflared logs
# "Requesting new quick Tunnel" once per start, before the hostname; a log
# without that marker (a format change) is used whole rather than discarded.
since_last_start() {
  awk '
    { all = all $0 "\n" }
    /Requesting new quick Tunnel/ { buf = ""; started = 1 }
    started { buf = buf $0 "\n" }
    END { printf "%s", (started ? buf : all) }
  '
}

# cloudflared prints the assigned hostname once per start; the last one wins.
extract_tunnel_url() {
  since_last_start | grep -oE 'https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com' | tail -1
}

read_tunnel_log() {
  if [ -n "${CLOUDFLARED_LOG:-}" ]; then
    cat -- "$CLOUDFLARED_LOG" 2>/dev/null
  else
    # The tunnel runs under systemd here, so its output goes to the journal and
    # not to a file. The current invocation's lines are exactly the ones after
    # the unit's most recent start; the bounded window is the fallback when the
    # invocation id is not available.
    local invocation
    invocation="$(systemctl show -p InvocationID --value "$TUNNEL_UNIT" 2>/dev/null || true)"
    if [ -n "$invocation" ]; then
      journalctl "_SYSTEMD_INVOCATION_ID=$invocation" --no-pager 2>/dev/null
    else
      journalctl -u "$TUNNEL_UNIT" --since "10 min ago" --no-pager 2>/dev/null
    fi
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
refuse_multiline "$URL" "url"
printf '%s' "$URL" | grep -qE '^https://[A-Za-z0-9._~/:?=&%+-]+$' || {
  echo "refusing a url that is not plain https: $URL" >&2
  exit 1
}

# A freshly printed hostname takes a few seconds to become reachable, and a
# stale one never does. Report only a candidate that answers.
ALIVE=0
for _ in $(seq 1 "$PROBES"); do
  if curl -fsS -o /dev/null --connect-timeout 5 --max-time 5 "${URL%/}/healthz"; then
    ALIVE=1
    break
  fi
  sleep 3
done
[ "$ALIVE" = 1 ] || {
  echo "refusing to report $URL: GET /healthz did not answer in $PROBES attempts" >&2
  exit 1
}

if [ "$DRY_RUN" = 1 ]; then
  echo "$URL"
  exit 0
fi

: "${OPS_TOKEN:?OPS_TOKEN must be set (same value as the OPS_TOKEN var on Vercel)}"
# Never echoed, and never printed on failure.
refuse_multiline "$OPS_TOKEN" "token"
printf '%s' "$OPS_TOKEN" | grep -qE '^[A-Za-z0-9._~+/=-]+$' || {
  echo "OPS_TOKEN has characters this script will not quote; use hex or base64url" >&2
  exit 1
}

echo "reporting $URL to $SITE"
# Options come in on stdin rather than argv, so the token is not visible in the
# process list to anything else sharing the host.
curl -fsS --connect-timeout 10 --max-time 20 --config - <<EOC
url = "$SITE/api/ops/runner-url"
request = "POST"
header = "authorization: Bearer $OPS_TOKEN"
header = "content-type: application/json"
data-raw = "{\"url\":\"$URL\"}"
EOC
echo
