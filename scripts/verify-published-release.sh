#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?Usage: verify-published-release.sh <version> <owner/repo>}"
GITHUB_REPO="${2:?Usage: verify-published-release.sh <version> <owner/repo>}"
PACKAGE_VERSION="${VERSION#v}"

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERIFY_RELEASE_SIGNING_SCRIPT="${VERIFY_RELEASE_SIGNING_SCRIPT:-${PROJECT_ROOT}/scripts/verify-release-signing.sh}"
DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/buddy-release-verify.XXXXXX")"
trap 'rm -rf "$DOWNLOAD_DIR"' EXIT

command -v gh >/dev/null \
  || { echo "gh not found. Install: brew install gh && gh auth login" >&2; exit 1; }

REQUIRED_ASSETS=(
  "Buddy-${PACKAGE_VERSION}-arm64-mac.zip"
  "Buddy-${PACKAGE_VERSION}-mac.zip"
  "Buddy-${PACKAGE_VERSION}-arm64.dmg"
  "Buddy-${PACKAGE_VERSION}.dmg"
  "latest-mac.yml"
)

DOWNLOAD_ARGS=(release download "$VERSION" --repo "$GITHUB_REPO" --dir "$DOWNLOAD_DIR")
for asset in "${REQUIRED_ASSETS[@]}"; do
  DOWNLOAD_ARGS+=(--pattern "$asset")
done

echo ">> Downloading ${VERSION} assets from ${GITHUB_REPO} for verification..."
gh "${DOWNLOAD_ARGS[@]}"

for asset in "${REQUIRED_ASSETS[@]}"; do
  [ -f "${DOWNLOAD_DIR}/${asset}" ] \
    || { echo "Missing downloaded release asset: ${asset}" >&2; exit 1; }
done

echo ">> Verifying downloaded ${VERSION} assets..."
VERIFY_BUILD_OUTPUTS=false \
  bash "$VERIFY_RELEASE_SIGNING_SCRIPT" "$PACKAGE_VERSION" "$DOWNLOAD_DIR"

echo ">> Remote ${VERSION} assets verified"
