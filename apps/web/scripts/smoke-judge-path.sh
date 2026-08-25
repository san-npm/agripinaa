#!/usr/bin/env bash
#
# The judge path, asserted end to end against a running server.
#
#   pnpm --filter @agripinaa/web build
#   pnpm --filter @agripinaa/web start &
#   pnpm --filter @agripinaa/web smoke            # or: bash scripts/smoke-judge-path.sh <base-url>
#
# What a judge does in their first two minutes is: land, pick a category, open
# an agent, and look for the gate. Every unit test in this repo passes with all
# four of those broken, which is how a soft 404 on /agent/[chainId]/[tokenId]
# reached a review by hand. This asserts the statuses and the first paint of
# that path instead, so the freeze has something to run before a deploy.
#
# Reads only. It makes GET requests against a base url and nothing else: no
# writes, no chain, no keys.
set -uo pipefail

BASE="${1:-http://localhost:3000}"
BASE="${BASE%/}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
BODY="$tmp/body"
STATUS=""

pass=0
fail=0

ok() {
  printf '  ok    %s\n' "$1"
  pass=$((pass + 1))
}

bad() {
  printf '  FAIL  %s\n' "$1"
  fail=$((fail + 1))
}

# Fetch one path, keeping the body for the assertions that follow it. Streamed
# routes send their shell first and their content after, so the whole body is
# read before anything is asserted about it.
load() {
  STATUS="$(curl -sS --max-time 60 -o "$BODY" -w '%{http_code}' "$BASE$1" 2>/dev/null)" || STATUS="000"
}

expect_status() { # path want
  load "$1"
  if [ "$STATUS" = "$2" ]; then
    ok "$1 answers $2"
  else
    bad "$1 answered $STATUS, wanted $2"
  fi
}

expect_body() { # label fixed-string
  if grep -qF -- "$2" "$BODY"; then ok "$1"; else bad "$1"; fi
}

expect_no_body() { # label fixed-string
  if grep -qF -- "$2" "$BODY"; then bad "$1"; else ok "$1"; fi
}

# A server that has just started takes a moment to answer the first request.
printf 'judge path smoke against %s\n' "$BASE"
for _ in $(seq 1 30); do
  load "/"
  [ "$STATUS" = "200" ] && break
  sleep 2
done
if [ "$STATUS" != "200" ]; then
  printf '  FAIL  %s did not answer (last status %s)\n' "$BASE" "$STATUS"
  exit 1
fi

echo "landing"
expect_status "/" 200
# The counts are rendered on the server, so a marketplace reporting that it has
# no agents is a first-paint bug the HTML carries whether or not js runs.
expect_no_body "home: no stat tile reads zero" '>0<'
expect_body "home: the proof feed carries at least one settlement row" 'agp-proof-event'

echo "category hubs"
for category in grid health-factor yield rebalancing; do
  expect_status "/c/$category" 200
  expect_body "/c/$category: at least one agent card" 'href="/agent/56/'
done
# An unknown hub answers 404 rather than a placeholder page.
expect_status "/c/nonsense" 404

echo "agent detail"
# 269703 is Agripinaa Grid, registered on BSC mainnet.
expect_status "/agent/56/269703" 200
expect_body "detail: identity panel" '>Identity<'
expect_body "detail: track record panel" 'Track record'
expect_body "detail: execution quality panel" 'Execution quality'
# The soft 404 this file exists for: an unknown id used to answer 200 with a
# not-found body, because notFound() ran after the shell had streamed.
expect_status "/agent/56/999999999" 404
expect_status "/agent/56/999999999/activate" 404
expect_status "/agent/56/999999999/claim" 404
expect_status "/agent/1/269703" 404

echo "the rest of the path"
expect_status "/funds" 200
expect_status "/leaderboard" 200
expect_status "/proof" 200
expect_body "proof: at least one settlement row" 'agp-proof-event'

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
