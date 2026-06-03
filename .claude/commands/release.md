---
description: 发布新版本（生成 changelog、创建 Release、构建部署）
argument-hint: <version>  e.g. v1.2.0
allowed-tools: Bash(git *), Bash(gh *), Bash(pnpm *), Bash(node *), Bash(find *), Bash(chmod *), Bash(hdiutil *), Bash(scripts/release.sh*), Bash(sh scripts/*), Read, Edit
---

## Context

- Current version: !`node -e "console.log(require('./package.json').version)"`
- Latest tag: !`git describe --tags --abbrev=0 2>/dev/null || echo "none"`
- Commits since last tag: !`git log --oneline $(git describe --tags --abbrev=0 2>/dev/null)..HEAD 2>/dev/null || git log --oneline -20`
- User argument: $ARGUMENTS
- Release remote: !`git remote get-url upstream 2>/dev/null && echo "upstream" || echo "origin"`
- GitHub repo: !`gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "unknown"`

## Your task

Execute the full release process for version `$ARGUMENTS`. Follow these steps in order:

### Step 1: Detect release remote

- Determine which remote to use for pushing commits, tags, and releases:
  - If `upstream` remote exists, use `upstream`
  - Otherwise use `origin`
- Verify the chosen remote matches the project that `gh` targets (check `gh repo view`)
- If they don't match, warn the user and ask whether to proceed — mismatches cause releases and assets to land on different projects
- Store the chosen remote as `PUSH_REMOTE` for use in later steps

### Step 2: Validate version

- Extract version from `$ARGUMENTS` (e.g. `v1.2.0` → version is `1.2.0`)
- Validate it matches format `vX.Y.Z` where X, Y, Z are non-negative integers
- Ensure this version is greater than the current version in `package.json`
- If validation fails, tell the user and stop

### Step 3: Check for existing tag and release

- Run `git tag --list "$ARGUMENTS"` to check if the tag already exists
- Run `gh release view "$ARGUMENTS" 2>/dev/null` to check if the GitHub Release already exists
- If the tag already exists, this is a **re-run** scenario. Tell the user clearly that tag/release already exists and ask:
  - If they want to continue with build + deploy only (skip version bump, commit, tag, push, and Release creation)
  - Or if they want to abort
- If continuing a re-run, skip directly to Step 7

### Step 4: Generate changelog

1. Find the previous release tag (latest tag matching `v*`, or none if first release)
2. Collect all commits between that tag and HEAD, **excluding** `chore: release` commits:
   ```bash
   git log <prev-tag>..HEAD --format="%H %s" | grep -v "chore: release"
   ```
3. For each remaining commit, read the **actual diff** to understand what changed:
   ```bash
   git diff <commit>^..<commit> --stat        # changed files overview
   git diff <commit>^..<commit> --             # full diff (use for small commits)
   git log -1 --format="%B" <commit>           # full commit message body
   ```
   - For large commits, focus on the diff stat + key file diffs rather than reading every line
   - Prioritize understanding **user-facing impact** over implementation details
4. Based on the diffs and commit messages, write a Chinese changelog summarizing the **actual changes**:
   - Don't just restate commit messages — describe what the change means for users
   - Group related commits into a single changelog entry when they address the same concern
   - Use concise, user-facing language (not code-level jargon)
   - Categorize into these sections (omit empty sections):
     - `### Added` — new features and capabilities
     - `### Changed` — behavior changes, improvements, restructures
     - `### Fixed` — bug fixes and corrections
     - `### Removed` — removed features or cleanup
5. Example output:
   ```markdown
   ## [1.1.0] - 2026-05-29

   ### Added
   - 支持自定义 Actor 命令和超时时间

   ### Fixed
   - 修复打包后 .app 无法找到 kimi 命令的问题

   ### Changed
   - 优化 PATH 环境变量修复逻辑，始终合并常见工具路径
   ```
6. If there are no non-release commits since last tag, warn the user and ask whether to proceed

### Step 5: Update CHANGELOG.md

- Prepend the generated changelog entry to `CHANGELOG.md`, following the existing format:
  - `## [X.Y.Z] - YYYY-MM-DD` as the version header
  - Sections: `### Added`, `### Changed`, `### Fixed`, `### Removed` (omit empty sections)
  - Add a `---` separator before the next older entry
  - Add a link reference at the bottom: `[X.Y.Z]: https://github.com/davidhoo/buddy/releases/tag/$ARGUMENTS`
- The new entry goes ABOVE the previous entries, below the `# Changelog` header

### Step 6: Bump version and commit

- Update `version` field in `package.json` to the new version (without `v` prefix)
- `git add package.json CHANGELOG.md`
- `git commit -m "chore: release $ARGUMENTS"`

### Step 7: Create tag and push

- `git tag $ARGUMENTS`
- `git push $PUSH_REMOTE main $ARGUMENTS`
- If `$PUSH_REMOTE` is `upstream` AND `origin` also exists, also push to origin: `git push origin main $ARGUMENTS`

### Step 8: Create GitHub Release

- Use the **full changelog** (same content from Step 4, including version header and sections) as release notes
- If the changelog is multi-line, write it to a temp file first and use `--notes-file`:
  ```bash
  echo "$CHANGELOG" > /tmp/release-notes-$VERSION.md
  gh release create "$ARGUMENTS" --repo $GITHUB_REPO --title "Buddy $ARGUMENTS" --notes-file /tmp/release-notes-$VERSION.md
  rm /tmp/release-notes-$VERSION.md
  ```

### Step 9: Run release script

- Execute `scripts/release.sh $ARGUMENTS`
- This handles: build → verify → upload assets to GitHub Release
- Monitor the output and report progress to the user

### Step 10: Report results

When complete, summarize:
- Version released
- GitHub Release URL
- Download links for DMG and ZIP assets
- Any warnings or issues encountered

## Error handling

- If any step fails, stop and report the error clearly
- Do NOT attempt to continue after a failure
- Do NOT rollback automatically - tell the user what happened and let them decide
