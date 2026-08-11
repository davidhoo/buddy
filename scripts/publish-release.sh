#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?Usage: publish-release.sh <version> <owner/repo>}"
GITHUB_REPO="${2:?Usage: publish-release.sh <version> <owner/repo>}"
PACKAGE_VERSION="${VERSION#v}"

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"
RELEASE_DIR="${RELEASE_DIR:-release}"
RELEASE_DIR="$(cd "$RELEASE_DIR" && pwd)"
VERIFY_PUBLISHED_RELEASE_SCRIPT="${VERIFY_PUBLISHED_RELEASE_SCRIPT:-${PROJECT_ROOT}/scripts/verify-published-release.sh}"

command -v gh >/dev/null \
  || { echo "gh not found. Install: brew install gh && gh auth login" >&2; exit 1; }
command -v curl >/dev/null \
  || { echo "curl not found" >&2; exit 1; }

PACKAGE_FILES=(
  "${RELEASE_DIR}/Buddy-${PACKAGE_VERSION}-arm64.dmg"
  "${RELEASE_DIR}/Buddy-${PACKAGE_VERSION}.dmg"
  "${RELEASE_DIR}/Buddy-${PACKAGE_VERSION}-arm64-mac.zip"
  "${RELEASE_DIR}/Buddy-${PACKAGE_VERSION}-mac.zip"
  "${RELEASE_DIR}/buddy-${VERSION}-source.tar.gz"
  "${RELEASE_DIR}/buddy-${VERSION}-source.zip"
)
LATEST_MAC_YML="${RELEASE_DIR}/latest-mac.yml"

for file in "${PACKAGE_FILES[@]}" "$LATEST_MAC_YML"; do
  [ -f "$file" ] || { echo "Missing required release asset: ${file}" >&2; exit 1; }
done

echo ">> Preparing Draft release ${VERSION}..."
if gh release view "$VERSION" --repo "$GITHUB_REPO" >/dev/null 2>&1; then
  gh release edit "$VERSION" --repo "$GITHUB_REPO" --draft >/dev/null
else
  gh release create "$VERSION" \
    --repo "$GITHUB_REPO" \
    --title "Buddy ${VERSION}" \
    --notes "Release ${VERSION}" \
    --draft >/dev/null
fi

PUBLICATION_ATTEMPTED=false
FEED_VERIFIED=false
FEED_FILE=""
rollback_if_needed() {
  local status=$?
  if [ "$PUBLICATION_ATTEMPTED" = "true" ] && [ "$FEED_VERIFIED" != "true" ]; then
    echo "Latest feed verification failed; returning ${VERSION} to Draft" >&2
    gh release edit "$VERSION" --repo "$GITHUB_REPO" --draft >/dev/null 2>&1 || true
  fi
  if [ -n "$FEED_FILE" ]; then
    rm -f "$FEED_FILE"
  fi
  trap - EXIT
  exit "$status"
}
trap rollback_if_needed EXIT

echo ">> Uploading package and source assets to Draft release..."
for file in "${PACKAGE_FILES[@]}"; do
  echo "   Uploading $(basename "$file")..."
  gh release upload "$VERSION" "$file" --repo "$GITHUB_REPO" --clobber
done

echo ">> Uploading latest-mac.yml last..."
gh release upload "$VERSION" "$LATEST_MAC_YML" --repo "$GITHUB_REPO" --clobber

echo ">> Verifying assets downloaded from the Draft release..."
bash "$VERIFY_PUBLISHED_RELEASE_SCRIPT" "$VERSION" "$GITHUB_REPO"

echo ">> Publishing verified release ${VERSION}..."
PUBLICATION_ATTEMPTED=true
gh release edit "$VERSION" --repo "$GITHUB_REPO" --draft=false --latest >/dev/null

LATEST_TAG="$(gh api "repos/${GITHUB_REPO}/releases/latest" --jq .tag_name)"
if [ "$LATEST_TAG" != "$VERSION" ]; then
  echo "GitHub latest release is ${LATEST_TAG}, expected ${VERSION}" >&2
  exit 1
fi

FEED_FILE="$(mktemp "${TMPDIR:-/tmp}/buddy-latest-feed.XXXXXX")"
curl -fsSL \
  "https://github.com/${GITHUB_REPO}/releases/latest/download/latest-mac.yml" \
  -o "$FEED_FILE"
if ! cmp "$LATEST_MAC_YML" "$FEED_FILE"; then
  echo "Published latest-mac.yml does not match the verified local metadata" >&2
  exit 1
fi

FEED_VERIFIED=true
rm -f "$FEED_FILE"
FEED_FILE=""
trap - EXIT

echo ">> Release ${VERSION} published and latest feed verified"
