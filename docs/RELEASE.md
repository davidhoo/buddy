# Release Guide

Buddy has two deliberately separate macOS build paths: local adhoc builds and official internal GitHub Releases. Never upload artifacts from the local path.

## Local adhoc builds

Use this path only for local testing:

```bash
pnpm install --frozen-lockfile
pnpm dist
pnpm verify:dist
```

`pnpm dist` disables signing identity auto-discovery. electron-builder may apply an adhoc signature on ARM64 and may skip signing on x64. These artifacts are not compatible with the Apple Development signature chain used by automatic updates and must never be uploaded to GitHub Releases.

For an unpacked local App, use `pnpm package:dir`. The same local-only restriction applies.

## Official internal release

Official releases use the keychain identity `Apple Development: coolbor@gmail.com (LL5Q233Q8L)`, Team ID `XLDSS978CT`, and bundle ID `com.buddy.app`. This controlled internal channel intentionally does not use Apple notarization.

Confirm the identity is available:

```bash
security find-identity -v -p codesigning \
  | grep 'Apple Development: coolbor@gmail.com (LL5Q233Q8L)'
```

Prepare the version and changelog, then run the only supported publication entrypoint:

```bash
CSC_NAME='Apple Development: coolbor@gmail.com (LL5Q233Q8L)' \
  scripts/release.sh vX.Y.Z
```

Do not replace this command with `pnpm dist`, `gh release create`, or a manual `gh release upload` sequence.

## Release notes (required)

GitHub Release notes must be the matching Keep a Changelog section from `CHANGELOG.md`, not a placeholder like `Release vX.Y.Z`.

Required format (same as historical releases such as v1.3.1):

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- …

### Fixed
- …
```

Rules:

- Before publishing, `CHANGELOG.md` must already contain the `## [X.Y.Z] - YYYY-MM-DD` entry for this version.
- `scripts/publish-release.sh` extracts that section and passes it via `--notes-file` when creating or updating the Draft release.
- Missing or empty changelog entries, or placeholder-only notes (`Release vX.Y.Z`), are release blockers.
- Sections use `### Added` / `### Changed` / `### Fixed` / `### Removed` (omit empty ones), in Chinese, user-facing language.

Do not hand-write `gh release create --notes "Release …"`. The publisher owns notes from `CHANGELOG.md`.

## Enforced publication flow

The official script performs the following fail-closed sequence:

1. Require the explicit Apple Development identity.
2. Build ARM64 and x64 with forced code signing and no notarization.
3. Verify local App bundles, ZIP contents, DMG contents, version fields, Team ID, bundle ID, exact signing authority, and `latest-mac.yml` hashes and sizes.
4. Commit and push the version/tag.
5. Create the GitHub Release as Draft (or move an existing same-tag Release back to Draft), setting notes from the matching `CHANGELOG.md` section.
6. Upload DMG, ZIP, and source archives; upload `latest-mac.yml` last.
7. Download the five official assets from GitHub by tag and repeat the complete packaged-artifact verification.
8. Publish and mark Latest only after remote verification passes.
9. Verify that GitHub `releases/latest` points to the target tag and its `latest-mac.yml` matches the verified metadata.

If post-publication feed validation fails, the script returns the Release to Draft.

## Release blockers

Stop the release when any command reports:

- `Signature=adhoc`;
- `TeamIdentifier=not set` or a Team ID other than `XLDSS978CT`;
- `skipped macOS application code signing`;
- a signing authority different from the selected `CSC_NAME`;
- a missing GitHub asset;
- a ZIP/DMG/version/hash/metadata mismatch;
- failed remote download or verification;
- missing `CHANGELOG.md` entry for the version, or placeholder release notes such as `Release vX.Y.Z`.

A Release page containing correctly named files is not completion evidence. Reviewer approval requires the remote download verifier to pass. Release notes must match the Keep a Changelog section for that version.

## Read-only verification of an existing Release

To audit a published tag without changing it:

```bash
CSC_NAME='Apple Development: coolbor@gmail.com (LL5Q233Q8L)' \
  scripts/verify-published-release.sh vX.Y.Z davidhoo/buddy
```

The command downloads assets into a temporary directory, verifies them, and removes the temporary files. It does not edit the GitHub Release or the installed App.

## Recovery

When upload or remote verification fails, the Release remains Draft. Correct the build, credentials, network, or assets and rerun the same official command. Do not publish the Draft manually and do not bypass verification.
