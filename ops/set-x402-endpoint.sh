#!/bin/zsh
# Point the four agent manifests at a new x402 base URL, commit, push
# (Vercel redeploys automatically). Run after any tunnel URL change.
# Usage: ./ops/set-x402-endpoint.sh https://something.trycloudflare.com
set -e
URL="$1"
[ -z "$URL" ] && { echo "usage: $0 <base-url>"; exit 1; }
cd "$(dirname "$0")/.."
for A in grid health-factor yield lp-range; do
  jq --arg u "$URL/$A/status" '.x402.endpoint = $u | .x402.note = "live"' \
    "apps/web/public/manifests/$A.json" > /tmp/m.json && mv /tmp/m.json "apps/web/public/manifests/$A.json"
done
git add apps/web/public/manifests
git commit -q -m "Manifests: x402 endpoints -> $URL"
git push -q
echo "manifests updated and pushed: $URL"
