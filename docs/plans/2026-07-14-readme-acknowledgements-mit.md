# README Acknowledgements and MIT License Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the linux.do acknowledgement and make the project's public license declarations consistently MIT.

**Architecture:** This is a documentation and package-metadata-only change. Update the README, add the standard MIT license text in `LICENCE`, and synchronize the `package.json` license field.

**Tech Stack:** Markdown, JSON

---

### Task 1: Update acknowledgements and license declarations

**Files:**
- Modify: `README.md:165`
- Create: `LICENCE`
- Modify: `package.json:23`

**Step 1: Update README**

Insert the following before the License section:

```markdown
## 致谢

感谢 [linux.do](https://linux.do/) 社区的反馈与支持。
```

Change the License section value from `ISC` to `MIT`.

**Step 2: Add the MIT license file**

Create `LICENCE` with the standard MIT license text and this copyright line:

```text
Copyright (c) 2026 David Hu
```

**Step 3: Synchronize package metadata**

Change `package.json` from:

```json
"license": "ISC"
```

to:

```json
"license": "MIT"
```

**Step 4: Verify the changes**

Run: `git diff --check`

Expected: no output and exit status 0.

Run: `node -e "const p=require('./package.json'); if (p.license !== 'MIT') process.exit(1)"`

Expected: no output and exit status 0.

Run: `rg -n 'linux\.do|## License|^MIT$|Copyright \(c\) 2026 David Hu' README.md LICENCE`

Expected: the acknowledgement, README MIT value, and MIT copyright line are present.
