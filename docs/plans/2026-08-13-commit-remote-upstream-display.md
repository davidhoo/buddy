# 提交弹窗远端与 Upstream 显示 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Buddy 的提交弹窗中，将当前上下排列的“远端”标签与下拉框改为同一行；只读显示 Git 已有 upstream 对应的 `remote/branch`，并允许任务运行期间正常提交和推送，不改变左下角“提交后推送”、Git 配置或 Git push 语义。

**Architecture:** `src/main/buddy/git.ts` 在现有 Git 状态读取中额外读取当前分支的 upstream，并以可选字段传给 Renderer。`CommitModal` 继续使用已有 remote 列表、项目级最后选择记忆和“提交后推送”复选框；远端选择仍位于现有内容区，只将远端标签与 select 合并为一行，并在某个 remote 与 upstream 的 remote 相同时追加 `(<remote>/<branch>)`。Renderer 移除 `isTaskRunning` 对打开和确认提交的拦截；不新增 Git 写操作，也不改变任务状态机。

**Tech Stack:** TypeScript、Electron、React 18、TanStack React Query、Vitest、Testing Library、系统 Git CLI。

---

## 任务说明

### 已确认交互

1. 不改动左下角“提交后推送”复选框的既有行为、默认值、禁用逻辑或实际 push 命令。
2. `remotes.length === 0` 时：保持现状——只显示“提交后推送”及“无远端”说明，复选框禁用；不显示远端标签或下拉框。
3. `remotes.length >= 1` 时：远端选择保留在现有弹窗内容区；将当前纵向的 `远端` 标签和 `[ ... ▾ ]` 下拉框改为同一行。左下角“提交后推送”区域的位置、布局和行为都保持不变。远端下拉框继续使用已有项目级 `buddy.lastRemote.<repoRoot>` 记忆；无有效记忆时选择既有的第一个 remote。
4. 当前分支存在 Git upstream 时，**仅**在该 upstream 对应的 remote 选项上追加 `(<remote>/<branch>)`。例：本地 `feature/login` 跟踪 `origin/main`，下拉框显示 `origin (origin/main)`；其他 remote 如 `backup` 仍只显示 `backup`。
5. 当前分支没有 upstream 时，不附加任何标记；所有选项只显示 remote 名称。Buddy 仍按现有行为让用户选择 remote 并执行当前的提交后推送流程。
6. 用户切换下拉框只影响现有本次推送目标与项目级记忆；不得写入或改写 `branch.*.remote`、`branch.*.merge`、`remote.pushDefault`、`push.default` 或其他 Git 配置。
7. 不在选择控件中显示 URL。该位置的目的仅是选择/确认 remote；URL 既长，会妨碍“远端标签 + 下拉框”同一行的紧凑布局。
8. 当前任务处于 `RUNNING_*` 或 `PINGING` 时，文件状态中的“提交并推送”入口仍可用；打开弹窗后的确认提交按钮也必须可用。任务运行状态不得作为提交或推送的禁用条件。

### 概念边界

- `remote` 是远端仓库名称，例如 `origin`、`backup`；Buddy 根据已有 remote 列表供用户选择。
- `upstream` 是当前本地分支的默认跟踪目标，例如 `origin/main`，包含 remote 和目标分支两个部分；它不是一个新的 remote 名称。
- 本任务只读取并显示 upstream，目的是让用户看见项目自身 Git 已确定的默认关联；Git 关联的创建和管理仍由项目/Git 自身负责。

### 数据契约

在 `GitStatusResult` 中增加可选的当前分支 upstream 描述，避免把 UI 格式化字符串散落在主进程：

```ts
export interface GitUpstream {
  remote: string
  branch: string
}

export interface GitStatusResult {
  // existing fields
  upstream: GitUpstream | null
}
```

- 无当前分支、分离 HEAD、或当前分支未配置 upstream 时：`upstream: null`。
- 配置 `branch.<name>.remote=<remote>` 和 `branch.<name>.merge=refs/heads/<branch>` 时：返回 `{ remote, branch }`。
- 不将 `refs/heads/` 暴露给 Renderer；UI 只需要 `origin/main` 这种形式。
- 读取异常应降级为 `null`，不得使整个 Git 状态查询失败。

### 文件与责任

| 文件 | 改动 |
| --- | --- |
| `src/shared/types.ts` | 添加 `GitUpstream`，并在 `GitStatusResult` 中添加 `upstream`。 |
| `src/main/buddy/git.ts` | 复用/整理当前分支 upstream 读取，随 `getGitStatus()` 返回。不得改动 `gitCommitAndPush()` 的决策与写入行为。 |
| `src/renderer/components/FileStatus.tsx` | 保留远端 `<select>` 在内容区；将其与“远端”标签排为同一行，按 `gitStatus.upstream` 格式化 option 标签，并移除 `isTaskRunning` 对提交入口和确认提交的禁用。 |
| `src/renderer/components/StatusBar.tsx` | 停止向 `FileStatus` 和 `CommitModal` 传递仅用于禁用提交的 `isTaskRunning` prop。 |
| `tests/unit/main/buddy-git.test.ts` | 覆盖有 upstream、无 upstream、分离 HEAD 或读取失败时的状态数据。 |
| `tests/unit/renderer/file-status.test.tsx` | 覆盖同一行布局语义、upstream 标签、无 upstream 标签、现有无 remote 行为，以及任务运行时仍可提交。 |

## 实施步骤

### Task 1: 扩展 Git 状态的只读 upstream 数据

**Files:**

- Modify: `src/shared/types.ts:GitStatusResult`
- Modify: `src/main/buddy/git.ts:getGitStatus`
- Test: `tests/unit/main/buddy-git.test.ts`

**Step 1: 写失败测试**

在临时 Git 仓库中建立本地 bare remote，并为当前分支设置 `origin/main` upstream。断言 `getGitStatus(dir).upstream` 是 `{ remote: 'origin', branch: 'main' }`。

再覆盖没有 upstream 的新分支，断言为 `null`；至少断言既有 `branch`、`remotes` 数据仍可读取。

**Step 2: 运行失败测试**

```bash
pnpm vitest run tests/unit/main/buddy-git.test.ts
```

预期：新 upstream 断言失败，因为当前返回类型和结果没有该字段。

**Step 3: 最小实现**

1. 在共享类型定义 `GitUpstream` 和 `GitStatusResult.upstream`。
2. 在主进程读取当前 branch 的 `branch.<branch>.remote` 与 `branch.<branch>.merge`；只接受 `refs/heads/` 前缀并去除前缀。
3. 将该读取并入 `getGitStatus()` 的并行查询；任何失败或分离 HEAD 返回 `null`。
4. 不修改 `gitCommitAndPush()`、`getGitRemotes()`、IPC、preload 或提交结果结构。

**Step 4: 运行通过测试**

```bash
pnpm vitest run tests/unit/main/buddy-git.test.ts
```

预期：通过，且不依赖网络或用户仓库。

**Step 5: 提交**

```bash
git add src/shared/types.ts src/main/buddy/git.ts tests/unit/main/buddy-git.test.ts
git commit -m "feat(git): expose branch upstream in status"
```

### Task 2: 紧凑显示远端、标记 Git 默认关联，并解除任务运行期提交禁用

**Files:**

- Modify: `src/renderer/components/FileStatus.tsx:CommitModal`
- Modify: `src/renderer/components/StatusBar.tsx:FileStatusSection / CommitModal`
- Test: `tests/unit/renderer/file-status.test.tsx`

**Step 1: 写失败测试**

为 `CommitModal` 加以下断言：

1. `remotes=[origin, backup]` 且 `upstream={remote:'origin', branch:'main'}` 时，remote select 的选项文本为 `origin (origin/main)` 与 `backup`。
2. `upstream=null` 时，`origin` 的选项文本只为 `origin`，不出现括号或虚构的默认目标。
3. `remotes=[]` 时不出现 remote select，但“提交后推送”复选框仍禁用并保留“无远端”。
4. 含 remote 时，`git.remote` 文案和 remote select 位于同一个内容区行容器；左下角的 push checkbox 和 `git.push` 文案仍位于原来的底部容器，且布局不变。
5. 变更 `selectedRemote` 仍写入 `buddy.lastRemote.<repoRoot>`；本任务不得改变现有选择记忆测试的预期。
6. 以 `isTaskRunning=true` 渲染文件状态和提交弹窗：有变更及有效提交信息时，入口与确认提交按钮不含 `disabled`，点击确认后仍调用 `gitStageFiles` 和 `commitAndPush`。

**Step 2: 运行失败测试**

```bash
pnpm vitest run tests/unit/renderer/file-status.test.tsx
```

预期：upstream 标签与布局断言失败；现有测试中预期 URL 的断言需按新产品决定更新为 remote 名称。

**Step 3: 最小实现**

1. 保留内容区现有的“远端选择”块及其显示条件。
2. 将该块由纵向 `label` + select 改为同一个 flex 行容器；窄窗口允许换行，但常规宽度保持同一行。
3. 对每一项计算 label：当 `gitStatus.upstream?.remote === remote.name` 时输出 `${remote.name} (${upstream.remote}/${upstream.branch})`，否则只输出 `remote.name`。
4. 保留 select 的 `value`、`onChange`、localStorage effect、可用 remote 判断以及 `shouldPush` 的原有逻辑。
5. remote 为空时不创建 select，也不改变复选框禁用状态。
6. 不基于 upstream 自动改变当前选择，不为 remote 做排序，也不改变用户最后选择优先级。
7. 删除 `FileStatus` 和 `CommitModal` 中 `isTaskRunning` 对 `disabled`、`title` 和 `handleCommit` 早退的影响；从 `StatusBar` 删除这两个仅用于该禁用的 prop 传递。保留提交按钮对无变更、空消息、空文件选择和进行中的 stage/generate/commit 的既有禁用。
8. 删除因不再使用而多余的 `git.commitDisabledWhileRunning` i18n 文案；不得删除其他 Git 文案。

**Step 4: 运行通过测试**

```bash
pnpm vitest run tests/unit/renderer/file-status.test.tsx
```

预期：通过；测试中明确证明没有 upstream 不显示标记，有 upstream 只标记其 remote。

**Step 5: 提交**

```bash
git add src/renderer/components/FileStatus.tsx src/renderer/components/StatusBar.tsx src/renderer/lib/i18n.ts tests/unit/renderer/file-status.test.tsx
git commit -m "feat(ui): show upstream in commit remote selector"
```

### Task 3: 整体验证与回归边界

**Files:**

- Verify: `src/main/buddy/git.ts`
- Verify: `src/renderer/components/FileStatus.tsx`
- Verify: `tests/unit/main/buddy-git.test.ts`
- Verify: `tests/unit/renderer/file-status.test.tsx`

**Step 1: 运行聚焦测试**

```bash
pnpm vitest run tests/unit/main/buddy-git.test.ts tests/unit/renderer/file-status.test.tsx
```

预期：全绿。

**Step 2: 运行类型检查**

```bash
pnpm typecheck
```

预期：退出码 0。

**Step 3: 人工验收**

在三个本地测试仓库中打开提交弹窗：

1. 无 remote：没有远端下拉框，“提交后推送”禁用。
2. 仅 `origin` 且 `main -> origin/main`：内容区一行显示 `远端 [ origin (origin/main) ▾ ]`；左下角“提交后推送”维持原位置。
3. `origin`、`backup`，且当前分支跟踪 `origin/main`：只给 `origin` 添加 `(origin/main)`；选择 `backup` 后重开弹窗仍选择 `backup`，但 Git upstream 配置保持 `origin/main`。
4. 在任务运行中且存在未提交变更时：文件状态的“提交并推送”可点击；弹窗中填写提交信息后确认提交可点击，并能发起既有提交/推送调用。

使用 `git config --get branch.<branch>.remote` 和 `git config --get branch.<branch>.merge` 在操作前后比对，确认 UI 打开、选择 remote、提交（含推送）均未因本任务新增代码改写 upstream。

**Step 4: 提交**

```bash
git add src/shared/types.ts src/main/buddy/git.ts src/renderer/components/FileStatus.tsx tests/unit/main/buddy-git.test.ts tests/unit/renderer/file-status.test.tsx
git commit -m "test: verify commit remote upstream display"
```

仅在该阶段实际有未提交的验证性改动时才执行此 commit；不得创建空提交。

## 验收标准

- 有 remote 时，内容区的远端标签与下拉框在同一行；左下角“提交后推送”保持原位置与布局。无 remote 时不显示远端选择。
- 已配置 `origin/main` upstream 时，下拉选项显示 `origin (origin/main)`；标记不改变 select 值与推送目标。
- 无 upstream 时只显示 remote 名称，并继续使用项目级上次选择。
- Buddy 在本任务范围内不写入任何 upstream 或 Git 推送默认配置。
- 左下角“提交后推送”的可用性、默认状态和既有 push 语义保持不变。
- 任务运行状态不再禁用文件状态的提交入口或弹窗确认提交；其余既有提交禁用条件保持不变。
- 两个聚焦测试文件与 `pnpm typecheck` 均通过。

## 回滚

回滚本功能涉及的提交即可恢复原远端 URL 展示与位置；不需要清理任何 Git 配置或用户数据，因为实现不产生 Git 配置写入，且只复用已有 localStorage remote 选择键。

## 不包含

- 不新增独立“推送”按钮、ahead/behind 状态、待推送计数或推送重试界面。
- 不更改提交后推送的默认选择、禁用规则、首次推送策略、实际 push refspec 或 `GitCommitPushResult`。
- 不自动建立、删除或修改 upstream；不增加设置 upstream 的 UI。
- 不新增/删除/编辑 remote、URL、凭据、SSH、代理或网络诊断功能。
- 不显示 remote URL，不修改提交信息生成、文件选择、暂存、快捷键、任务状态机或队列语义；仅取消任务运行状态对提交 UI 的禁用。
- 不发布版本、不生成安装包、不修改 `/Applications/Buddy.app`，也不改变任何其他仓库的 Git 配置或远端内容。
