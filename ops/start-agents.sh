#!/bin/zsh
# Start the agent runner + cloudflared tunnel in the background.
set -e
cd "$(dirname "$0")/.."

mkdir -p ops/run
if [ -f ops/run/runner.pid ] && kill -0 "$(cat ops/run/runner.pid)" 2>/dev/null; then
  echo "runner already up (pid $(cat ops/run/runner.pid))"
else
  nohup caffeinate -i pnpm --filter @agripinaa/agents start > ops/run/runner.out 2>&1 &
  echo $! > ops/run/runner.pid
  echo "runner started (pid $(cat ops/run/runner.pid))"
fi

if [ -f ops/run/tunnel.pid ] && kill -0 "$(cat ops/run/tunnel.pid)" 2>/dev/null; then
  echo "tunnel already up (pid $(cat ops/run/tunnel.pid))"
else
  nohup cloudflared tunnel --url http://localhost:4410 > ops/run/tunnel.out 2>&1 &
  echo $! > ops/run/tunnel.pid
  echo "tunnel started (pid $(cat ops/run/tunnel.pid)); waiting for URL…"
  for i in {1..30}; do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' ops/run/tunnel.out | head -1 || true)
    [ -n "$URL" ] && break
    sleep 1
  done
  echo "${URL:-URL-not-found-check-ops/run/tunnel.out}" | tee ops/tunnel-url.txt
fi
