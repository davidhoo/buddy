# Release Remote Verification Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every official Buddy GitHub Release remain Draft until its uploaded Apple Development artifacts have been downloaded again and passed the same signing and metadata checks as local artifacts.

**Architecture:** Generalize the existing artifact verifier so it can validate either `release/` or a downloaded directory. Add a read-only remote verifier and a Draft-aware publisher; `scripts/release.sh` delegates publishing to that publisher after local verification. Shell behavior is exercised through Vitest subprocess tests with fake `gh` and verifier executables, while final acceptance uses the real v1.2.15 assets read-only.

**Tech Stack:** Bash, GitHub CLI, macOS `codesign`/`hdiutil`/`ditto`, TypeScript, Vitest.

---

### Task 1: Make the artifact verifier directory-aware and authority-exact

**Files:**
- Modify: `scripts/verify-release-signing.sh`
- Create: `tests/unit/scripts/verify-release-signing-script.test.ts`

**Step 1: Write the failing directory test**

Create a Vitest test that runs:

```ts
const result = spawnSync('bash', [script, '9.9.9', fixtureDir], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: { ...process.env, CSC_NAME: 'Apple Development: Test User (TEAM)' }
})

expect(result.status).not.toBe(0)
expect(result.stderr + result.stdout).toContain(`${fixtureDir}/mac-arm64/Buddy.app`)
expect(result.stderr + result.stdout).not.toContain('release/mac-arm64/Buddy.app')
```

The empty fixture is intentional: it proves the selected directory propagates into validation paths.

**Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run tests/unit/scripts/verify-release-signing-script.test.ts
```

Expected: FAIL because the current script ignores the second argument and reports `release/mac-arm64/Buddy.app`.

**Step 3: Implement the optional artifact directory**

Add:

```bash
ARTIFACT_DIR="${2:-release}"
ARTIFACT_DIR="$(cd "$(dirname "$ARTIFACT_DIR")" && pwd)/$(basename "$ARTIFACT_DIR")"
```

Replace every hard-coded artifact path with `${ARTIFACT_DIR}/...`. Keep the one-argument invocation backward compatible.

**Step 4: Add the failing exact-authority test**

Put minimal App directories in the fixture and prepend a fake `codesign` executable to `PATH`. The fake returns a valid Team ID and bundle ID but reports:

```text
Authority=Apple Development: Wrong User (WRONG)
```

Run the verifier with `CSC_NAME='Apple Development: Test User (TEAM)'` and assert it reports `Authority is not Apple Development: Test User (TEAM)`.

**Step 5: Verify RED, then implement exact matching**

Run the focused test. Expected: FAIL because the current verifier accepts any `Authority=Apple Development` line.

Require `CSC_NAME` and use fixed-string matching:

```bash
EXPECTED_AUTHORITY="${CSC_NAME:?Set CSC_NAME to the Apple Development signing identity}"
if ! printf '%s\n' "$sig_output" | grep -Fq "Authority=${EXPECTED_AUTHORITY}"; then
  err "${label}: Authority is not ${EXPECTED_AUTHORITY}"
  return 1
fi
```

**Step 6: Run focused tests and syntax check**

```bash
pnpm vitest run tests/unit/scripts/verify-release-signing-script.test.ts
bash -n scripts/verify-release-signing.sh
```

Expected: PASS and exit 0.

**Step 7: Commit**

```bash
git add scripts/verify-release-signing.sh tests/unit/scripts/verify-release-signing-script.test.ts
git commit -m "test(release): make signing verifier reusable"
```

### Task 2: Add the remote download verifier

**Files:**
- Create: `scripts/verify-published-release.sh`
- Create: `tests/unit/scripts/verify-published-release-script.test.ts`

**Step 1: Write failing subprocess tests**

Use a fake `gh` executable that records arguments in `GH_LOG` and copies five fixture files into the `--dir` argument. Use a fake signing verifier selected through `VERIFY_RELEASE_SIGNING_SCRIPT`.

Cover:

```ts
it('downloads all five tagged assets and passes their directory to the verifier')
it('fails when GitHub download fails')
it('fails when downloaded artifact verification fails')
```

**Step 2: Run focused tests and verify RED**

```bash
pnpm vitest run tests/unit/scripts/verify-published-release-script.test.ts
```

Expected: FAIL because `scripts/verify-published-release.sh` does not exist.

**Step 3: Implement the remote verifier**

The script accepts `<version> <owner/repo>`, creates a temporary directory, downloads the exact five assets, verifies that each required file exists, and invokes:

```bash
bash "$VERIFY_RELEASE_SIGNING_SCRIPT" "$PACKAGE_VERSION" "$DOWNLOAD_DIR"
```

Use:

```bash
VERIFY_RELEASE_SIGNING_SCRIPT="${VERIFY_RELEASE_SIGNING_SCRIPT:-${PROJECT_ROOT}/scripts/verify-release-signing.sh}"
DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/buddy-release-verify.XXXXXX")"
trap 'rm -rf "$DOWNLOAD_DIR"' EXIT
```

`gh release download` must address the explicit tag, not `latest`.

**Step 4: Run focused tests and syntax check**

```bash
pnpm vitest run tests/unit/scripts/verify-published-release-script.test.ts
bash -n scripts/verify-published-release.sh
```

Expected: PASS and exit 0.

**Step 5: Commit**

```bash
git add scripts/verify-published-release.sh tests/unit/scripts/verify-published-release-script.test.ts
git commit -m "feat(release): verify uploaded artifacts remotely"
```

### Task 3: Add the Draft-aware publisher

**Files:**
- Create: `scripts/publish-release.sh`
- Create: `tests/unit/scripts/publish-release-script.test.ts`

**Step 1: Write failing state-machine tests**

Create fake required artifacts and a fake `gh` that records every call. Select a fake remote verifier through `VERIFY_PUBLISHED_RELEASE_SCRIPT`.

Cover:

```ts
it('creates a missing release as draft and publishes only after verification')
it('moves an existing release to draft before clobbering assets')
it('uploads latest-mac.yml after every package and source archive')
it('leaves the release draft when remote verification fails')
it('returns a published release to draft when latest-feed validation fails')
```

**Step 2: Run focused tests and verify RED**

```bash
pnpm vitest run tests/unit/scripts/publish-release-script.test.ts
```

Expected: FAIL because `scripts/publish-release.sh` does not exist.

**Step 3: Implement Draft creation and safe upload order**

The publisher accepts `<version> <owner/repo>` and requires all seven local assets. If the release exists, call `gh release edit <tag> --draft`; otherwise call `gh release create ... --draft`.

Upload in this order:

```bash
PACKAGE_FILES=(four DMG/ZIP paths and two source archives)
for file in "${PACKAGE_FILES[@]}"; do
  gh release upload "$VERSION" "$file" --repo "$GITHUB_REPO" --clobber
done
gh release upload "$VERSION" "release/latest-mac.yml" --repo "$GITHUB_REPO" --clobber
```

Then run the remote verifier. Only after exit 0 call:

```bash
gh release edit "$VERSION" --repo "$GITHUB_REPO" --draft=false --latest
```

**Step 4: Implement post-publication feed validation and rollback**

Check that `gh api repos/${GITHUB_REPO}/releases/latest --jq .tag_name` equals the target tag, download `releases/latest/download/latest-mac.yml`, and compare it with the local file. Install an EXIT trap after publication that returns the Release to Draft unless feed validation completes.

**Step 5: Run focused tests and syntax check**

```bash
pnpm vitest run tests/unit/scripts/publish-release-script.test.ts
bash -n scripts/publish-release.sh
```

Expected: PASS and exit 0.

**Step 6: Commit**

```bash
git add scripts/publish-release.sh tests/unit/scripts/publish-release-script.test.ts
git commit -m "feat(release): publish only after remote verification"
```

### Task 4: Make the official release flow use the publisher

**Files:**
- Modify: `scripts/release.sh:4-16,132-169`
- Modify: `tests/unit/scripts/publish-release-script.test.ts`

**Step 1: Write the failing contract assertion**

Add a test that reads `scripts/release.sh` and asserts it calls:

```text
bash scripts/publish-release.sh "$VERSION" "$GITHUB_REPO"
```

and no longer contains direct `gh release upload` or a non-Draft `gh release create` path.

**Step 2: Run the focused test and verify RED**

```bash
pnpm vitest run tests/unit/scripts/publish-release-script.test.ts
```

Expected: FAIL because `release.sh` still publishes directly.

**Step 3: Delegate publication**

Replace the current step 7 implementation with one call to `scripts/publish-release.sh`. Update the flow comment to include Draft upload, remote verification, and publication.

**Step 4: Run focused tests and syntax checks**

```bash
pnpm vitest run tests/unit/scripts/publish-release-script.test.ts
bash -n scripts/release.sh scripts/publish-release.sh scripts/verify-published-release.sh scripts/verify-release-signing.sh
```

Expected: PASS and exit 0.

**Step 5: Commit**

```bash
git add scripts/release.sh tests/unit/scripts/publish-release-script.test.ts
git commit -m "fix(release): enforce verified draft publication"
```

### Task 5: Align repository guidance and Actor memory

**Files:**
- Modify: `AGENTS.md:10-23`
- Modify: `docs/RELEASE.md`
- Modify outside repository: `/Users/david/.claude/projects/-Users-david-SynologyDrive-Projects-github-buddy/memory/release-autonomous.md`

**Step 1: Update repository contracts**

Document:

- `pnpm dist` is local adhoc only and must never be uploaded.
- Official publishing uses `CSC_NAME='Apple Development: ...' scripts/release.sh vX.Y.Z`.
- The Release remains Draft until remote App/ZIP/DMG/signature/feed checks pass.
- `adhoc`, a missing Team ID, or skipped signing is a release blocker.
- Internal Apple Development publishing intentionally remains unnotarized.

Remove the stale Developer ID/notarization instructions that contradict the implemented internal channel.

**Step 2: Update the local Actor memory**

Replace the old unsigned steps with the official signed command and reviewer evidence requirements. Preserve the user's preference that releases run end-to-end without pausing except for genuine blockers.

**Step 3: Check for contradictory guidance**

```bash
rg -n "pnpm dist|unsigned|adhoc|release\.sh|remote|远端|验签" AGENTS.md docs/RELEASE.md /Users/david/.claude/projects/-Users-david-SynologyDrive-Projects-github-buddy/memory/release-autonomous.md
```

Expected: every `pnpm dist` reference labels it local-only; official publishing points to `scripts/release.sh`.

**Step 4: Commit repository documentation**

```bash
git add AGENTS.md docs/RELEASE.md
git commit -m "docs(release): require signed verified publishing"
```

The Actor memory is local operational state and is not included in the Git commit.

### Task 6: Run full verification and live read-only acceptance

**Files:**
- No production file changes expected

**Step 1: Run focused release tests**

```bash
pnpm vitest run tests/unit/scripts
```

Expected: all release script tests pass.

**Step 2: Run full repository verification**

```bash
pnpm test
pnpm typecheck
git diff --check main...HEAD
bash -n scripts/release.sh scripts/publish-release.sh scripts/verify-published-release.sh scripts/verify-release-signing.sh
```

Expected: all commands exit 0.

**Step 3: Verify the repaired real Release read-only**

```bash
CSC_NAME='Apple Development: coolbor@gmail.com (LL5Q233Q8L)' \
  scripts/verify-published-release.sh v1.2.15 davidhoo/buddy
```

Expected: GitHub ARM64/x64 App, ZIP, DMG and `latest-mac.yml` all pass.

**Step 4: Inspect final history and worktree**

```bash
git status --short
git log --oneline main..HEAD
```

Expected: clean worktree and only the planned commits.

**Step 5: Integration checkpoint**

Use `superpowers:requesting-code-review` to review the completed branch, then use `superpowers:finishing-a-development-branch` to merge or publish according to the user's chosen integration path.
