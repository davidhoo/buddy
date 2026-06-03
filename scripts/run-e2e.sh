#!/usr/bin/env sh
set -eu

log_file="${TMPDIR:-/tmp}/buddy-e2e-vite.log"

pnpm exec vite src/renderer --host 127.0.0.1 --port 5173 --strictPort >"$log_file" 2>&1 &
server_pid=$!

cleanup() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

attempt=0
until curl -fsS http://127.0.0.1:5173/ >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 100 ]; then
    cat "$log_file"
    exit 1
  fi
  sleep 0.1
done

pnpm exec playwright test
