# 推送待推送提交列表 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在“推送待推送的提交”对话框中，针对本地领先状态，在目标远端分支标签下显示全部尚未推送的本地提交短 SHA 与标题。

**Architecture:** 扩展已有 `GitPushAvailability`，让主进程在完成同一次 `git fetch` 和 ahead/behind 比较后，使用同一个 `<remote-ref>..HEAD` 范围取得本地独有提交。IPC、preload 和 React Query 继续传递同一共享类型；`PushModal` 仅在 `ahead` 状态渲染该列表，不改变任何 Git 写入或推送决策。

**Tech Stack:** TypeScript、Electron IPC、React 18、TanStack React Query、Vitest、Testing Library、系统 Git CLI。

---

## 背景与已确认交互

目前 `PushModal` 在 `ahead` 状态仅显示“本地领先 N 个提交”和 `origin/main` 等目标引用。数字能说明存在待推送内容，却不能说明具体会推送什么；用户需要在点击“推送”前直接核对提交。

例如 MarkdownReader 的本地 `main` 相对 `origin/main` 领先两个提交时，状态区应显示：

~~~text
✓ 本地领先 2 个提交
  origin/main
  e4e8330 fix: prevent editor bottom scroll jitter
  972b677 Merge branch 'codex/editor-bottom-scroll-fix'
~~~

列表按从旧到新顺序显示，和用户审阅“将被依次推送的提交”一致。每项由 7 位短 SHA 和完整提交标题组成；标题可换行，不以省略号静默截断。列表属于现有可滚动的 modal 正文，提交很多时仍可浏览全部条目。

## 范围与边界

### 包含

1. 在 `GitPushAvailability` 中增加只读 `pendingCommits` 数组，每项为 `{ hash, subject }`。
2. 当目标远端分支存在且 `ahead > 0` 时，主进程以计数相同的范围取得提交：

   ~~~bash
   git log --reverse --format=%h%x00%s%x00 <remote-ref>..HEAD
   ~~~

   使用 NUL 分隔解析，避免提交标题内的空格、制表符或 `|` 破坏字段拆分。
3. 在 `PushModal` 的 `ahead` 状态中，把列表显示在已有 `<remote>/<branch>` 标签之后。
4. 补充主进程和 Renderer 单元测试，覆盖提交范围、顺序与各状态的显示边界。

### 不包含

- 不改变 `git fetch` 时机、比较分支规则、ahead/behind 计算或 `git push` 参数。
- 不新增提交详情页、展开/折叠、复制、检出、回滚、筛选或限制条数。
- 不在 `new_branch`、`up_to_date`、`behind`、`diverged`、`unavailable` 或检查失败时伪造或显示提交列表。
- 不修改 `buddy.lastRemote.*`、Git remote/upstream、`push.default`、工作区、暂存区或提交历史。
- 不改变“提交并推送”路径、状态栏入口条件、远端下拉框和 i18n 既有文案。

## 数据契约

在 `src/shared/types.ts` 的 `GitPushAvailability` 附近增加：

~~~ts
export interface GitPendingCommit {
  hash: string
  subject: string
}

export interface GitPushAvailability {
  state: GitPushAvailabilityState
  remote: string
  branch: string
  ahead: number
  behind: number
  pendingCommits: GitPendingCommit[]
  upstreamCreatedOnPush: boolean
}
~~~

`pendingCommits` 必须始终存在，不能以 `undefined` 代表空列表：

- 分离 HEAD、无有效 HEAD、远端分支不存在、同步、仅落后或分叉：`[]`。
- `ahead`：恰好为 `<remote-ref>..HEAD` 中所有可达、但不在目标远端分支上的提交；`length === ahead`。
- Git log 失败：让 `getGitPushAvailability()` 抛错，沿用当前“检查远端状态失败”UI；不能返回正确计数配空/不完整列表并让用户误以为核对完成。

当前 `getGitPushAvailability()` 已先 fetch 选中的 remote，再以 `refs/remotes/<remote>/<target-branch>` 比较。提交列表必须在此 fetch 完成后生成，且必须复用相同 `remoteRef` 和 `HEAD`，避免计数与显示提交来自不同远端快照。`--reverse` 确保最旧的待推送提交先出现；不要使用 `--first-parent`，否则 merge 的普通可达提交可能与 `rev-list` 计数不一致。

## 实施步骤

### Task 1: 为待推送提交列表建立共享类型和主进程测试

**Files:**

- Modify: `src/shared/types.ts: GitPushAvailability`
- Modify: `src/main/buddy/git.ts: getGitPushAvailability()`
- Modify: `tests/unit/main/buddy-git.test.ts: describe('getGitPushAvailability')`

**Step 1: 写失败测试**

在已有“reports ahead when local is 1 commit ahead”夹具基础上，先连续创建两个本地提交，例如 `first local`、`second local`。调用 `getGitPushAvailability(dir, 'origin')` 后断言：

~~~ts
expect(avail.state).toBe('ahead')
expect(avail.ahead).toBe(2)
expect(avail.pendingCommits).toEqual([
  { hash: expect.stringMatching(/^[0-9a-f]{7}$/), subject: 'first local' },
  { hash: expect.stringMatching(/^[0-9a-f]{7}$/), subject: 'second local' }
])
~~~

增加以下边界断言：

1. `up_to_date`、`behind`、`diverged` 和分离 HEAD 的 `pendingCommits` 都是 `[]`。
2. `new_branch` 仍为 `[]`；没有远端 ref 时不得以 `HEAD` 全历史冒充“待推送提交”。
3. 选择 `backup` 时，提交列表相对 `backup/main` 计算，同时保留 `origin/main` upstream 不变。
4. 使用带空格、制表符和竖线的提交标题，证明结构化解析不被分隔符破坏。

**Step 2: 运行测试，确认当前实现失败**

~~~bash
pnpm vitest run tests/unit/main/buddy-git.test.ts
~~~

预期：新字段/断言尚未满足，测试失败或 TypeScript 编译失败。

**Step 3: 最小实现**

1. 在 `src/shared/types.ts` 导出 `GitPendingCommit`，并把 `pendingCommits: GitPendingCommit[]` 设为 `GitPushAvailability` 的必填字段。
2. 更新 `getGitPushAvailability()` 所有早返回：`unavailable` 与 `new_branch` 均传入 `pendingCommits: []`。
3. 保持已有 `git rev-list --left-right --count ${remoteRef}...HEAD` 用于状态与数量；仅在算出的 `ahead > 0` 时执行：

   ~~~ts
   const output = await execGit(
     ['log', '--reverse', '--format=%h%x00%s%x00', `${remoteRef}..HEAD`],
     cwd
   )
   ~~~

4. 以 NUL 成对解析 `hash`、`subject`，丢弃唯一的末尾空项；每个非空 hash 必须有对应 subject。输出格式不完整时抛出含 `git log` 上下文的错误，不返回部分列表。
5. 当 `ahead === 0` 时不执行 `git log`，返回 `pendingCommits: []`；当 `ahead > 0` 时断言解析条数与 `ahead` 相同，不同则抛错，避免 UI 显示被截断的“完整列表”。
6. 从 `git.ts` 导出新类型，与该文件目前其他共享 Git 类型的 re-export 保持一致。

**Step 4: 运行测试，确认通过**

~~~bash
pnpm vitest run tests/unit/main/buddy-git.test.ts
~~~

预期：全部通过；覆盖本地领先、分叉、首次分支、备用远端与 fetch 失败的现有行为仍不变。

**Step 5: 提交**

~~~bash
git add src/shared/types.ts src/main/buddy/git.ts tests/unit/main/buddy-git.test.ts
git commit -m "feat(git): include pending commit summaries"
~~~

### Task 2: 在 PushModal 渲染待推送提交列表

**Files:**

- Modify: `src/renderer/components/PushModal.tsx: ahead 状态块`
- Modify: `tests/unit/renderer/push-modal.test.tsx: makeAvail 与 ahead 渲染测试`

**Step 1: 写失败测试**

更新测试夹具，使 `makeAvail()` 默认包含 `pendingCommits: []`。新增 `ahead` 场景，输入：

~~~ts
pendingCommits: [
  { hash: 'e4e8330', subject: 'fix: prevent editor bottom scroll jitter' },
  { hash: '972b677', subject: 'Merge branch \'codex/editor-bottom-scroll-fix\'' }
]
~~~

断言：

1. “本地领先 2 个提交”继续显示且推送按钮可用。
2. `origin/main` 标签之后按顺序出现两项的短 SHA 与标题；用 `within()` 或 DOM 顺序断言，而不是只检查页面上存在两段文字。
3. 长标题不使用 `truncate`/`text-ellipsis`，可换行显示。
4. `new_branch`、`up_to_date`、`behind`、`diverged`、`unavailable` 和 fetch error 均不显示列表容器或测试提交文字。
5. remote 切换后的新 availability 没有列表时，旧 remote 的提交文本不残留。

**Step 2: 运行测试，确认当前实现失败**

~~~bash
pnpm vitest run tests/unit/renderer/push-modal.test.tsx
~~~

预期：待推送提交项尚未渲染，新增断言失败。

**Step 3: 最小实现**

1. 保持现有 `ahead` 的绿色图标、数量文案和 `origin/main` 标签位置不变。
2. 在该目标引用标签之后，仅当 `avail.state === 'ahead' && avail.pendingCommits.length > 0` 时渲染语义化 `<ul>`；每个项目以 `<li>` 显示：

   ~~~tsx
   <code className="font-mono text-fg-muted">{commit.hash}</code>
   <span className="min-w-0 break-words">{commit.subject}</span>
   ~~~

3. 为列表使用与目标引用一致的左缩进和紧凑字号；不添加新的图标库或自绘 SVG。不要加入 `truncate`、tooltip 或客户端排序。
4. 直接使用该查询结果的 `pendingCommits`，不在 Renderer 执行 Git 命令、推算提交或增加第二个查询。
5. 仅扩展数据展示；`canPush`、`handlePush()` 的 force-refresh、远端选择记忆、成功/失败回调和 modal 高度滚动行为必须保持不变。

**Step 4: 运行测试，确认通过**

~~~bash
pnpm vitest run tests/unit/renderer/push-modal.test.tsx tests/unit/renderer/file-status.test.tsx
~~~

预期：提交列表随 `ahead` 数据更新；既有独立推送入口及文件状态测试仍全部通过。

**Step 5: 提交**

~~~bash
git add src/renderer/components/PushModal.tsx tests/unit/renderer/push-modal.test.tsx
git commit -m "feat(ui): show pending commits before push"
~~~

### Task 3: 完整验证与人工验收

**Files:**

- Verify: `src/shared/types.ts`
- Verify: `src/main/buddy/git.ts`
- Verify: `src/renderer/components/PushModal.tsx`
- Verify: `tests/unit/main/buddy-git.test.ts`
- Verify: `tests/unit/renderer/push-modal.test.tsx`

**Step 1: 运行定向测试与类型检查**

~~~bash
pnpm vitest run tests/unit/main/buddy-git.test.ts tests/unit/renderer/push-modal.test.tsx tests/unit/renderer/file-status.test.tsx
pnpm typecheck
pnpm test
git diff --check
~~~

预期：命令退出码均为 0；不应有 TypeScript 类型遗漏、测试夹具缺少 `pendingCommits` 或空白错误。

**Step 2: 人工 GUI 验收**

在临时 Git 仓库中创建 bare `origin`、推送基线 `main`，然后在本地依次创建两个未推送提交。打开 Buddy 的“推送待推送的提交”对话框，逐项确认：

1. 状态仍为“本地领先 2 个提交”。
2. `origin/main` 下方按最旧到最新显示两个短 SHA 与完整标题，内容、顺序与 `git log --reverse --oneline origin/main..HEAD` 一致。
3. 标题超过一行时可换行，modal 正文可滚动，底部取消/推送按钮仍可见且可操作。
4. 切换到同步的另一 remote 后列表立即消失，推送按钮按原规则禁用；切回 `origin` 后再次显示其列表。
5. 点击取消不改变任何 Git 状态；实际推送后重新打开对话框不再显示待推送条目。

**Step 3: 提交验证后代码（如前两任务未分别提交）**

~~~bash
git status --short
git log --oneline -2
~~~

预期：工作区仅包含本任务的预期提交；不要把测试、构建缓存或无关用户改动带入提交。

## 回滚

若上线后发现 Git 输出解析或 UI 展示异常，回滚本任务引入的两个功能提交即可。该回滚只移除 `pendingCommits` 数据与 modal 列表，既有 `GitPushAvailability` 的 fetch、ahead/behind 判断和推送语义不受影响；无需对用户仓库执行 reset、rebase 或强制推送。
