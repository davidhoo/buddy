# Git 远端显示与首次推送修复 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让“提交并推送”弹窗只在仓库完全没有 remote 时隐藏远端区域；存在一个或多个 remote 时始终明确显示推送目标，并让没有 upstream 的当前分支可以首次推送，同时准确区分“提交失败”和“提交成功但推送失败”。

**Architecture:** 主进程不再解析 `git remote -v` 的展示文本，而是先列出 remote 名称，再读取每个 remote 的 push URL。提交仍先产生本地 commit；推送阶段根据当前分支是否已有 upstream 选择显式 refspec，无 upstream 时在所选 remote 建立同名跟踪分支。主进程通过结构化结果把提交和推送两个阶段分别传回 Renderer，Renderer 始终展示实际 remote，并对部分成功给出准确反馈。

**Tech Stack:** TypeScript、Electron、React 18、TanStack React Query、Vitest、Testing Library、系统 Git CLI。

---

## 任务说明

### 背景与已确认根因

当前实现存在三个相互关联的问题：

1. `src/renderer/components/FileStatus.tsx` 仅在 `gitStatus.remotes.length > 1` 时渲染远端下拉框。因此 Relive 只有一个标准 `origin` 时，远端区域完全消失，用户无法确认实际推送目标。
2. `src/main/buddy/git.ts` 通过正则只解析 `git remote -v` 的 `(fetch)` 行。只有 push URL、fetch URL 缺失或展示形式变化的 remote 会被漏掉，并且错误被吞掉为 `[]`。
3. `gitCommitAndPush()` 在 commit 后固定执行 `git push <remote>`。Buddy 的“创建新分支”只执行 `git checkout -b`，不会建立 upstream；在 Git 默认 `push.default=simple` 下，新分支即使已有 `origin` 也会报 `The current branch ... has no upstream branch`。

2026-08-12 对 Relive 的只读核查结果：

- 仓库只有 `origin = git@github.com:davidhoo/relive.git`，fetch/push URL 均有效。
- 当前 `main` 已跟踪 `origin/main`，`git push --dry-run origin` 返回 `Everything up-to-date`，远端自身正常。
- 本地存在多个尚未建立 upstream、远端也没有同名分支的开发分支；在这些分支上使用当前 Buddy 首次推送会稳定触发上述错误。

### 固定交互与行为决策

#### Remote 显示

- `remotes.length === 0`：不显示远端选择区域；“提交后推送”复选框保持禁用，并继续显示既有“无远端”说明。
- `remotes.length >= 1`：始终显示远端下拉框。
- 只有一个 remote 时，下拉框仍显示唯一选项，例如 `origin (git@github.com:davidhoo/relive.git)`；不得因为无法切换而隐藏推送目标。
- 多个 remote 时继续允许选择，并按仓库路径复用既有 `buddy.lastRemote.<repoRoot>` 记忆逻辑。
- 本地记忆的 remote 已被删除时，回退到当前 remote 列表第一项；无 remote 时内部选择值使用空字符串，不伪造 `origin`。
- 下拉框 URL 表示 Git 实际用于 push 的 URL，而不是假定 fetch URL 与 push URL 相同。

#### 推送语义

- 用户取消“提交后推送”时只创建本地 commit，不检查或修改 upstream。
- 当前分支没有 upstream 时，首次推送到所选 remote 的同名分支，并在成功后建立 upstream；等价语义为：

  ```bash
  git push --set-upstream <selected-remote> HEAD:refs/heads/<current-branch>
  ```

- 当前分支已有 upstream，且 upstream remote 等于所选 remote 时，显式推送 `HEAD` 到既有 upstream 的 merge ref；不得依赖 `push.default` 推断目标。
- 当前分支已有 upstream，但用户选择另一个 remote 时，推送到另一个 remote 的同名分支，但不得改写原 upstream。
- 不修改用户的本地或全局 `push.default`、`push.autoSetupRemote`、`remote.pushDefault` 等 Git 配置。
- 不把“存在名为 origin 的 remote”误判为“当前分支已有 upstream”；remote 名称和分支跟踪关系是两个独立概念。

#### 提交与推送结果

- `git commit` 失败：整个操作失败，弹窗保持打开，显示既有“提交失败”反馈。
- `git commit` 成功且未请求 push：返回“仅提交成功”。
- `git commit` 与 push 均成功：返回“提交并推送成功”。
- `git commit` 成功但 push 失败：不得再显示“提交失败”；返回 commit hash、所选 remote 和 Git 原始 push 错误，显示“已提交，但推送失败”。
- push 失败后本地 commit 必须保留；关闭提交弹窗并刷新 Git 状态，防止用户对已经提交的同一批文件再次点击提交。
- 身份认证、网络、non-fast-forward、保护分支等 Git stderr 必须保留在反馈中，不转换成模糊的“远端错误”。

### 数据契约

在 `src/shared/types.ts` 增加：

```ts
export type GitPushStatus = 'not_requested' | 'pushed' | 'failed'

export interface GitCommitPushResult {
  commitHash: string
  pushStatus: GitPushStatus
  remote: string | null
  upstreamCreated: boolean
  pushError: string | null
}
```

字段语义固定为：

- `not_requested`：`remote=null`、`upstreamCreated=false`、`pushError=null`。
- `pushed`：`remote` 为实际选择值，`pushError=null`；仅首次成功建立 upstream 时 `upstreamCreated=true`。
- `failed`：本地 commit 已成功；`remote` 为失败目标，`upstreamCreated=false`，`pushError` 为 Git stderr。

### 不包含

- 不修改 Relive 仓库的 Git 配置、分支、commit、tag 或远端内容。
- 不自动推送 Relive 当前遗留的无 upstream 分支。
- 不新增 remote 管理、添加/删除 remote、编辑 URL 或远端连通性测试界面。
- 不修改 Buddy 分支创建/切换弹窗的交互；upstream 只在用户实际请求首次 push 且 push 成功后建立。
- 不增加自动重试、凭据管理、SSH key 管理、代理设置或 GitHub 登录逻辑。
- 不自动 force push，不绕过 non-fast-forward、保护分支或服务端 hook。
- 不改变文件选择、暂存、提交信息生成、快捷键、任务状态机或队列语义。
- 不发布新版本、不生成安装包、不替换 `/Applications/Buddy.app`。

---

### Task 1: 改为按 remote 名称读取真实 push URL

**Files:**
- Modify: `src/main/buddy/git.ts:110-126`
- Test: `tests/unit/main/buddy-git.test.ts`

**Step 1: 写失败测试——标准 remote、单 remote 和 push-only remote**

在 `tests/unit/main/buddy-git.test.ts` 导入 `getGitRemotes`，增加以下覆盖：

1. 普通 `origin` 返回一项 `{ name: 'origin', url: <configured-url> }`。
2. 两个 remote 按 `git remote` 输出顺序全部返回。
3. 使用独立 push URL 时返回 push URL，而不是 fetch URL。
4. 清除 `remote.origin.url`、仅保留 `remote.origin.pushurl` 时仍能发现 `origin`。
5. 没有 remote 时返回 `[]`。

测试只使用临时目录和本地路径，不访问网络。

**Step 2: 运行测试确认失败**

Run:

```bash
pnpm vitest run tests/unit/main/buddy-git.test.ts
```

Expected: push-only remote 被当前 `(fetch)` 正则漏掉，测试 FAIL。

**Step 3: 实现名称与 push URL 分离读取**

将 `getGitRemotes()` 改为：

```ts
export async function getGitRemotes(cwd: string): Promise<GitRemote[]> {
  try {
    const output = await execGit(['remote'], cwd)
    const names = output.split('\n').map(name => name.trim()).filter(Boolean)
    const remotes = await Promise.all(names.map(async (name) => {
      const url = await execGit(['remote', 'get-url', '--push', name], cwd).catch(() => '')
      return url ? { name, url: url.split('\n')[0] } : null
    }))
    return remotes.filter((remote): remote is GitRemote => remote !== null)
  } catch {
    return []
  }
}
```

不得继续解析 `git remote -v` 的 `(fetch)/(push)` 展示文本。单个 remote URL 读取失败时只跳过该项，不得抹掉其他有效 remote。

**Step 4: 运行聚焦测试**

Run:

```bash
pnpm vitest run tests/unit/main/buddy-git.test.ts
```

Expected: 新增 remote 用例 PASS，既有 Git 状态、diff 和暂存用例仍 PASS。

**Step 5: 提交 remote 发现修复**

```bash
git add src/main/buddy/git.ts tests/unit/main/buddy-git.test.ts
git commit -m "fix(git): discover push remotes reliably"
```

---

### Task 2: 实现分支感知的首次推送和结构化部分成功结果

**Files:**
- Modify: `src/shared/types.ts:337-349`
- Modify: `src/main/buddy/git.ts:267-280`
- Modify: `src/main/buddy/service.ts:15-33,215-217`
- Modify: `src/main/ipc/buddy-handlers.ts:1-48`
- Modify: `src/preload/buddy-api.ts:1-18,68-75`
- Modify: `src/renderer/lib/api.ts:1-20,64-65`
- Modify: `src/renderer/hooks/useBuddy.ts:220-257`
- Test: `tests/unit/main/buddy-git.test.ts`
- Test: `tests/unit/preload/buddy-api.test.ts`

**Step 1: 写失败测试——首次推送、已有 upstream、切换 remote 和部分成功**

在 `tests/unit/main/buddy-git.test.ts` 使用临时工作仓库与本地 bare remote，增加：

1. `push=false` 返回 `pushStatus='not_requested'`，不要求 remote 存在。
2. 当前分支没有 upstream 时，commit 后首次推送成功，bare remote 出现同名分支，`@{upstream}` 变为 `origin/<branch>`，结果为 `upstreamCreated=true`。
3. 已有 `origin/<branch>` upstream 时再次推送成功，结果为 `upstreamCreated=false`。
4. 已跟踪 `origin/<branch>`、但选择第二个 remote `backup` 时，commit 被推到 `backup` 的同名分支，原 upstream 仍为 `origin/<branch>`。
5. remote 路径不可用时，Promise 不因 push 阶段 reject，而是返回 `pushStatus='failed'`；`commitHash` 等于本地 `HEAD`，`pushError` 包含 Git 原始错误，本地 commit 保留。
6. `git commit` 本身失败时仍 reject，不得伪装成 push 部分成功。

**Step 2: 运行测试确认失败**

Run:

```bash
pnpm vitest run tests/unit/main/buddy-git.test.ts
```

Expected: 无 upstream 用例报 `has no upstream branch`，push 失败用例被整体 reject。

**Step 3: 增加共享结果类型并贯通 IPC 类型**

- 按“数据契约”增加 `GitPushStatus` 与 `GitCommitPushResult`。
- `BuddyCoreService.gitCommitAndPush()`、`BuddyServiceLike.gitCommitAndPush()` 和 `createBuddyPreloadApi().gitCommitAndPush()` 均返回 `Promise<GitCommitPushResult>`，不再使用 `unknown` 或局部 `{ commitHash: string }`。
- `src/renderer/lib/api.ts` 和 `useGitCommitAndPush()` 保留现有参数，但让返回值推断为 `GitCommitPushResult`。
- `buddy:gitCommitAndPush` IPC channel 名称和参数顺序保持不变。
- 在 `tests/unit/preload/buddy-api.test.ts` 断言调用仍为：

  ```ts
  ipc.invoke('buddy:gitCommitAndPush', repoRoot, message, remote, push)
  ```

**Step 4: 实现 upstream 查询与显式 refspec**

在 `src/main/buddy/git.ts` 增加仅供本模块使用的 helper：

```ts
interface GitUpstream {
  remote: string
  mergeRef: string
}

async function getGitUpstream(cwd: string, branch: string): Promise<GitUpstream | null> {
  if (!branch || branch === 'HEAD') return null
  const [remote, mergeRef] = await Promise.all([
    execGit(['config', '--get', `branch.${branch}.remote`], cwd).catch(() => ''),
    execGit(['config', '--get', `branch.${branch}.merge`], cwd).catch(() => '')
  ])
  return remote && mergeRef ? { remote, mergeRef } : null
}
```

推送参数固定按以下规则生成：

```ts
const branch = await getGitBranch(cwd)
const upstream = await getGitUpstream(cwd, branch)

const pushArgs = !upstream && branch !== 'HEAD'
  ? ['push', '--set-upstream', remote, `HEAD:refs/heads/${branch}`]
  : upstream?.remote === remote
    ? ['push', remote, `HEAD:${upstream.mergeRef}`]
    : ['push', remote, branch === 'HEAD' ? 'HEAD' : `HEAD:refs/heads/${branch}`]
```

完成 commit 并取得 hash 后执行 push；仅捕获 push 阶段错误并转换为 `GitCommitPushResult`：

```ts
try {
  await execGit(pushArgs, cwd)
  return {
    commitHash,
    pushStatus: 'pushed',
    remote,
    upstreamCreated: !upstream && branch !== 'HEAD',
    pushError: null
  }
} catch (error) {
  return {
    commitHash,
    pushStatus: 'failed',
    remote,
    upstreamCreated: false,
    pushError: error instanceof Error ? error.message : String(error)
  }
}
```

`push=false` 必须在 upstream 查询和 push 之前直接返回 `not_requested`。不得捕获或降级 `git commit` 错误。

**Step 5: 运行主进程与 preload 聚焦测试**

Run:

```bash
pnpm vitest run tests/unit/main/buddy-git.test.ts tests/unit/preload/buddy-api.test.ts tests/unit/main/buddy-handlers.test.ts
```

Expected: 所有测试 PASS；测试仅写临时本地 bare remote，不产生外部 push。

**Step 6: 提交推送语义修复**

```bash
git add src/shared/types.ts src/main/buddy/git.ts src/main/buddy/service.ts src/main/ipc/buddy-handlers.ts src/preload/buddy-api.ts src/renderer/lib/api.ts src/renderer/hooks/useBuddy.ts tests/unit/main/buddy-git.test.ts tests/unit/preload/buddy-api.test.ts
git commit -m "fix(git): support first push without upstream"
```

---

### Task 3: 一个或多个 remote 时始终显示选择器，并准确反馈 push 失败

**Files:**
- Modify: `src/renderer/components/FileStatus.tsx:203-225,379-408,533-553`
- Modify: `src/renderer/lib/i18n.ts:355-365,780-790,1202-1212`
- Test: `tests/unit/renderer/file-status.test.tsx`

**Step 1: 写失败测试——0/1/多 remote 显示矩阵**

在 `tests/unit/renderer/file-status.test.tsx` 增加以下断言：

1. `remotes=[]`：不存在 `git.remote` 标签和 remote `<select>`；push checkbox disabled，并显示 `git.noRemote`。
2. 只有 `origin`：存在 `git.remote` 标签；下拉框显示 `origin (git@github.com:test/repo.git)`，值为 `origin`；push checkbox enabled。
3. `origin + backup`：两个选项都显示，可以切换为 `backup`，并写入当前仓库的 `buddy.lastRemote.<repoRoot>`。
4. localStorage 保存的 remote 已不存在时回退到第一项；无 remote 时不得产生或保存假的 `origin`。

**Step 2: 写失败测试——区分 commit 失败和 push 部分成功**

调整 `useGitCommitAndPush` mock，使测试可控制 `mutateAsync` 返回值，增加：

1. `pushStatus='pushed'`：调用 `onSuccess(git.commitSuccess)`，关闭弹窗。
2. `pushStatus='not_requested'`：调用 `onSuccess(git.commitOnlySuccess)`，关闭弹窗。
3. `pushStatus='failed'`：调用 `onError(git.pushFailedAfterCommit)`，消息含 commit hash、remote 和原始 Git 错误；随后关闭弹窗，不调用 `onSuccess`。
4. mutation reject（commit 失败）：调用既有 `git.commitFailed`，弹窗保持打开，便于用户修正提交信息或暂存状态。

**Step 3: 运行 Renderer 测试确认失败**

Run:

```bash
pnpm vitest run tests/unit/renderer/file-status.test.tsx
```

Expected: 单 remote 选择器当前未渲染，部分成功当前被当作普通异常，测试 FAIL。

**Step 4: 实现 remote 显示规则**

- `selectedRemote` 无可用项时回退为 `''`，不再回退为字符串 `'origin'`。
- 将远端区域条件从：

  ```tsx
  gitStatus.remotes.length > 1
  ```

  改为：

  ```tsx
  gitStatus.remotes.length > 0
  ```

- 保留同一个 `<select>` 实现，单 remote 和多 remote 不维护两套 UI。
- `hasRemotes`、`shouldPush` 和 push checkbox 的既有关系保持不变。

**Step 5: 实现结构化结果反馈**

`handleCommit()` 按 `result.pushStatus` 分支：

```ts
if (result.pushStatus === 'failed') {
  onError(t('git.pushFailedAfterCommit', {
    hash: result.commitHash,
    remote: result.remote ?? selectedRemote,
    message: result.pushError ?? ''
  }))
  onClose()
  return
}

onSuccess(result.pushStatus === 'pushed'
  ? t('git.commitSuccess', { remote: result.remote ?? selectedRemote, hash: result.commitHash })
  : t('git.commitOnlySuccess', { hash: result.commitHash })
)
```

新增三语言文案：

```ts
'git.pushFailedAfterCommit': 'Committed ({hash}), but push to {remote} failed: {message}'
'git.pushFailedAfterCommit': '已提交（{hash}），但推送到 {remote} 失败：{message}'
'git.pushFailedAfterCommit': '已提交（{hash}），但推送到 {remote} 失敗：{message}'
```

不得复用 `git.commitFailed` 表示 push 失败。

**Step 6: 运行 Renderer 聚焦测试**

Run:

```bash
pnpm vitest run tests/unit/renderer/file-status.test.tsx tests/unit/renderer/status-bar.test.tsx
```

Expected: remote 显示矩阵和三种提交/推送结果全部 PASS；提交信息生成生命周期测试继续 PASS。

**Step 7: 提交界面和反馈修复**

```bash
git add src/renderer/components/FileStatus.tsx src/renderer/lib/i18n.ts tests/unit/renderer/file-status.test.tsx
git commit -m "fix(ui): always show available push remotes"
```

---

### Task 4: 完整验证与验收

**Files:**
- Verify only: Tasks 1-3 修改的文件

**Step 1: 运行完整聚焦回归**

Run:

```bash
pnpm vitest run tests/unit/main/buddy-git.test.ts tests/unit/main/buddy-handlers.test.ts tests/unit/preload/buddy-api.test.ts tests/unit/renderer/file-status.test.tsx tests/unit/renderer/status-bar.test.tsx
```

Expected: 全部 PASS。

**Step 2: 运行仓库级验证**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Expected: 所有命令退出码为 0。

**Step 3: 使用本地临时仓库做端到端验收**

准备一个临时工作仓库、两个本地 bare remote `origin`/`backup`，通过开发版 Buddy 验证：

1. 无 remote：远端区域隐藏，push disabled，只能提交。
2. 一个 `origin`：远端下拉框可见且只有一项。
3. 两个 remote：可以切换并记忆 `backup`。
4. 新建本地分支首次推送到 `origin`：远端出现同名分支，本地建立 `origin/<branch>` upstream。
5. 已跟踪 `origin/<branch>` 后选择 `backup` 推送：`backup` 出现同名分支，原 upstream 不变。
6. 将 remote 指向不存在路径后推送：本地 commit 存在，界面显示“已提交，但推送失败”，弹窗关闭，Git 状态刷新；不得再次提交同一批文件。

不得用真实 Relive remote 执行破坏性或试验性 push。

**Step 4: Relive 场景只读验收**

在 Relive 存在待提交改动时打开提交弹窗，仅确认：

- 远端区域可见；
- 唯一选项为 `origin (git@github.com:davidhoo/relive.git)`；
- 当前 `main` 的 upstream 仍为 `origin/main`；
- 未经明确批准，不点击真实推送按钮。

**Step 5: 验证回滚边界**

- 回滚只需按相反顺序 revert Tasks 1-3 的三个提交。
- 无持久化数据迁移；新增结果类型只存在于运行时 IPC 契约。
- 首次 push 已成功建立的 Git upstream 属于用户仓库状态，代码回滚不会自动删除；如需回退，应由用户明确执行 `git branch --unset-upstream <branch>`，实现或测试不得代为修改真实仓库。

**Step 6: 确认工作区**

```bash
git status --short
```

Expected: 实现提交完成后工作区干净。不要在本任务中 bump 版本、打 tag、发布 GitHub Release 或替换已安装应用。
