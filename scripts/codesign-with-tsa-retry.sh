#!/usr/bin/env bash
# codesign wrapper that retries when Apple's timestamp service flakes under load.
# Install as PATH/codesign ahead of /usr/bin during signed builds.
set -euo pipefail

REAL_CODESIGN="${BUDDY_REAL_CODESIGN:-/usr/bin/codesign}"
MAX_ATTEMPTS="${BUDDY_CODESIGN_TSA_RETRIES:-12}"
attempt=1

while (( attempt <= MAX_ATTEMPTS )); do
  errfile="$(mktemp "${TMPDIR:-/tmp}/buddy-codesign.XXXXXX")"
  set +e
  "$REAL_CODESIGN" "$@" 2>"$errfile"
  status=$?
  set -e
  cat "$errfile" >&2

  if (( status == 0 )); then
    rm -f "$errfile"
    exit 0
  fi

  if grep -Eq \
    'timestamp service is not available|A timestamp transaction was rejected|Could not create timestamp' \
    "$errfile"
  then
    rm -f "$errfile"
    sleep_for=$(( attempt < 5 ? attempt : 5 ))
    echo "codesign: Apple TSA unavailable (attempt ${attempt}/${MAX_ATTEMPTS}); retry in ${sleep_for}s..." >&2
    sleep "$sleep_for"
    attempt=$((attempt + 1))
    continue
  fi

  rm -f "$errfile"
  exit "$status"
done

echo "codesign: Apple TSA still unavailable after ${MAX_ATTEMPTS} attempts" >&2
exit 1
