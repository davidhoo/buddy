# Create-task Modal Inputs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the default task brief one extra visible line, visibly explain its attachment-paste support, and accept broad macOS/Linux-safe task directory names without allowing path traversal or control characters.

**Architecture:** Move task-ID policy into a dependency-free shared module. The renderer uses it for immediate feedback and character counting; `BuddyStore.createTask` uses it again before calculating a directory, so direct IPC calls cannot escape the task directory. The layout remains inside `CreateTaskModal`; task execution mode, queue coordination, task persistence format, and existing task IDs are untouched.

**Tech Stack:** TypeScript, React 18, Electron, Vitest, Tailwind CSS.

---

## Accepted contract

- A submitted task ID is the existing `trim()`-normalized string and remains the on-disk task-directory name.
- Accept any otherwise ordinary Unicode text, including Chinese punctuation, smart quotes, ASCII punctuation, spaces, emoji, and backslash. Examples: `feat: “任务名称” (v2) [macOS + Linux] #42` and `修复：引用「配置」& API`.
- Reject an empty result, `.` and `..`, `/`, C0/C1 control characters (including NUL/newlines), and a value exceeding 64 Unicode code points. `/` is the only macOS/Linux filename separator; `.` and `..` would make `path.join` resolve to an unintended directory.
- Preserve the existing automatic `_2`, `_3` collision suffix behavior. It applies after the user-supplied name has passed validation.
- The task-brief field changes from 160px to a 176px minimum height (one 16px text line). Its default content must not initially scroll at normal desktop modal sizes; longer user content continues to scroll within the textarea.
- The task-brief label includes a muted, inline note that images and files can be pasted directly into the field. It documents the existing `handlePaste` attachment behavior only; it must not change attachment storage, paste parsing, previews, or ordinary text pasting.

### Task 1: Define and test the shared task-ID policy

**Files:**
- Create: `src/shared/task-id.ts`
- Create: `tests/unit/shared/task-id.test.ts`

**Step 1: Write the failing shared-policy tests**

```ts
import { describe, expect, it } from 'vitest'
import { TASK_ID_MAX_CODE_POINTS, validateTaskId } from '../../../src/shared/task-id'

describe('validateTaskId', () => {
  it('accepts ordinary Unicode punctuation and emoji', () => {
    expect(validateTaskId('feat: “任务名称” (v2) [macOS + Linux] #42 🚀')).toEqual({
      value: 'feat: “任务名称” (v2) [macOS + Linux] #42 🚀',
      reason: null
    })
  })

  it.each(['', '   ', '.', '..', 'a/b', 'a\\nb', 'a\\u0000b'])(
    'rejects unsafe task ID %j',
    (value) => expect(validateTaskId(value).reason).not.toBeNull()
  )

  it('counts Unicode code points instead of UTF-16 code units', () => {
    expect(validateTaskId('🚀'.repeat(TASK_ID_MAX_CODE_POINTS)).reason).toBeNull()
    expect(validateTaskId('🚀'.repeat(TASK_ID_MAX_CODE_POINTS + 1)).reason).toBe('too_long')
  })
})
```

**Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/shared/task-id.test.ts`

Expected: FAIL because `src/shared/task-id.ts` does not exist.

**Step 3: Implement the minimal shared validator**

```ts
export const TASK_ID_MAX_CODE_POINTS = 64

export type TaskIdValidationReason =
  | 'empty'
  | 'too_long'
  | 'dot_segment'
  | 'path_separator'
  | 'control_character'

export function validateTaskId(input: string): {
  value: string
  reason: TaskIdValidationReason | null
} {
  const value = input.trim()
  if (!value) return { value, reason: 'empty' }
  if ([...value].length > TASK_ID_MAX_CODE_POINTS) return { value, reason: 'too_long' }
  if (value === '.' || value === '..') return { value, reason: 'dot_segment' }
  if (value.includes('/')) return { value, reason: 'path_separator' }
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(value)) return { value, reason: 'control_character' }
  return { value, reason: null }
}
```

Do not introduce a whitelist regex or Unicode normalization. The policy intentionally allows macOS/Linux-safe punctuation, including `\\`.

**Step 4: Run the shared test to verify it passes**

Run: `pnpm vitest run tests/unit/shared/task-id.test.ts`

Expected: PASS.

**Step 5: Commit the shared policy**

```bash
git add src/shared/task-id.ts tests/unit/shared/task-id.test.ts
git commit -m "feat: share task ID validation"
```

### Task 2: Enforce the policy before task-directory creation

**Files:**
- Modify: `src/main/buddy/store.ts:105-110`
- Modify: `tests/unit/main/buddy-store-write.test.ts:8-129`

**Step 1: Write the failing store tests**

Add a test that `BuddyStore.createTask()` accepts `feat: “任务名称” (v2) [macOS + Linux] #42` and writes files below that exact task directory. Add parameterized rejected IDs (`..`, `a/b`, `a\u0000b`) and assert each `createTask()` rejects before files are created outside the workspace `tasks` directory.

**Step 2: Run the store test to verify it fails**

Run: `pnpm vitest run tests/unit/main/buddy-store-write.test.ts`

Expected: the unsafe-ID cases currently either succeed or resolve outside the intended task directory.

**Step 3: Enforce validation at the storage boundary**

Import `validateTaskId` and add this as the first operation in `BuddyStore.createTask()`:

```ts
const validation = validateTaskId(input.task_id)
if (validation.reason) {
  throw new Error(`Invalid task ID: ${validation.reason}`)
}
const requestedTaskId = validation.value
```

Use `requestedTaskId` for `workspaceKeyForRepo()` fallback and `deduplicateTaskId()`. Do not change `taskDir()`, deduplication, schema parsing, queue coordination, or IPC channel names.

**Step 4: Run the store test to verify it passes**

Run: `pnpm vitest run tests/unit/main/buddy-store-write.test.ts`

Expected: PASS; accepted punctuation remains literal in the directory name, while unsafe IDs throw before `mkdir`.

**Step 5: Commit storage-boundary enforcement**

```bash
git add src/main/buddy/store.ts tests/unit/main/buddy-store-write.test.ts
git commit -m "fix: validate task IDs before directory creation"
```

### Task 3: Update the modal feedback, height, and translations

**Files:**
- Modify: `src/renderer/App.tsx:938-943,1023-1060`
- Modify: `src/renderer/lib/i18n.ts:414-417,837-840,1258-1261`
- Modify: `tests/unit/renderer/create-task-modal.test.tsx:58-154`

**Step 1: Write the failing renderer tests**

Add tests that:

1. entering `feat: “任务名称” (v2) [macOS + Linux] #42 🚀` enables submission and passes the exact trimmed ID to `onCreate`;
2. `a/b`, `.` and a 65-code-point emoji string disable submission and show `modal.create.taskNameError`;
3. the brief textarea has `rows={9}` and the `min-h-[176px]` class, rather than the old `h-[160px]` class;
4. the label area exposes the localized `modal.create.taskBriefPasteHint` note adjacent to `modal.create.taskBrief`.

**Step 2: Run the renderer test to verify it fails**

Run: `pnpm vitest run tests/unit/renderer/create-task-modal.test.tsx`

Expected: punctuation is rejected and the textarea still reports the old height.

**Step 3: Implement the UI with the shared validator**

- Import `TASK_ID_MAX_CODE_POINTS` and `validateTaskId` from `src/shared/task-id.ts`.
- Derive `taskIdValidation` once from the raw field value. Use `taskIdValidation.reason` for the existing error state and `taskIdValidation.value` as the value submitted by `handleSubmit`.
- Replace the current local whitelist regex and UTF-16 `length` counter with the shared validator and `[...taskIdValidation.value].length`.
- Render `modal.create.taskBriefPasteHint` as a muted inline `span` after the task-brief label. Use a compact flex row that can wrap at narrow widths; keep it above the textarea and before attachment previews so the note remains visible when attachments exist.
- Set the textarea to `rows={9}` and replace `h-[160px]` with `min-h-[176px]`; retain the existing padding, typography, borders, attachment handling, and the modal content area's `overflow-y-auto`.
- Revise all three locales' `modal.create.taskNameHint` and `modal.create.taskNameError` to describe the broad visible-character rule plus the `/`, control-character, `.`/`..`, and 64-character limits. Add only `modal.create.taskBriefPasteHint` for the new brief note; do not duplicate existing translation keys.

**Step 4: Run the renderer test to verify it passes**

Run: `pnpm vitest run tests/unit/renderer/create-task-modal.test.tsx`

Expected: PASS.

**Step 5: Commit the modal update**

```bash
git add src/renderer/App.tsx src/renderer/lib/i18n.ts tests/unit/renderer/create-task-modal.test.tsx
git commit -m "feat: broaden create-task input support"
```

### Task 4: Verify the complete change

**Files:**
- Verify only: files changed in Tasks 1-3

**Step 1: Run focused regression suites**

Run:

```bash
pnpm vitest run tests/unit/shared/task-id.test.ts tests/unit/main/buddy-store-write.test.ts tests/unit/renderer/create-task-modal.test.tsx
```

Expected: all three files pass.

**Step 2: Run repository-wide static and unit validation**

Run:

```bash
pnpm typecheck
pnpm test
git diff --check
```

Expected: all commands exit 0.

**Step 3: Perform the visual smoke check**

Run: `pnpm dev`

Open New task at the normal desktop window size. Verify the untouched default brief shows its final `- ` line without a textarea scrollbar and that the muted paste hint appears next to the task-brief label. Paste the accepted sample from Task 3, create a task, and confirm it appears in the sidebar. Paste an image and a clipboard file into the task brief, confirm the existing attachment previews appear, then reopen the created task and confirm its task ID and task brief are unchanged.

**Step 4: Verify invariants and rollback**

- Create one immediate and one queued task; confirm their existing execution modes and per-project FIFO behavior are unchanged.
- Roll back by reverting the three feature commits in reverse order. No data migration is involved; existing task directories and settings remain compatible.

**Step 5: Commit verification-only adjustments, if any**

```bash
git status --short
```

Expected: clean working tree. Do not make a release, publish artifacts, modify queue coordination, rename existing task directories, change attachment-paste behavior, or change the 64-character limit.
