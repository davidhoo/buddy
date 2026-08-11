#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Buddy — Local Release Script
#
# Usage: scripts/release.sh <version>
#   e.g.  scripts/release.sh v1.2.0
#
# Prerequisites:
#   - gh CLI authenticated (brew install gh && gh auth login)
#   - Rosetta installed for x64 cross-build (softwareupdate --install-rosetta)
#   - CSC_NAME set to an Apple Development signing identity
#
# Flow:
#   pre-check → bump version → forced signing → local verification → commit/tag/push
#   → Draft upload → remote verification → publish/latest-feed verification
# =============================================================================

VERSION="${1:?Usage: release.sh <version>  e.g. release.sh v1.2.0}"
PACKAGE_VERSION="${VERSION#v}"

# --- Resolve project root (script may be run from any directory) ---
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# --- Prerequisites ---
command -v gh >/dev/null \
  || { echo "gh not found. Install: brew install gh && gh auth login" >&2; exit 1; }

# --- Signing pre-check ---
: "${CSC_NAME:?Set CSC_NAME to the Apple Development signing identity}"
case "$CSC_NAME" in
  Apple\ Development:*) ;;
  *) echo "CSC_NAME must be an Apple Development identity (got: $CSC_NAME)" >&2; exit 1 ;;
esac

security find-identity -v -p codesigning \
  | grep -F -- "\"${CSC_NAME}\"" >/dev/null \
  || { echo "Signing identity not found or invalid: ${CSC_NAME}" >&2; exit 1; }

# --- Config ---
PACKAGE_NAME="buddy"

# --- Derive GitHub info from remote (prefer upstream to match gh) ---
if git remote get-url upstream >/dev/null 2>&1; then
  REMOTE_NAME="upstream"
else
  REMOTE_NAME="origin"
fi
REMOTE_URL="$(git remote get-url "$REMOTE_NAME")"

# Extract GitHub repo (owner/repo) from remote URL
if [[ "$REMOTE_URL" == git@github.com:* ]]; then
  GITHUB_REPO="${REMOTE_URL#git@github.com:}"
  GITHUB_REPO="${GITHUB_REPO%.git}"
elif [[ "$REMOTE_URL" == https://github.com/* ]]; then
  GITHUB_REPO="${REMOTE_URL#https://github.com/}"
  GITHUB_REPO="${GITHUB_REPO%.git}"
elif [[ "$REMOTE_URL" == ssh://git@github.com/* ]]; then
  GITHUB_REPO="${REMOTE_URL#ssh://git@github.com/}"
  GITHUB_REPO="${GITHUB_REPO%.git}"
else
  echo "Cannot parse GitHub remote URL: $REMOTE_URL" >&2; exit 1
fi

echo "=== Buddy Release ${VERSION} ==="
echo "GitHub: ${GITHUB_REPO}"
echo "Remote: ${REMOTE_NAME} ($(git remote get-url "$REMOTE_NAME"))"
echo ""

# --- 1. Bump version in package.json ---
echo ">> Bumping version to ${PACKAGE_VERSION}..."
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version='${PACKAGE_VERSION}';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
echo "   Version set to ${PACKAGE_VERSION} ✓"

# --- 2. Build (forced signing, no notarization) ---
echo ">> Building with forced code signing..."
pnpm build
pnpm clean:release
CUSTOM_DMGBUILD_PATH="$(sh scripts/prepare-dmgbuild.sh)" \
  CSC_IDENTITY_AUTO_DISCOVERY=false \
  CSC_NAME="$CSC_NAME" \
  pnpm exec electron-builder --mac --publish never \
    -c.mac.forceCodeSigning=true \
    -c.mac.notarize=false
echo "   Build complete ✓"

# --- 3. Verify release signing ---
echo ">> Verifying release signing..."
bash scripts/verify-release-signing.sh "$PACKAGE_VERSION"
echo "   Signing verified ✓"

# --- 4. Verify artifacts present ---
echo ">> Verifying artifacts..."
EXPECTED_FILES=(
  "release/Buddy-${PACKAGE_VERSION}-arm64.dmg"
  "release/Buddy-${PACKAGE_VERSION}.dmg"
  "release/Buddy-${PACKAGE_VERSION}-arm64-mac.zip"
  "release/Buddy-${PACKAGE_VERSION}-mac.zip"
  "release/latest-mac.yml"
)
for f in "${EXPECTED_FILES[@]}"; do
  [ -f "$f" ] || { echo "Missing: ${f}" >&2; exit 1; }
done
echo "   All artifacts present ✓"

# --- 5. Create source archives ---
echo ">> Creating source archives..."
git archive --format=tar.gz --prefix="buddy-${VERSION}/" HEAD \
  > "release/buddy-${VERSION}-source.tar.gz"
git archive --format=zip --prefix="buddy-${VERSION}/" -o "release/buddy-${VERSION}-source.zip" HEAD
echo "   Source archives created ✓"

# --- 6. Commit version bump, tag and push (skip if tag already exists) ---
if git tag --list "$VERSION" | grep -q .; then
  echo ">> Tag ${VERSION} already exists, skipping commit/tag/push ✓"
else
  echo ">> Committing version bump..."
  git add package.json
  git diff --cached --quiet || git commit -m "chore: release ${VERSION}"
  echo ">> Pushing tag ${VERSION}..."
  git tag "$VERSION"
  git push "$REMOTE_NAME" main "$VERSION"
  # Also push to origin if it's a different remote (keep fork in sync)
  if [ "$REMOTE_NAME" != "origin" ] && git remote get-url origin >/dev/null 2>&1; then
    echo "   Also pushing to origin (fork sync)..."
    git push origin main "$VERSION" || true
  fi
  echo "   Tag pushed ✓"
fi

# --- 7. Publish through the verified Draft gate ---
echo ">> Publishing verified GitHub Release..."
bash scripts/publish-release.sh "$VERSION" "$GITHUB_REPO"

echo ""
echo "=== Release ${VERSION} published! ==="
echo "  GitHub:   https://github.com/${GITHUB_REPO}/releases/tag/${VERSION}"
echo "  Remote:   ${REMOTE_NAME}"
