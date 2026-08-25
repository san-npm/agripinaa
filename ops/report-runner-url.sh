#!/usr/bin/env bash
# Report this host's current public runner URL to the marketplace, so a rotated
# quick tunnel is picked up without a redeploy and without editing manifests.
#
#   ./ops/report-runner-url.sh                # discover from the tunnel log, then post
#   ./ops/report-runner-url.sh https://x.tld  # post a URL you already know
#   ./ops/report-runner-url.sh --dry-run      # discover and check it, post nothing
#
# The candidate is the LAST hostname cloudflared printed since the tunnel's most
# recent start, and it is only reported once the Cloudflare edge answers for it
# at GET <url>/healthz: after a restart the journal still carries the previous,
# dead hostname, which no longer resolves at all, and reporting that one would
# point the marketplace at nothing until the next rotation. A 502/503/504 from
# the edge is not a dead hostname: the tunnel is connected and the runner
# behind it is still starting (it takes longer than the probe budget after a
# VM reboot), so that candidate is reported too.
#
# Env:
#   OPS_TOKEN        required to post; must equal the OPS_TOKEN var on Vercel
#   AGRIPINAA_SITE   marketplace origin (default https://agripinaa.vercel.app)
#   TUNNEL_UNIT      systemd unit whose journal carries the URL
#   CLOUDFLARED_LOG  read this file instead of the journal
#   REPORT_ATTEMPTS  polls (2s apart) waiting for the hostname to be logged
#   PROBE_ATTEMPTS   polls (3s apart, 5s timeout each) waiting for the edge to
#                    answer for the hostname (a 2xx stops early)
#
# Wall-clock budget. This runs as the tunnel unit's ExecStartPost, i.e. inside
# that unit's start timeout, and overrunning it gets cloudflared killed and
# restarted on a new hostname, so every wait here is bounded and the total is
# stated rather than implied:
#
#   discovery   REPORT_ATTEMPTS x 2s sleep            20 x 2  =  40s
#   probe       PROBE_ATTEMPTS x 5s (curl --max-time)  5 x 5  =  25s
#               plus (PROBE_ATTEMPTS - 1) x 3s sleep    4 x 3  =  12s
#   report      curl --max-time 20                             =  20s
#                                                       worst case 97s
#
# The typical path is about 20s (the hostname appears in a few seconds and the
# edge answers on the first probe). The unit sets TimeoutStartSec=300 in
# ops/deploy-aleph.sh, so the worst case fits with room to spare; raising
# REPORT_ATTEMPTS or PROBE_ATTEMPTS means recounting against that number.
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

# A freshly printed hostname takes a few seconds to resolve, and a stale one
# never does again. What decides is whether the edge answers for the hostname,
# not whether the runner is already up behind it:
#   2xx           runner up, report at once
#   502/503/504   tunnel connected, origin still starting: report after the
#                 probe budget, or the URL stays unknown until the next
#                 rotation (ExecStartPost is '-'-prefixed, so nothing retries)
#   other status  the edge answered, so the hostname is live; treated the same
#   no answer     curl 6/7/28/35 (resolve, connect, timeout, tls): refuse
# The status is read from -w rather than -f, so a 5xx is told apart from a
# hostname that never answered.
probe() {
  curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 5 "${URL%/}/healthz"
}
ALIVE=0
STATUS=000
for attempt in $(seq 1 "$PROBES"); do
  STATUS="$(probe 2>/dev/null || true)"
  case "$STATUS" in
    2??) ALIVE=1; break ;;
    000|"") STATUS=000 ;;
  esac
  [ "$attempt" -lt "$PROBES" ] && sleep 3
done
if [ "$ALIVE" != 1 ]; then
  [ "$STATUS" != 000 ] || {
    echo "refusing to report $URL: GET /healthz got no answer in $PROBES attempts (hostname does not resolve or connect)" >&2
    exit 1
  }
  echo "GET /healthz answered $STATUS after $PROBES attempts: the hostname is live at the edge and the runner is still starting behind it" >&2
fi

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
