#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# verify-release-signing.sh — Verify final release artifacts are properly signed
#
# Usage: scripts/verify-release-signing.sh <version>
#
# Checks:
#   1. release/mac/ and release/mac-arm64/ App bundles exist
#   2. codesign --verify --deep --strict on both Apps
#   3. Signature is not adhoc, Authority=Apple Development, TeamIdentifier, Identifier
#   4. ZIP contents: extract and repeat verification
#   5. DMG: hdiutil verify, mount read-only, verify App inside
#   6. CFBundleShortVersionString / CFBundleVersion match target
#   7. latest-mac.yml: both ZIPs listed, filename/size/sha512 match
# =============================================================================

VERSION="${1:?Usage: verify-release-signing.sh <version>}"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

EXPECTED_TEAM_ID="XLDSS978CT"
EXPECTED_BUNDLE_ID="com.buddy.app"
FAIL=0

# --- helpers ---
err() { echo "  FAIL: $*" >&2; FAIL=1; }

verify_app_signature() {
  local app_path="$1"
  local label="$2"

  echo "  [${label}] Verifying ${app_path}..."

  [ -d "$app_path" ] || { err "${label}: App not found at ${app_path}"; return 1; }

  # codesign --verify --deep --strict
  if ! codesign --verify --deep --strict --verbose=2 "$app_path" 2>&1; then
    err "${label}: codesign --verify failed for ${app_path}"
    return 1
  fi

  # Extract signing info
  local sig_output
  sig_output="$(codesign -dv --verbose=4 "$app_path" 2>&1 || true)"

  # Signature must not be adhoc
  if echo "$sig_output" | grep -q 'Signature=adhoc'; then
    err "${label}: Signature is adhoc"
    return 1
  fi

  # Authority must include Apple Development
  if ! echo "$sig_output" | grep -q 'Authority=Apple Development'; then
    err "${label}: Authority is not Apple Development"
    return 1
  fi

  # TeamIdentifier
  if ! echo "$sig_output" | grep -q "TeamIdentifier=${EXPECTED_TEAM_ID}"; then
    err "${label}: TeamIdentifier is not ${EXPECTED_TEAM_ID}"
    return 1
  fi

  # Identifier
  if ! echo "$sig_output" | grep -q "Identifier=${EXPECTED_BUNDLE_ID}"; then
    err "${label}: Identifier is not ${EXPECTED_BUNDLE_ID}"
    return 1
  fi

  echo "  [${label}] ✓ Signature valid (Apple Development, ${EXPECTED_TEAM_ID})"
}

verify_app_version() {
  local app_path="$1"
  local label="$2"

  local info_plist="${app_path}/Contents/Info.plist"
  local short_version bundle_version

  short_version="$(defaults read "${info_plist}" CFBundleShortVersionString 2>/dev/null || true)"
  bundle_version="$(defaults read "${info_plist}" CFBundleVersion 2>/dev/null || true)"

  if [ "$short_version" != "$VERSION" ]; then
    err "${label}: CFBundleShortVersionString=${short_version}, expected ${VERSION}"
  fi
  if [ "$bundle_version" != "$VERSION" ]; then
    err "${label}: CFBundleVersion=${bundle_version}, expected ${VERSION}"
  fi

  if [ "$FAIL" -ne 0 ]; then return 1; fi
  echo "  [${label}] ✓ Version ${VERSION}"
}

verify_zip_contents() {
  local zip_path="$1"
  local label="$2"

  echo "  [${label}] Verifying ZIP: ${zip_path}..."
  [ -f "$zip_path" ] || { err "${label}: ZIP not found at ${zip_path}"; return 1; }

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap "rm -rf '${tmp_dir}'" RETURN

  # Extract and find .app
  ditto -x -k "$zip_path" "$tmp_dir" 2>/dev/null || unzip -q "$zip_path" -d "$tmp_dir" 2>/dev/null || {
    err "${label}: Failed to extract ZIP"
    return 1
  }

  local app_path
  app_path="$(find "$tmp_dir" -maxdepth 2 -type d -name '*.app' | head -1)"
  [ -n "$app_path" ] || { err "${label}: No .app found in ZIP"; return 1; }

  verify_app_signature "$app_path" "${label}"
  verify_app_version "$app_path" "${label}"
}

verify_dmg() {
  local dmg_path="$1"
  local label="$2"

  echo "  [${label}] Verifying DMG: ${dmg_path}..."
  [ -f "$dmg_path" ] || { err "${label}: DMG not found at ${dmg_path}"; return 1; }

  # hdiutil verify
  if ! hdiutil verify "$dmg_path" 2>&1; then
    err "${label}: hdiutil verify failed"
    return 1
  fi

  # Mount read-only
  local mount_point
  mount_point="$(mktemp -d)"
  trap "hdiutil detach '${mount_point}' -force 2>/dev/null; rm -rf '${mount_point}'" RETURN

  if ! hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mount_point" 2>&1; then
    err "${label}: Failed to mount DMG"
    return 1
  fi

  local app_path
  app_path="$(find "$mount_point" -maxdepth 2 -type d -name '*.app' | head -1)"
  [ -n "$app_path" ] || { err "${label}: No .app found in DMG"; return 1; }

  verify_app_signature "$app_path" "${label}"
  verify_app_version "$app_path" "${label}"
}

verify_latest_mac_yml() {
  local yml_path="release/latest-mac.yml"
  echo "  Verifying ${yml_path}..."

  [ -f "$yml_path" ] || { err "latest-mac.yml not found"; return 1; }

  local arm64_zip="Buddy-${VERSION}-arm64-mac.zip"
  local x64_zip="Buddy-${VERSION}-mac.zip"

  # Check both ZIPs are listed
  if ! grep -q "$arm64_zip" "$yml_path"; then
    err "latest-mac.yml missing ${arm64_zip}"
  fi
  if ! grep -q "$x64_zip" "$yml_path"; then
    err "latest-mac.yml missing ${x64_zip}"
  fi

  # Verify sha512 and size for each ZIP
  for zip_name in "$arm64_zip" "$x64_zip"; do
    local zip_path="release/${zip_name}"
    [ -f "$zip_path" ] || { err "File not found: ${zip_path}"; continue; }

    local actual_sha512 actual_size
    actual_sha512="$(shasum -a 512 "$zip_path" | awk '{print $1}')"
    actual_size="$(stat -f%z "$zip_path" 2>/dev/null || stat -c%s "$zip_path" 2>/dev/null)"

    # Extract sha512 from yml (comes after the filename line in the files block)
    local yml_sha512 yml_size
    yml_sha512="$(awk -v fname="$zip_name" '
      $0 ~ fname { found=1 }
      found && /sha512:/ { print $2; exit }
    ' "$yml_path")"
    yml_size="$(awk -v fname="$zip_name" '
      $0 ~ fname { found=1 }
      found && /size:/ { print $2; exit }
    ' "$yml_path")"

    if [ -z "$yml_sha512" ]; then
      err "latest-mac.yml: no sha512 for ${zip_name}"
    elif [ "$actual_sha512" != "$yml_sha512" ]; then
      err "latest-mac.yml: sha512 mismatch for ${zip_name}"
      err "  expected: ${yml_sha512}"
      err "  actual:   ${actual_sha512}"
    fi

    if [ -z "$yml_size" ]; then
      err "latest-mac.yml: no size for ${zip_name}"
    elif [ "$actual_size" != "$yml_size" ]; then
      err "latest-mac.yml: size mismatch for ${zip_name} (expected: ${yml_size}, actual: ${actual_size})"
    fi
  done

  if [ "$FAIL" -ne 0 ]; then return 1; fi
  echo "  ✓ latest-mac.yml valid"
}

# --- Main ---

echo "=== Release Signing Verification (v${VERSION}) ==="
echo ""

# 1. Verify build-output Apps
echo ">> Step 1: Verify build-output App bundles..."
verify_app_signature "release/mac-arm64/Buddy.app" "ARM64-build" || true
verify_app_signature "release/mac/Buddy.app" "x64-build" || true
verify_app_version "release/mac-arm64/Buddy.app" "ARM64-build" || true
verify_app_version "release/mac/Buddy.app" "x64-build" || true
echo ""

# 2. Verify ZIP contents
echo ">> Step 2: Verify ZIP contents..."
verify_zip_contents "release/Buddy-${VERSION}-arm64-mac.zip" "ARM64-zip" || true
verify_zip_contents "release/Buddy-${VERSION}-mac.zip" "x64-zip" || true
echo ""

# 3. Verify DMGs
echo ">> Step 3: Verify DMGs..."
verify_dmg "release/Buddy-${VERSION}-arm64.dmg" "ARM64-dmg" || true
verify_dmg "release/Buddy-${VERSION}.dmg" "x64-dmg" || true
echo ""

# 4. Verify latest-mac.yml
echo ">> Step 4: Verify latest-mac.yml..."
verify_latest_mac_yml || true
echo ""

if [ "$FAIL" -ne 0 ]; then
  echo "=== VERIFICATION FAILED ===" >&2
  exit 1
fi

echo "=== All signing verification passed ✓ ==="
