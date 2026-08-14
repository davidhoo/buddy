# 已提交待推送入口 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Buddy 中识别“工作区已全部提交、当前分支仍有可安全推送的本地提交”的项目，提供一个不含提交信息的独立推送入口；进入该入口和实际推送前均刷新所选远端状态。

**Architecture:** 保持现有 10 秒本地 Git 状态轮询纯本地、无网络副作用。新增单独的 push-status IPC：仅在状态栏已打开且工作区干净时，对一个确定的检测远端执行 git fetch，比较本地 HEAD 与该远端的目标分支；Renderer 仅在结果为“本地领先”或“远端尚无该分支”时渲染推送入口。独立 PushModal 复用现有 remote 选择记忆和首次推送 refspec，但不复用 CommitModal 的文件、暂存或提交信息状态。

**Tech Stack:** TypeScript、Electron、React 18、TanStack React Query、Vitest、Testing Library、系统 Git CLI。

---

## 任务说明

### 背景

当前 Buddy 的 Git 状态只读取工作区/暂存区文件、分支、remote 和 upstream；不计算 ahead/behind。提交对话框始终先执行 git commit，之后才可选择 push。因此某次“仅提交”或“提交成功但推送失败”后，项目会显示为“无变更”，提交入口被禁用，用户无法在 Buddy 中补推已存在的本地提交。

本任务增加的是一个独立的“推送已有提交”路径。它必须与“提交并推送”并存：前者只推送当前 HEAD，后者保持先暂存、提交、再可选推送的原有流程。

### 已确认交互

1. 只有当前项目满足以下全部条件时，文件状态区域才显示独立“推送”入口：
   - 当前分支存在有效 HEAD，且不是分离 HEAD；
   - 工作区完全干净：没有 unstaged、staged 或 untracked 文件；
   - 项目至少有一个可用 push remote；
   - 对检测远端完成本次 fetch 后，当前 HEAD 相对目标远端分支为“领先至少 1 个提交”，或远端尚无该目标分支。
2. 有未提交文件时，继续只显示既有“提交”入口；不得显示独立推送入口。推送已有提交不会把工作区文件、暂存内容或提交信息一并带出。
3. Git 状态轮询仍每 10 秒执行纯本地查询；**不得**把 git fetch 加进 getGitStatus()、refetchInterval 或文件编辑后的每次刷新。
4. 触发远端检查的时机固定为：
   - 状态栏已经打开，项目/分支首次取得“工作区干净”的本地状态；
   - “仅提交”成功、或“提交成功但 push 失败”后 Git 状态刷新为干净；
   - 检测远端发生变化；
   - 用户打开 PushModal、在其内切换 remote、或点击实际“推送”前。
   同一个 remote/branch 的已在途或已缓存请求由 React Query 复用；实际点击推送前必须强制重新检查一次。
5. 检测远端按以下优先级确定：当前 upstream 的 remote（仍存在于 remotes 中）→ 项目级 buddy.lastRemote.<repoRoot>（仍有效）→ remotes[0]。本任务不在后台扫描所有 remote；多远端项目先以这个确定目标决定入口是否显示。
6. PushModal 中保留远端下拉框。初始值为触发入口的检测远端；用户切换后立即 fetch 新 remote 并重算状态。该选择继续写入已有项目级 localStorage 键，但不得写入 Git remote/upstream/push.default 配置。
7. PushModal 不显示文件列表、暂存控制、AI 生成、提交信息输入或“提交后推送”复选框，只显示：
   - 远端选择；
   - 检查中的 loading、fetch 错误及重试；
   - 目标分支和本地领先/远端领先提交数；
   - “远端尚无此分支，首次推送”说明；
   - 取消和“推送”按钮。
8. 仅以下远端状态可执行 push：
   - ahead：本地领先 N 个，远端未领先；
   - new_branch：远端尚无目标分支。
   同步、仅落后、分叉、无有效 HEAD、fetch 失败时不显示入口或在已打开的弹窗中禁用推送并显示原因。
9. behind 或 diverged 不执行 pull、merge、rebase、force push 或自动重试。用户应先在 Git 工具/终端中处理远端提交；Buddy 不隐藏原始 Git 错误。
10. 成功时显示“已推送到 <remote>”；失败时显示“推送到 <remote> 失败：<Git stderr>”。失败不回滚本地提交，也不改变工作区；重新检查后若仍符合条件，入口可再次出现。

### Git 语义与数据契约

新增共享类型，避免把 Git 命令输出和分支推断散落在 Renderer：

~~~
export type GitPushAvailabilityState =
  | 'ahead'
  | 'up_to_date'
  | 'behind'
  | 'diverged'
  | 'new_branch'
  | 'unavailable'

export interface GitPushAvailability {
  state: GitPushAvailabilityState
  remote: string
  branch: string
  ahead: number
  behind: number
  upstreamCreatedOnPush: boolean
}

export interface GitPushResult {
  pushStatus: 'pushed' | 'failed'
  remote: string
  upstreamCreated: boolean
  pushError: string | null
}
~~~

- 目标 branch：所选 remote 等于当前 upstream.remote 时用 upstream.branch；否则用当前本地 branch。该规则必须与现有 gitCommitAndPush() 的 push 目标一致。
- push-status 先执行 git fetch <remote>，再验证 refs/remotes/<remote>/<target-branch>。存在该 ref 时执行：

  ~~~
  git rev-list --left-right --count <remote-ref>...HEAD
  ~~~

  左值为 behind，右值为 ahead。
- 远端 ref 不存在且 HEAD 有提交时为 new_branch；不把该情况误报为“已同步”。
- 当前分支没有 upstream 时，实际首次推送仍执行：

  ~~~
  git push --set-upstream <remote> HEAD:refs/heads/<current-branch>
  ~~~

  并且只在该 push 成功后建立 upstream。
- 当前分支已有 upstream 但用户选择另一个 remote 时，继续显式推送到同名本地 branch，绝不改写原 upstream。
- 抽取 gitCommitAndPush() 与新 gitPush() 共同使用的 push 参数解析函数，确保两条路径没有分叉的首次推送或 alternate-remote 语义。

### 文件与责任

| 文件 | 改动 |
| --- | --- |
| src/shared/types.ts | 新增 GitPushAvailability、GitPushAvailabilityState、GitPushResult。 |
| src/main/buddy/git.ts | 实现 fetch 后的分支比较、独立 gitPush()，并提取共同 push 参数逻辑。 |
| src/main/buddy/service.ts | 暴露 push-status 与 gitPush() 服务方法。 |
| src/main/ipc/buddy-handlers.ts | 增加两个 buddy:* IPC handler 和接口方法。 |
| src/preload/buddy-api.ts | 将两个 IPC 安全暴露给 Renderer。 |
| src/renderer/lib/api.ts | 为 Renderer API 添加类型化包装。 |
| src/renderer/hooks/useBuddy.ts | 新增按条件启用、无轮询的 useGitPushAvailability 与 useGitPush。提交 mutation 成功后同时失效 push-status 查询。 |
| src/renderer/components/FileStatus.tsx | 只在干净且 availability 为 ahead/new_branch 时显示推送入口；不改变既有提交入口。 |
| src/renderer/components/PushModal.tsx | 新建无提交信息的独立推送对话框。 |
| src/renderer/components/StatusBar.tsx | 管理 PushModal、推送反馈与入口回调。 |
| src/renderer/lib/i18n.ts | 添加中英繁三语的推送状态、错误、按钮文案。 |
| tests/unit/main/buddy-git.test.ts | 覆盖远端状态计算、首次推送、已有 upstream、alternate remote 与失败结果。 |
| tests/unit/preload/buddy-api.test.ts | 覆盖新 IPC 参数顺序。 |
| tests/unit/renderer/file-status.test.tsx | 覆盖入口显示门槛与提交 UI 未回归。 |
| tests/unit/renderer/push-modal.test.tsx | 新建，覆盖 fetch 状态、remote 切换、成功与失败反馈。 |

## 实施步骤

### Task 1: 为待推送判断与独立推送建立主进程契约

**Files:**

- Modify: src/shared/types.ts:GitCommitPushResult 附近
- Modify: src/main/buddy/git.ts:getGitUpstream / gitCommitAndPush
- Test: tests/unit/main/buddy-git.test.ts

**Step 1: 写失败测试**

为临时 bare remote 建立以下测试夹具：

1. main 跟踪 origin/main，本地新增一个 commit 后，getGitPushAvailability(dir, 'origin') 返回 state='ahead'、ahead=1、behind=0。
2. 将另一个 clone 推进 origin/main 后，本地 fetch，再断言 behind；双方各有提交时断言 diverged。
3. 新建无 upstream 的 feature 分支且远端没有 feature 时，断言 new_branch。
4. 当前 branch 已跟踪 origin/main、选择 backup 时，状态比较 backup/main；不依赖或改写 origin 的 upstream。
5. gitPush(dir, 'origin') 在 ahead 时推送已有 HEAD，不创建第二个 commit；无 upstream 的 new_branch 成功后创建 upstream；推送失败返回 failed 和原始错误而非抛弃本地状态。

**Step 2: 运行失败测试**

~~~bash
pnpm vitest run tests/unit/main/buddy-git.test.ts
~~~

预期：新增函数与类型尚不存在，测试无法编译或断言失败。

**Step 3: 最小实现**

1. 在 shared types 定义 GitPushAvailabilityState、GitPushAvailability、GitPushResult。
2. 在 git.ts 增加只由显式 push-status 调用的 fetch；不得从 getGitStatus() 调用。
3. 以 getGitBranch()、getGitUpstream() 和所选 remote 确定 target branch；HEAD 为空或分离 HEAD 返回 unavailable。
4. fetch 成功后用 refs/remotes/<remote>/<branch> 和 rev-list 计算 ahead/behind，映射为 ahead、up_to_date、behind、diverged 或 new_branch。
5. 抽出 resolvePushArgs(cwd, remote)，由 gitCommitAndPush() 和新增 gitPush() 同时调用；保留目前的 explicit refspec 与首次成功后建立 upstream 语义。
6. gitPush() 不得调用 git commit、git add、git reset 或修改工作区；push 失败以 GitPushResult 返回 stderr。

**Step 4: 运行通过测试**

~~~bash
pnpm vitest run tests/unit/main/buddy-git.test.ts
~~~

预期：新增远端状态和独立推送用例通过，既有提交后推送用例不变。

**Step 5: 提交**

~~~bash
git add src/shared/types.ts src/main/buddy/git.ts tests/unit/main/buddy-git.test.ts
git commit -m "feat(git): detect and push pending commits"
~~~

### Task 2: 打通独立 push-status / push IPC

**Files:**

- Modify: src/main/buddy/service.ts:gitStatus / gitCommitAndPush
- Modify: src/main/ipc/buddy-handlers.ts:BuddyHandlerService / registerBuddyHandlers
- Modify: src/preload/buddy-api.ts:createBuddyPreloadApi
- Modify: src/renderer/lib/api.ts:api
- Modify: src/renderer/hooks/useBuddy.ts:useGitStatus / useGitCommitAndPush
- Test: tests/unit/preload/buddy-api.test.ts

**Step 1: 写失败测试**

在 preload 测试中断言：

~~~
api.gitPushAvailability('/tmp/repo', 'origin')
// invokes buddy:gitPushAvailability, '/tmp/repo', 'origin'

api.gitPush('/tmp/repo', 'origin')
// invokes buddy:gitPush, '/tmp/repo', 'origin'
~~~

在 hook 层增加或更新测试（若当前无单独 hook 测试则由 PushModal 测试覆盖）以证明：

- useGitPushAvailability 只在 enabled=true、repoRoot 和 remote 都有效时请求；
- 没有 refetchInterval；
- useGitCommitAndPush 与 useGitPush 成功后都会 invalidate ['gitStatus'] 和 ['gitPushAvailability']。

**Step 2: 运行失败测试**

~~~bash
pnpm vitest run tests/unit/preload/buddy-api.test.ts tests/unit/renderer/push-modal.test.tsx
~~~

预期：新 API 未暴露，或 push-status mock/调用断言失败。

**Step 3: 最小实现**

1. service、BuddyHandlerService、IPC handler、preload 和 renderer api 使用一致的 buddy:gitPushAvailability 与 buddy:gitPush 名称和参数顺序。
2. useGitPushAvailability 的 query key 固定为 ['gitPushAvailability', repoRoot, remote, branch]；调用端控制 enabled，禁止设置周期性 refetch。
3. useGitPush 使用 mutation；成功后失效 gitStatus 与 gitPushAvailability。
4. 现有 useGitStatus 的 10 秒 refetchInterval 保持原样，且不得因此触发 fetch。

**Step 4: 运行通过测试**

~~~bash
pnpm vitest run tests/unit/preload/buddy-api.test.ts tests/unit/main/buddy-git.test.ts
~~~

预期：IPC 调用参数和主进程语义均通过。

**Step 5: 提交**

~~~bash
git add src/main/buddy/service.ts src/main/ipc/buddy-handlers.ts src/preload/buddy-api.ts src/renderer/lib/api.ts src/renderer/hooks/useBuddy.ts tests/unit/preload/buddy-api.test.ts
git commit -m "feat(ipc): expose pending commit push operations"
~~~

### Task 3: 只在“干净且待推送”时显示入口

**Files:**

- Modify: src/renderer/components/FileStatus.tsx:FileStatus
- Modify: src/renderer/components/StatusBar.tsx:Git 状态与弹窗 state
- Test: tests/unit/renderer/file-status.test.tsx

**Step 1: 写失败测试**

补齐 FileStatus 渲染夹具，并 mock useGitPushAvailability。覆盖：

1. 工作区有任意文件变化时，即使 availability='ahead' 也没有推送入口，既有提交按钮仍可用。
2. 工作区干净且 availability='ahead' 时显示推送入口，文本含领先提交数；点击回调携带检测 remote。
3. 工作区干净且 availability='new_branch' 时显示首次推送入口。
4. up_to_date、behind、diverged、unavailable、loading 或 fetch error 时没有可点击的推送入口；fetch error 显示“检查远端状态失败”与重试动作，但不伪装为可推送。
5. 无 remote、无 branch、分离 HEAD 时不调用/不启用 push-status query。
6. 既有“无变更时提交按钮禁用”和“有变更时提交弹窗”的测试保持通过。

**Step 2: 运行失败测试**

~~~bash
pnpm vitest run tests/unit/renderer/file-status.test.tsx
~~~

预期：PushModal/availability props 与入口尚不存在，新增断言失败。

**Step 3: 最小实现**

1. 复用 FileStatus 已有 hasChanges 计算；只有 !hasChanges、branch 非空、remotes 非空时启用检测 query。
2. 在 FileStatus 内部选择检测 remote：有效 upstream → 有效 localStorage 值 → 首个 remote。不要读取、写入或排序 Git 配置。
3. 添加独立推送行，不替换、重命名或放宽现有提交行的 disabled 条件。
4. 在 StatusBar 添加 showPushModal、pushRemote、gitFeedback state；FileStatus 的入口只负责设置 remote 并打开弹窗。
5. 关闭弹窗后保持当前项目反馈的既有 6 秒自动消失机制；可将 CommitFeedback 通用化为 GitFeedback，但不得改变提交成功/失败文案和范围。

**Step 4: 运行通过测试**

~~~bash
pnpm vitest run tests/unit/renderer/file-status.test.tsx
~~~

预期：入口门槛、无变更提交禁用和既有提交行为同时通过。

**Step 5: 提交**

~~~bash
git add src/renderer/components/FileStatus.tsx src/renderer/components/StatusBar.tsx tests/unit/renderer/file-status.test.tsx
git commit -m "feat(ui): show pending commit push entry"
~~~

### Task 4: 实现无提交信息的 PushModal 与三语反馈

**Files:**

- Create: src/renderer/components/PushModal.tsx
- Modify: src/renderer/components/StatusBar.tsx:PushModal 渲染与反馈
- Modify: src/renderer/lib/i18n.ts:git.* 三语字典
- Create: tests/unit/renderer/push-modal.test.tsx

**Step 1: 写失败测试**

新建 PushModal 测试，覆盖：

1. 模态框没有 textbox、文件表格、暂存按钮、生成按钮和“提交后推送”复选框。
2. 初始 remote 显示 availability 的 remote；选择另一个 remote 后先显示 loading，再显示新 remote 的状态。
3. ahead 显示“本地领先 N 个提交”并启用“推送”；new_branch 显示首次推送说明并启用“推送”。
4. up_to_date、behind、diverged、unavailable、fetch error 时推送按钮禁用，错误可点击重试。
5. 点击推送前先等待该 remote 的强制状态刷新；只有刷新后仍为 ahead/new_branch 才调用 api.gitPush(repoRoot, remote)。
6. pushed 显示 success 并关闭；failed 显示 remote 与原始 pushError，关闭后不把它报成提交失败。

**Step 2: 运行失败测试**

~~~bash
pnpm vitest run tests/unit/renderer/push-modal.test.tsx
~~~

预期：组件和 i18n key 尚不存在。

**Step 3: 最小实现**

1. 使用与 CommitModal 相同的遮罩、Esc、关闭按钮、Cancel 按钮和 lucide-react 图标风格。
2. 用 modal 内部 selectedRemote 初始化为入口提供的 remote；选项沿用 GitStatusResult.remotes，当前 upstream remote 继续标记为 origin (origin/main)。
3. 远端切换和“重试”执行该 remote 的 fetch/status 查询；“推送”按钮先 force refetch，再根据最新 state 决定是否调用 mutation。
4. 添加 git.pushPending、git.pushAhead、git.pushNewBranch、git.pushUpToDate、git.pushBehind、git.pushDiverged、git.pushCheckFailed、git.pushNow、git.pushSuccess、git.pushFailed 等 i18n key，并一次性补齐 en、zh-CN、zh-TW。
5. 不把 fetch 失败降级为 up_to_date；不提供 force、pull、merge、rebase 或自动 retry。

**Step 4: 运行通过测试**

~~~bash
pnpm vitest run tests/unit/renderer/push-modal.test.tsx tests/unit/renderer/file-status.test.tsx
~~~

预期：新模态框流程与既有提交 UI 测试通过。

**Step 5: 提交**

~~~bash
git add src/renderer/components/PushModal.tsx src/renderer/components/StatusBar.tsx src/renderer/lib/i18n.ts tests/unit/renderer/push-modal.test.tsx
git commit -m "feat(ui): add pending commit push modal"
~~~

### Task 5: 整体验证与人工验收

**Files:**

- Verify: src/main/buddy/git.ts
- Verify: src/renderer/components/FileStatus.tsx
- Verify: src/renderer/components/PushModal.tsx
- Verify: tests/unit/main/buddy-git.test.ts
- Verify: tests/unit/preload/buddy-api.test.ts
- Verify: tests/unit/renderer/file-status.test.tsx
- Verify: tests/unit/renderer/push-modal.test.tsx

**Step 1: 运行聚焦测试**

~~~bash
pnpm vitest run tests/unit/main/buddy-git.test.ts tests/unit/preload/buddy-api.test.ts tests/unit/renderer/file-status.test.tsx tests/unit/renderer/push-modal.test.tsx
~~~

预期：所有聚焦测试通过。

**Step 2: 运行完整质量门**

~~~bash
pnpm test
pnpm typecheck
~~~

预期：两条命令退出码均为 0。

**Step 3: 人工验收**

使用本地 bare remote 和两个 clone 验证：

1. 打开有未提交文件的项目：不会发起 fetch；仅有原“提交”入口。
2. 仅提交后工作区变干净：自动 fetch 检测远端，出现“推送”入口；打开后没有提交信息或文件选择，推送成功后入口消失。
3. 本地 commit 后使远端 advance：界面显示落后/分叉状态，不提供推送、不做 pull/force。
4. 无 upstream 的 feature 分支：远端无 feature 时显示首次推送；成功后 upstream 为所选 remote/feature。
5. main 跟踪 origin/main、选择 backup 推送：backup/main 收到 HEAD，origin/main upstream 保持不变。
6. 断开网络或令 fetch 认证失败：显示检查错误与重试，绝不把未知状态当作可推送。
7. 执行一次独立 push：确认 git log -1 在操作前后未新增提交，git status 仍干净。

**Step 4: 提交**

~~~bash
git add src/shared/types.ts src/main/buddy/git.ts src/main/buddy/service.ts src/main/ipc/buddy-handlers.ts src/preload/buddy-api.ts src/renderer/lib/api.ts src/renderer/hooks/useBuddy.ts src/renderer/components/FileStatus.tsx src/renderer/components/PushModal.tsx src/renderer/components/StatusBar.tsx src/renderer/lib/i18n.ts tests/unit/main/buddy-git.test.ts tests/unit/preload/buddy-api.test.ts tests/unit/renderer/file-status.test.tsx tests/unit/renderer/push-modal.test.tsx
git commit -m "test: verify pending commit push flow"
~~~

仅在该阶段实际有新增验证性改动时执行；不得创建空提交。

## 验收标准

- 工作区有未提交变更时，Buddy 不显示独立推送入口，也不因 Git 状态轮询自动 fetch。
- 工作区干净、HEAD 领先检测远端或远端无目标分支时，Buddy 自动 fetch 后显示独立入口。
- PushModal 不含提交信息、文件/暂存选择或 AI 生成；只展示远端、差异、状态和推送操作。
- 打开项目/分支变更/提交后变干净/切换 remote/点击推送前的刷新时机会触发 fetch；普通 10 秒 Git 状态轮询不触发 fetch。
- ahead 与 new_branch 可推送；同步、落后、分叉、状态未知及 fetch 失败不可推送。
- 独立 push 不产生新 commit；首次成功推送才建立 upstream；推送 alternate remote 不改写既有 upstream。
- fetch/push 错误保留原始 Git 错误文本，且不被错误地呈现为“提交失败”。
- 聚焦测试、pnpm test 与 pnpm typecheck 均通过。

## 回滚

回滚本任务的功能提交即可删除独立入口和 IPC；不需还原用户文件或 Git commit。唯一可能的本地 Git 影响是用户实际点击并成功执行的首次推送所建立的 upstream，以及 git fetch 正常更新的 remote-tracking refs；它们都是 Git 的标准、可由用户自行调整的状态，不应由回滚脚本自动删除。

## 不包含

- 不修改现有提交、暂存、提交信息生成、快捷键、任务状态机、队列或任务运行期间的提交可用性。
- 不把 git fetch 加入现有 getGitStatus() 或其 10 秒轮询；不做后台定时 fetch。
- 不后台扫描所有 remote；入口检测只使用已定义优先级选出的一个 remote。
- 不新增 remote 的添加、删除、URL 编辑、凭据、SSH、代理、GitHub 登录或连通性管理。
- 不自动 pull、merge、rebase、stash、force push、解决冲突或绕过保护分支/服务端 hook。
- 不改变用户的 branch.*.remote、branch.*.merge、remote.pushDefault、push.default 或其他 Git 配置；仅用户实际成功的首次 push 保留 Git 现有的 set-upstream 语义。
- 不发布版本、打包、替换 /Applications/Buddy.app，或对任何项目执行真实远端推送。
