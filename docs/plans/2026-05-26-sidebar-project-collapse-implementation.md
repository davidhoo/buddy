# Sidebar Project Collapse Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add expandable and collapsible project sections to the chat sidebar.

**Architecture:** Keep the behavior local to `ChatSidebar`, where task grouping and project row rendering already live. Track collapsed project keys in component state backed by `localStorage`; render task rows only for expanded projects, including when a collapsed project contains the selected task.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, lucide-react.

---

### Task 1: Add Failing Tests

**Files:**
- Modify: `tests/unit/renderer/sidebar.test.tsx`

**Step 1: Write the failing tests**

Add tests that render the sidebar with two tasks in one project, click the project row, and verify the task rows disappear and return on the next click. Add a second test that clicks the project action buttons and verifies the task list remains visible.

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/unit/renderer/sidebar.test.tsx`

Expected: FAIL because project rows are not disclosure controls yet.

### Task 2: Implement Project Collapse

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`

**Step 1: Add local state**

Read and write `buddy.collapsedProjectKeys` using the same defensive `localStorage` pattern already used for pinned tasks.

**Step 2: Add toggle behavior**

Add a project row click handler that toggles the project key. Keep action button `stopPropagation()` calls.

**Step 3: Add visual indicator**

Use the existing folder icon slot as the disclosure indicator. Render `FolderOpen` when expanded and `Folder` when collapsed. Do not render a separate chevron.

**Step 4: Hide collapsed tasks**

Skip the task-list rendering block when the project is collapsed, even when the selected task belongs to the project.

**Step 5: Run focused test**

Run: `pnpm vitest run tests/unit/renderer/sidebar.test.tsx`

Expected: PASS.

### Task 3: Verify Broader Safety

**Files:**
- No further edits expected.

**Step 1: Run renderer/unit checks**

Run: `pnpm test`

Expected: PASS.

**Step 2: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS.
