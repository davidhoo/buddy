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
CHANGELOG_FILE="${CHANGELOG_FILE:-${PROJECT_ROOT}/CHANGELOG.md}"

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

[ -f "$CHANGELOG_FILE" ] || { echo "Missing changelog: ${CHANGELOG_FILE}" >&2; exit 1; }

# Extract Keep a Changelog section for this version (header through next --- / next version).
NOTES_FILE="$(mktemp "${TMPDIR:-/tmp}/buddy-release-notes.XXXXXX")"
cleanup_notes() {
  rm -f "$NOTES_FILE"
}
trap cleanup_notes EXIT

awk -v ver="$PACKAGE_VERSION" '
  $0 ~ "^## \\[" ver "\\]" { found = 1 }
  found && /^---$/ { exit }
  found && $0 ~ /^## \[/ && $0 !~ "^## \\[" ver "\\]" { exit }
  found { print }
' "$CHANGELOG_FILE" > "$NOTES_FILE"

if [ ! -s "$NOTES_FILE" ]; then
  echo "CHANGELOG.md has no entry for [${PACKAGE_VERSION}]; refuse placeholder release notes" >&2
  exit 1
fi
if ! grep -qE "^## \[${PACKAGE_VERSION}\]" "$NOTES_FILE"; then
  echo "Extracted release notes do not start with ## [${PACKAGE_VERSION}]" >&2
  exit 1
fi
# Block the historical placeholder that shipped for v2.0.0 by accident.
if grep -qxE "Release v?${PACKAGE_VERSION}" "$NOTES_FILE"; then
  echo "Refuse placeholder release notes: Release ${VERSION}" >&2
  exit 1
fi

echo ">> Preparing Draft release ${VERSION} with CHANGELOG notes..."
if gh release view "$VERSION" --repo "$GITHUB_REPO" >/dev/null 2>&1; then
  gh release edit "$VERSION" \
    --repo "$GITHUB_REPO" \
    --title "Buddy ${VERSION}" \
    --notes-file "$NOTES_FILE" \
    --draft >/dev/null
else
  gh release create "$VERSION" \
    --repo "$GITHUB_REPO" \
    --title "Buddy ${VERSION}" \
    --notes-file "$NOTES_FILE" \
    --draft >/dev/null
fi

PUBLICATION_ATTEMPTED=false
FEED_VERIFIED=false
FEED_DIR=""
rollback_if_needed() {
  local status=$?
  if [ "$PUBLICATION_ATTEMPTED" = "true" ] && [ "$FEED_VERIFIED" != "true" ]; then
    echo "Latest feed verification failed; returning ${VERSION} to Draft" >&2
    gh release edit "$VERSION" --repo "$GITHUB_REPO" --draft >/dev/null 2>&1 || true
  fi
  if [ -n "$FEED_DIR" ]; then
    rm -rf "$FEED_DIR"
  fi
  cleanup_notes
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

FEED_DIR="$(mktemp -d "${TMPDIR:-/tmp}/buddy-latest-feed.XXXXXX")"
FEED_FILE="${FEED_DIR}/latest-mac.yml"
# Prefer the public /releases/latest URL that auto-updaters hit. If github.com is
# unreachable from the release host, fall back to gh after API confirmed latest tag.
if ! curl -fsSL --connect-timeout 30 --max-time 120 \
  "https://github.com/${GITHUB_REPO}/releases/latest/download/latest-mac.yml" \
  -o "$FEED_FILE"; then
  echo ">> Public latest feed URL unreachable; falling back to gh asset download" >&2
  gh release download "$VERSION" --repo "$GITHUB_REPO" \
    --pattern 'latest-mac.yml' --dir "$FEED_DIR" --clobber
fi
if ! cmp "$LATEST_MAC_YML" "$FEED_FILE"; then
  echo "Published latest-mac.yml does not match the verified local metadata" >&2
  exit 1
fi

FEED_VERIFIED=true
rm -rf "$FEED_DIR"
FEED_DIR=""
cleanup_notes
trap - EXIT

echo ">> Release ${VERSION} published and latest feed verified"
