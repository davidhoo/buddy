#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Buddy macOS — Local Release Script
#
# Usage: scripts/release.sh <version>
#   e.g.  scripts/release.sh v1.2.0
#
# Prerequisites:
#   - glab CLI authenticated (brew install glab && glab auth login)
#   - ~/.rsyncd.pass file with rsync password (or set RSYNC_PASS_FILE)
#   - Rosetta installed for x64 cross-build (softwareupdate --install-rosetta)
#
# Flow:
#   bump version → build → verify → commit+tag+push → upload to GitLab → create release → rsync deploy
# =============================================================================

VERSION="${1:?Usage: release.sh <version>  e.g. release.sh v1.2.0}"
PACKAGE_VERSION="${VERSION#v}"

# --- Resolve project root (script may be run from any directory) ---
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# --- Prerequisites ---
command -v glab >/dev/null \
  || { echo "glab not found. Install: brew install glab && glab auth login" >&2; exit 1; }

# --- Config ---
RSYNC_PASS_FILE="${RSYNC_PASS_FILE:-$HOME/.rsyncd.pass}"
RSYNC_DEST="rsync://buddyweb@10.185.10.105/buddyweb-releases/"
PACKAGE_NAME="buddy-macos"

# --- Derive GitLab info from remote ---
REMOTE_URL="$(git remote get-url origin)"
if [[ "$REMOTE_URL" == ssh://git@* ]]; then
  REST="${REMOTE_URL#ssh://git@}"
  GITLAB_HOST="${REST%%:*}"
  REST="${REST#*/}"
  PROJECT_PATH="${REST%.git}"
elif [[ "$REMOTE_URL" == git@* ]]; then
  REST="${REMOTE_URL#git@}"
  GITLAB_HOST="${REST%%:*}"
  PROJECT_PATH="${REST#*:}"
  PROJECT_PATH="${PROJECT_PATH%.git}"
elif [[ "$REMOTE_URL" == https://* ]] || [[ "$REMOTE_URL" == http://* ]]; then
  REST="${REMOTE_URL#https://}"
  REST="${REST#http://}"
  GITLAB_HOST="${REST%%/*}"
  PROJECT_PATH="${REST#*/}"
  PROJECT_PATH="${PROJECT_PATH%.git}"
else
  echo "Cannot parse remote URL: $REMOTE_URL" >&2; exit 1
fi

PROJECT_ID="$(node -e "console.log(encodeURIComponent('${PROJECT_PATH}'))")"
API_BASE="https://${GITLAB_HOST}/api/v4"

echo "=== Buddy Release ${VERSION} ==="
echo "GitLab: ${GITLAB_HOST} / ${PROJECT_PATH}"
echo ""

# --- 1. Bump version in package.json ---
echo ">> Bumping version to ${PACKAGE_VERSION}..."
CURRENT_VERSION="$(node -e "console.log(require('./package.json').version)")"
if [ "$CURRENT_VERSION" = "$PACKAGE_VERSION" ]; then
  echo "   Version already ${PACKAGE_VERSION} ✓"
else
  node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version='${PACKAGE_VERSION}';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
  echo "   ${CURRENT_VERSION} → ${PACKAGE_VERSION} ✓"
fi

# --- 2. Build ---
echo ">> Building..."
pnpm build
pnpm clean:release
CUSTOM_DMGBUILD_PATH="$(sh scripts/prepare-dmgbuild.sh)" \
  CSC_NAME="Apple Development: coolbor@gmail.com (LL5Q233Q8L)" \
  pnpm exec electron-builder --mac --publish never -c.mac.notarize=false
echo "   Build complete ✓"

# --- 3. Verify artifacts ---
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
app_count="$(find release -maxdepth 2 -type d -name '*.app' | wc -l | tr -d ' ')"
[ "$app_count" -gt 0 ] || { echo "No .app bundle found under release/" >&2; exit 1; }
echo "   All artifacts present ✓"

# --- 4. Verify DMGs ---
echo ">> Verifying DMGs..."
find release -maxdepth 1 -name '*.dmg' -exec hdiutil verify {} \;
echo "   DMGs verified ✓"

# --- 5. Create source archives ---
echo ">> Creating source archives..."
git archive --format=tar.gz --prefix="buddy-macos-${VERSION}/" HEAD \
  > "release/buddy-macos-${VERSION}-source.tar.gz"
git archive --format=zip --prefix="buddy-macos-${VERSION}/" -o "release/buddy-macos-${VERSION}-source.zip" HEAD
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
  git push origin main "$VERSION"
  echo "   Tag pushed ✓"
fi

# --- 7. Upload to GitLab Package Registry ---
upload_file() {
  local file="$1"
  local basename
  basename="$(basename "$file")"
  echo "   Uploading ${basename}..."
  local response
  response="$(glab api --method PUT --input "$file" \
    "/projects/${PROJECT_ID}/packages/generic/${PACKAGE_NAME}/${PACKAGE_VERSION}/${basename}" 2>&1)" \
    || { echo "   Upload failed: ${response}" >&2; exit 1; }
}

echo ">> Uploading to GitLab Package Registry..."
UPLOAD_FILES=(
  "release/Buddy-${PACKAGE_VERSION}-arm64.dmg"
  "release/Buddy-${PACKAGE_VERSION}.dmg"
  "release/Buddy-${PACKAGE_VERSION}-arm64-mac.zip"
  "release/Buddy-${PACKAGE_VERSION}-mac.zip"
  "release/latest-mac.yml"
  "release/buddy-macos-${VERSION}-source.tar.gz"
  "release/buddy-macos-${VERSION}-source.zip"
)
for f in "${UPLOAD_FILES[@]}"; do
  upload_file "$f"
done
echo "   Upload complete ✓"

# --- 8. Create GitLab Release ---
echo ">> Creating GitLab Release..."
ASSETS_LINKS="$(cat <<EOF
[
  {"name":"macOS DMG (arm64)","url":"${API_BASE}/projects/${PROJECT_ID}/packages/generic/${PACKAGE_NAME}/${PACKAGE_VERSION}/Buddy-${PACKAGE_VERSION}-arm64.dmg","link_type":"package"},
  {"name":"macOS DMG (x64)","url":"${API_BASE}/projects/${PROJECT_ID}/packages/generic/${PACKAGE_NAME}/${PACKAGE_VERSION}/Buddy-${PACKAGE_VERSION}.dmg","link_type":"package"},
  {"name":"macOS ZIP (arm64)","url":"${API_BASE}/projects/${PROJECT_ID}/packages/generic/${PACKAGE_NAME}/${PACKAGE_VERSION}/Buddy-${PACKAGE_VERSION}-arm64-mac.zip","link_type":"package"},
  {"name":"macOS ZIP (x64)","url":"${API_BASE}/projects/${PROJECT_ID}/packages/generic/${PACKAGE_NAME}/${PACKAGE_VERSION}/Buddy-${PACKAGE_VERSION}-mac.zip","link_type":"package"},
  {"name":"Source (.tar.gz)","url":"${API_BASE}/projects/${PROJECT_ID}/packages/generic/${PACKAGE_NAME}/${PACKAGE_VERSION}/buddy-macos-${VERSION}-source.tar.gz","link_type":"package"},
  {"name":"Source (.zip)","url":"${API_BASE}/projects/${PROJECT_ID}/packages/generic/${PACKAGE_NAME}/${PACKAGE_VERSION}/buddy-macos-${VERSION}-source.zip","link_type":"package"}
]
EOF
)"
glab release create "$VERSION" \
  --name "Buddy ${VERSION}" \
  --notes "Release ${VERSION}" \
  --assets-links "$ASSETS_LINKS" \
  || echo "   Release already exists or assets already linked, continuing ✓"
echo "   Release created ✓"

# --- 9. Deploy to update server ---
echo ">> Deploying to update server..."
# Upload DMGs + ZIPs first
find release -maxdepth 1 \( -name '*.dmg' -o -name '*.zip' \) \
  -exec rsync -avz --password-file="$RSYNC_PASS_FILE" {} "$RSYNC_DEST" \;
# Upload latest-mac.yml last (atomic commit point)
find release -maxdepth 1 -name 'latest-mac.yml' \
  -exec rsync -avz --password-file="$RSYNC_PASS_FILE" {} "$RSYNC_DEST" \;
echo "   Deploy complete ✓"

echo ""
echo "=== Release ${VERSION} published! ==="
echo "  GitLab:   https://${GITLAB_HOST}/${PROJECT_PATH}/-/releases/${VERSION}"
echo "  Download: http://buddy.intra.weibo.cn/releases/"
