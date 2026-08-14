# 提交弹窗远端 Git 地址显示 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Buddy 的提交弹窗远端下拉框中，同时显示远端名称、当前分支 upstream 标记和该远端的 Git push 地址，帮助用户在多个 `origin`、`upstream`、`backup` 间确认实际目标。

**Architecture:** 主进程已经在 `GitStatusResult.remotes` 中提供 `{ name, url }`，其中 `url` 来自 `git remote get-url --push <name>`；本任务只在 `CommitModal` 的 option 文案层使用这份已有数据。保持已有 remote 值、upstream 标记、项目级最后选择和提交后推送流程不变；在把 URL 拼入 option 前仅移除 HTTP(S) URL 中的 userinfo，避免令牌进入 UI。

**Tech Stack:** TypeScript、React 18、Vitest、Testing Library、原生 HTML `<select>`。

---

## 任务说明

### 背景与前置事实

当前 `CommitModal` 已将远端标签与下拉框放在同一行，并在当前分支存在 upstream 时，把匹配的选项显示为 `origin (origin/main)`。`GitRemote.url` 已经随 `gitStatus.remotes` 从主进程传到 Renderer，但当前 option 只显示 remote 名称/上游标记，无法让用户分辨这些 remote 实际对应的 Git 地址。

本计划是 `docs/plans/2026-08-13-commit-remote-upstream-display.md` 的后续增量：它以本计划为准，替换该文档“远端选择控件不显示 URL”的产品决定；不修改那份已提交计划的历史内容。

### 已确认交互

1. `remotes.length >= 1` 时，远端 select 的每个 option 按下面的顺序组成：
   - 无 upstream 标记：`<remote name>  <Git 地址>`，例如 `backup  git@github.com:team/backup.git`。
   - 当前分支 upstream 匹配该 remote：`<remote name> (<upstream remote>/<upstream branch>)  <Git 地址>`，例如 `origin (origin/main)  git@github.com:team/app.git`。
2. 只有匹配 `gitStatus.upstream.remote` 的 option 显示 `(remote/branch)`；其他 remote 不复制或伪造 upstream 标记。
3. option 的 `value` 仍是 remote 名称（如 `origin`），不是 URL 或格式化标签。用户切换 remote 后，既有 `buddy.lastRemote.<repoRoot>` 的项目级记忆继续只保存 remote 名称。
4. 对于 `https://` 或 `http://` 地址，若 authority 中含有 `userinfo@`，UI 仅显示去掉 userinfo 后的地址。例如 `https://alice:secret@example.com/a.git` 显示为 `https://example.com/a.git`。不显示用户名、密码或令牌。
5. 常见 SSH/scp 风格地址（如 `git@github.com:team/app.git`）没有 HTTP(S) userinfo，按原样显示；该 `git@` 是连接用户名的一部分，不应误删。
6. 地址过长时，远端选择控件保持现有 `flex-1 min-w-0` 与 `w-full` 的单行布局；由原生 select 在可用宽度内裁切显示，不新增第二行、tooltip、复制按钮或自定义下拉组件。
7. `remotes.length === 0` 时保持现状：不渲染远端下拉框，“提交后推送”仍显示原有无远端禁用状态。
8. 左下角“提交后推送”的位置、默认状态、禁用逻辑、push 命令、首次推送/upstream 建立逻辑均不变。

### 数据与安全边界

- 复用 `GitRemote.url`；不增加 `GitStatusResult` 字段，不改动 `getGitRemotes()`、IPC、preload 或 Renderer API。
- URL 仅用于显示，绝不作为 select value、localStorage 值或 Git 命令参数。
- 在 Renderer 中定义一个小型纯格式化逻辑（可为组件内函数）：先对 HTTP(S) URL 去除 `//` 后、`@` 前的 userinfo，再拼接 upstream 标签和 URL。对无法识别、空字符串或非 HTTP(S) 格式的 URL 不抛错。
- `git remote get-url --push` 的结果、remote 排序与选择优先级保持当前实现；本任务不写入任何 Git 配置。

### 文件与责任

| 文件 | 改动 |
| --- | --- |
| `src/renderer/components/FileStatus.tsx` | 在 `CommitModal` 远端 option 的格式化逻辑中加入安全处理后的 `GitRemote.url`。 |
| `tests/unit/renderer/file-status.test.tsx` | 更新既有“只显示名称”的断言，并覆盖 upstream、无 upstream、多个 remote 与 HTTP(S) userinfo 脱敏。 |

## 实施步骤

### Task 1: 为含 Git 地址的远端 option 写失败回归测试

**Files:**

- Modify: `tests/unit/renderer/file-status.test.tsx:describe('CommitModal remote display')`

**Step 1: 更新单远端预期**

将现有“单远端只显示名称（不显示 URL）”用例改为：给定 `{ name: 'origin', url: 'git@github.com:test/repo.git' }`，远端 select 的第一项文本严格为：

```ts
'origin  git@github.com:test/repo.git'
```

同时断言 option 的 `value` 和 select 当前值仍为 `origin`，`git.remote` 标签与“提交后推送”的既有可用性不变。

**Step 2: 增加 upstream 与多远端预期**

使用如下输入，断言 option 文案保持 remote 的原有顺序：

```ts
upstream: { remote: 'origin', branch: 'main' },
remotes: [
  { name: 'origin', url: 'git@github.com:test/origin.git' },
  { name: 'backup', url: 'https://github.com/test/backup.git' },
]
```

预期为：

```ts
[
  'origin (origin/main)  git@github.com:test/origin.git',
  'backup  https://github.com/test/backup.git',
]
```

再保留/更新无 upstream 用例，断言不出现 `(origin/`，但两个 option 仍各自包含 URL。

**Step 3: 增加凭据脱敏预期**

以 `{ name: 'private', url: 'https://alice:secret@example.com/org/repo.git' }` 渲染弹窗，断言 option 文本为：

```ts
'private  https://example.com/org/repo.git'
```

并断言 document 文本中不包含 `alice` 或 `secret`。该用例不得使用 mock 来替代真实的 option 渲染。

**Step 4: 运行测试，确认失败原因正确**

```bash
pnpm vitest run tests/unit/renderer/file-status.test.tsx
```

预期：新增的 URL 文案断言失败，因为生产代码仍只格式化 remote 名称和 upstream 标记；失败不应来自测试环境、i18n mock 或 TypeScript 错误。

**Step 5: 提交测试（可选检查点）**

```bash
git add tests/unit/renderer/file-status.test.tsx
git commit -m "test(ui): cover commit remote URL labels"
```

仅在团队希望保留红灯测试提交时执行；否则与 Task 2 的生产代码同一提交。

### Task 2: 最小化格式化 option 标签并通过测试

**Files:**

- Modify: `src/renderer/components/FileStatus.tsx:CommitModal`（当前远端 `<select>` 的 `gitStatus.remotes.map()`）
- Test: `tests/unit/renderer/file-status.test.tsx`

**Step 1: 实现安全的显示地址处理**

在组件附近新增仅供显示使用的纯逻辑。其行为必须等价于：

```ts
function displayRemoteUrl(url: string): string {
  return url.replace(/^(https?:\\/\\/)\\S*@/i, '$1')
}
```

实现可以等价调整以提高可读性，但必须满足以下例子：

```ts
displayRemoteUrl('https://alice:secret@example.com/org/repo.git')
// 'https://example.com/org/repo.git'

displayRemoteUrl('git@github.com:org/repo.git')
// 'git@github.com:org/repo.git'
```

不要把该逻辑用于任何写操作、Git 命令、select value 或 localStorage。

**Step 2: 按固定顺序组装 option 标签**

保留现有 upstream 判断，并将 `label` 改为以下语义：

```ts
const remoteLabel = upstream && upstream.remote === r.name
  ? `${r.name} (${upstream.remote}/${upstream.branch})`
  : r.name
const label = `${remoteLabel}  ${displayRemoteUrl(r.url)}`
```

`<option key={r.name} value={r.name}>` 的 value、onChange、selectedRemote state、localStorage effect 和现有 className 均不改动。因为 `GitRemote.url` 是既有必填字段，本任务不增加空 URL 占位文案或 fallback remote。

**Step 3: 运行聚焦测试，确认通过**

```bash
pnpm vitest run tests/unit/renderer/file-status.test.tsx
```

预期：远端显示用例和同文件其他 `CommitModal` 用例全部通过。

**Step 4: 提交实现**

```bash
git add src/renderer/components/FileStatus.tsx tests/unit/renderer/file-status.test.tsx
git commit -m "feat(ui): show Git URLs in commit remote selector"
```

### Task 3: 整体验证与人工验收

**Files:**

- Verify: `src/renderer/components/FileStatus.tsx`
- Verify: `tests/unit/renderer/file-status.test.tsx`

**Step 1: 运行聚焦单元测试**

```bash
pnpm vitest run tests/unit/renderer/file-status.test.tsx
```

预期：退出码 0。

**Step 2: 运行类型检查**

```bash
pnpm typecheck
```

预期：退出码 0，且没有因 option 格式化而新增类型错误。

**Step 3: 人工验收**

在以下本地仓库状态中打开“提交并推送”弹窗并检查内容区远端行：

1. 单 remote、无 upstream：`远端 [ origin  git@github.com:team/app.git ▾ ]`。
2. `main -> origin/main`：`远端 [ origin (origin/main)  git@github.com:team/app.git ▾ ]`。
3. `origin`、`backup` 两个 remote：仅 `origin` 显示 `(origin/main)`；两项均显示各自地址，切换到 `backup` 后仍只把 `backup` 写入 `buddy.lastRemote.<repoRoot>`。
4. HTTP(S) remote 以含 userinfo 的测试仓库配置：界面显示去掉 userinfo 的地址，不出现用户名、密码或令牌。
5. 无 remote：仍无远端下拉框，左下角“提交后推送”继续禁用。

使用 `git config --get branch.<branch>.remote`、`git config --get branch.<branch>.merge` 与打开弹窗、切换 remote 前后的值比对，确认该 UI 变更没有写入或改写 upstream。

## 验收标准

- 下拉项同时显示 remote 名称、仅匹配项的 `(remote/branch)` 和 Git 地址；格式顺序与示例一致。
- 地址来自现有 push URL，option value 和项目级选择记忆仍只使用 remote 名称。
- HTTPS/HTTP 地址中的 userinfo 不显示；SSH/scp 风格 `git@host:path` 原样显示。
- 地址较长时保持现有单行 select 布局，不增加第二行或额外控件。
- 无 remote、提交后推送、首次推送、upstream、Git 配置和任务状态机的既有行为没有变化。
- `tests/unit/renderer/file-status.test.tsx` 与 `pnpm typecheck` 通过。

## 回滚

回滚本计划产生的单个 UI/测试提交即可恢复为只显示 remote 名称和 upstream 标记。该变更不写 Git 配置、不新增 localStorage 键、不迁移数据，也不产生需要清理的用户状态。

## 不包含

- 不修改 `src/main/buddy/git.ts`、共享类型、IPC、preload、`getGitRemotes()` 或 Git 命令。
- 不显示 fetch URL、多个 push URL、远端状态、仓库描述、分支列表或凭据详情。
- 不新增 URL 复制、打开浏览器、编辑 remote、编辑 URL、添加/删除 remote、SSH/代理/网络诊断功能。
- 不修改 remote 选择优先级、`buddy.lastRemote.<repoRoot>` 的键值语义、提交后推送默认值、首次推送 refspec 或 push 错误处理。
- 不改动文件选择、暂存、提交信息生成、快捷键、任务状态机、任务队列、Git 配置、版本发布或安装包。
