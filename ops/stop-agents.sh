#!/bin/zsh
cd "$(dirname "$0")/.."
for p in runner tunnel; do
  if [ -f "ops/run/$p.pid" ]; then
    kill "$(cat ops/run/$p.pid)" 2>/dev/null && echo "$p stopped" || echo "$p was not running"
    rm -f "ops/run/$p.pid"
  fi
done
