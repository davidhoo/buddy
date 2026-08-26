# 运行中任务真实停止 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 点击 Buddy 运行中任务的“停止”，必须实际终止对应 actor launcher 进程，并让任务稳定停在 `PAUSED`，不产生失败记录、自动重试或下一轮自动交接。

**Architecture:** `BuddyRunner` 为每一个实际执行中的 `{ workspaceKey, taskId, runId }` 维护一个仅内存的 `AbortController`。停止或“打断并插入”先持久化当前 run 的 `PAUSED` 意图并清空 `active_run`，再中止同一 `runId` 的 controller；现有 `runLauncher` / `runLauncherWithPty` 接收该 signal 并向子进程发送 `SIGTERM`。执行协程识别该 signal 为用户中断的正常结束，跳过失败、上下文重置、升级重试与自动交接。

**Tech Stack:** TypeScript、Electron 主进程、Node.js `AbortController` / `child_process`、node-pty、Vitest。

---

## 背景与已确认根因

Renderer 的方形停止按钮已通过 `buddy:interrupt` 调到 `BuddyRunner.interrupt()`；IPC、preload、service 不需要改动。当前 runner 的 `interrupt()` 仅把状态更新为 `PAUSED`、清空 `active_run` 并追加 `actor.interrupted`，没有保存或中止任何子进程。

`src/main/buddy/launchers.ts` 的 `runLauncher()` 与 `runLauncherWithPty()` 已经支持可选 `AbortSignal`：signal abort 后向自己启动的 launcher 发送 `SIGTERM`。根因是 `BuddyRunner.runActorCommand()` 没有 signal 参数，也从未把 signal 传给这两个函数。因此界面虽显示“已暂停”，旧 CLI 仍继续执行；其最终回调因 `active_run` 已被清空而不再回写完成状态，形成“假停止”。

停止后的 launcher 退出可能以 `exitCode === null`、`signal === 'SIGTERM'` 返回。该退出必须被识别为用户动作，不能落入当前 `executeActorInner()` 的错误处理、`markFailed()`、上下文重置或升级重试分支。

## 范围与边界

### 包含

1. 直接点击运行中任务的停止按钮时，终止该 run 的普通 pipe launcher。
2. “打断并插入队列指令”时，同样终止被替换的旧 run，再启动承接指令的新 run。
3. 将同一 signal 透传到普通 launcher 与 OpenCode 的 PTY launcher 分支。
4. 为直接停止和打断插入建立可重复、无真实 AI CLI 的回归测试。
5. 保留现有 `state.json` schema 与 `actor.interrupted` 事件类型；事件 payload 补充 `run_id` 仅作为诊断关联信息。

### 不包含

- 不调整 Composer 图标、文案、快捷键、IPC channel、preload API 或 React Query 刷新策略。
- 不改变倒计时暂停、普通失败、超时、上下文重置、自动升级重试、双 break、队列调度或轮次上限规则。
- 不新增持久化 PID、跨应用重启恢复后杀旧进程、后台守护进程，或任务目录/全局设置迁移。
- 不在本任务中改变 launcher 的信号策略、增加 `SIGKILL` 升级，或递归杀灭 CLI 自行派生的进程树；本修复保证 Buddy 直接启动的 launcher 收到既有 `SIGTERM`。若某特定 CLI 忽略 `SIGTERM`，另立兼容性任务，以真实 CLI 进程树证据决定是否采用 macOS process group 策略。

## 停止语义与并发约束

1. controller 仅在内存中存在，key 必须同时含 workspace、task 和 run ID；不得只按 `taskId`，避免不同 workspace 中同名任务误杀。
2. `startTask()` 在将状态成功写为 `RUNNING_*` 后、任何可 await 的启动步骤前登记 controller。这样用户停止不会落在“状态已运行但没有可取消句柄”的窗口。
3. 中断时先将匹配 run 的 `active_run` 清空并写为 `PAUSED`，再 abort controller。这样子进程的 `SIGTERM` 退出即使立即回调，`markFailed()` 与 `completeActor()` 也会发现 run 已失效，不会覆盖用户的暂停选择。
4. 清理 controller 时必须比较 `runId`；旧 run 的 finally 不得删除新 run 已登记的 controller。
5. 被中断的执行协程必须正常 resolve 回到 `startTask()`，不向最初的 IPC 调用抛出“actor 被 SIGTERM 杀死”的错误。停止是成功的用户命令，而非 launcher failure。
6. `interruptAndInsert()` 的旧 run 与其后 `sendMessage()` 启动的新 run 必须顺序执行：确认旧 run 已登记为暂停并已 abort 后，才允许新 run 开始，避免两个 actor 同时运行。

## 实施步骤

### Task 1: 建立“停止会终止真实子进程”的失败回归测试

**Files:**

- Modify: `tests/unit/main/buddy-runner-launcher.test.ts`

**Step 1: 写普通 launcher 的失败测试**

在 `BuddyRunner with fake launcher` 中增加一个使用 `process.execPath` 的长运行 contract launcher。测试夹具脚本应：

~~~ts
const fs = require('node:fs')
fs.writeFileSync(process.env.BUDDY_READY_FILE, String(process.pid))
setInterval(() => {}, 1_000)
~~~

测试通过 launcher `env` 传入测试目录下的 `BUDDY_READY_FILE`，并使用 `vi.waitFor()` 等待文件出现。不要以任意 sleep 代替 ready 条件。

启动方式必须保留未完成 promise：

~~~ts
const startPromise = runner.startTask('demo', {
  workspace_key: created.workspace_key,
  actor: 'claude'
})
await vi.waitFor(async () => {
  await expect(access(readyFile)).resolves.toBeUndefined()
})
await runner.interrupt('demo', created.workspace_key)
await expect(startPromise).resolves.toMatchObject({ run_id: expect.stringMatching(/^run_/) })
~~~

随后读取 ready 文件中的 PID，断言 `process.kill(pid, 0)` 抛出 `ESRCH`；并断言：

~~~ts
expect(detail.state.status).toBe('PAUSED')
expect(detail.state.active_run).toBeNull()
expect(detail.events).toEqual(expect.arrayContaining([
  expect.objectContaining({ type: 'actor.interrupted' })
]))
expect(detail.events).not.toEqual(expect.arrayContaining([
  expect.objectContaining({ type: 'actor.failed' }),
  expect.objectContaining({ type: 'actor.completed' }),
  expect.objectContaining({ type: 'actor.finished' })
]))
~~~

断言 `actor.interrupted.payload.run_id` 与启动返回的 run ID 一致。测试的单独 timeout 设为 10 秒，只容纳进程创建与 SIGTERM 回收，不能掩盖卡住的子进程。

**Step 2: 运行测试，确认当前实现失败**

~~~bash
pnpm vitest run tests/unit/main/buddy-runner-launcher.test.ts
~~~

预期：新测试超时或 PID 仍存在，因为当前 `interrupt()` 没有发送 signal；这是此次修复所需的失败证据。测试完成或失败后必须由夹具 `finally` 清理任何仍存活的测试 PID，避免污染开发机。

**Step 3: 写“打断并插入”失败测试**

复用同一个长运行 fake launcher，预先通过 `store.enqueueInstruction()` 加入一条指令，调用：

~~~ts
await runner.interruptAndInsert('demo', created.workspace_key, queueItem.id)
~~~

夹具的第二次调用可用 `BUDDY_MODE` 或一个 invocation counter 输出一条有效 buddy `chat` 结果并退出。断言旧 PID 已退出、第一 run 没有 `actor.failed` / `actor.completed`，且第二 run 的 `actor.started` 发生在 `actor.interrupted` 之后；最后让 `max_rounds: 1` 固定在既有 `PAUSED` 窗口，避免测试无限自动交接。

**Step 4: 再次运行测试，确认两个场景都失败**

~~~bash
pnpm vitest run tests/unit/main/buddy-runner-launcher.test.ts
~~~

预期：新增的直接停止与打断插入场景均失败；已有 launcher 成功、自动交接与 session 测试保持通过。

**Step 5: 提交测试基线（可选，若仓库允许失败测试独立提交）**

~~~bash
git add tests/unit/main/buddy-runner-launcher.test.ts
git commit -m "test(runner): cover launcher interruption"
~~~

若团队不接受失败提交，保留在同一工作树，继续 Task 2 后与实现一起提交。

### Task 2: 为运行中的 run 持有并传递取消句柄

**Files:**

- Modify: `src/main/buddy/runner.ts: BuddyRunner, startTask(), runActorCommand(), executeActor(), executeActorInner(), interrupt(), interruptAndInsert()`

**Step 1: 写最小的 run-controller 注册实现**

在 `BuddyRunner` 内新增私有内存注册表，例如：

~~~ts
private readonly runControllers = new Map<string, {
  runId: string
  controller: AbortController
}>()
~~~

增加私有 key helper，固定组合 `workspaceKey` 与 `taskId`，不要让 `runId` 单独作为 Map key。增加三个私有操作：登记当前 run、按三元组取回/abort、以及仅当 stored `runId` 相同才清理。

在 `startTask()` 成功写入新的 `active_run` 后立刻创建并登记 `AbortController`，再调用 `executeActor()`。将启动执行包在 `try/finally` 中，以便 launcher 正常完成、失败、超时、升级重试链结束或用户中断后都能条件清理：

~~~ts
const controller = new AbortController()
this.registerRunController(workspaceKey, taskId, runId, controller)
try {
  await this.executeActor(taskId, workspaceKey, actor, runId, input.message ?? '', controller.signal)
} finally {
  this.clearRunController(workspaceKey, taskId, runId)
}
~~~

`executeActor()`、递归的 `executeActorInner()` 与 `runActorCommand()` 都新增同一个 `signal: AbortSignal` 参数。不得在 context reset 或 upgrade retry 时重新创建 controller；同一 run 的 retry 必须共用原 signal。

在 `runActorCommand()` 两个分支都透传该 signal：

~~~ts
return runLauncherWithPty({ /* existing fields */, signal })
// 或
return runLauncher({ /* existing fields */, signal })
~~~

不要修改 `launchers.ts` 的 SIGTERM 实现；该文件已有完成的 signal 监听能力。

**Step 2: 将两个中断入口收敛到同一私有操作**

提取私有 `pauseAndAbortRun(taskId, workspaceKey, payload)`，供 `interrupt()` 与 `interruptAndInsert()` 使用。此方法必须：

1. 从状态快照读取当前 `active_run?.run_id` 和 actor；没有 active run 时保持当前暂停语义，但不可 abort 未知/新 run。
2. 通过一次 `updateTaskState()` 把当前状态置为 `PAUSED`、`active_run: null`、`updated_at` 更新；保留 `countdown`、queue、session 与其他字段。
3. 追加唯一的 `actor.interrupted`，payload 维持现有 reason（普通停止为空 object、插入为原有 reason/instruction ID），同时加入已捕获的 `run_id`（无 active run 时为 `null`）。
4. 在持久化暂停与事件写入后，仅当注册表中的 `runId` 与捕获的 run ID 相等时调用 `controller.abort()`。

`interruptAndInsert()` 仍然必须先校验和出队 instruction；替换其复制的暂停写入为上述私有方法，然后维持既有 `sendMessage()` 行为。不要让 queue item 缺失时中断 actor，保持当前先校验、后中断的行为。

**Step 3: 让用户中断成为正常的执行结束**

在 `executeActorInner()` 的 `catch` 顶部、任何上下文限制和升级检测之前，判断该 run 的 signal 是否已 abort：

~~~ts
if (signal.aborted) return
~~~

该 return 的前提是 Task 2 的中断入口已先清空 `active_run`；不要调用 `markFailed()`、不要抛出、不要安排重试。保留原有 `completeActor()` 和 `markFailed()` 的 `active_run` 守卫，作为晚到输出和非 signal 竞态的防线，不以它们替代实际 abort。

在正常退出路径中，`completeActor()` 的既有 run-ID guard 会忽略刚被停止的 run；不增加 transcript、不发布 `actor.completed` / `actor.finished`、不触发 `onTaskTerminal()`。service 在 interrupt 后既有的 queue terminal 通知仍负责调度层再评估。

**Step 4: 运行定向测试，确认通过**

~~~bash
pnpm vitest run tests/unit/main/buddy-runner-launcher.test.ts tests/unit/main/buddy-runner.test.ts tests/unit/main/buddy-queue-coordinator.test.ts
~~~

预期：Task 1 的两个物理中断测试通过；已有普通 launcher、session、轮次窗口和队列调度测试全部通过。特别核对没有因用户 stop 抛出未处理 rejection。

**Step 5: 提交实现与测试**

~~~bash
git add src/main/buddy/runner.ts tests/unit/main/buddy-runner-launcher.test.ts
git commit -m "fix(runner): abort launcher when task is interrupted"
~~~

### Task 3: 验证 PTY 透传、静态质量与桌面手工验收

**Files:**

- Verify: `src/main/buddy/runner.ts`
- Verify: `src/main/buddy/launchers.ts`
- Verify: `tests/unit/main/buddy-runner-launcher.test.ts`
- Verify: `tests/unit/main/buddy-launchers.test.ts`

**Step 1: 为 PTY 分支补充透传断言**

若 test runtime 可加载 `node-pty`，在 `buddy-runner-launcher.test.ts` 新增或扩展一个名为 `opencode` 的可执行 fake（用临时目录的 PATH 优先级解析），使 `commandKindFor()` 选择 `native_opencode`。该 fake 写 ready PID 后等待 SIGTERM。重复 Task 1 的停止流程，断言 start promise 正常 resolve、PID 消失、任务为 `PAUSED` 且无失败/完成事件。

若 CI 平台不具备 node-pty，不能跳过而宣称覆盖：保留 pipe 回归测试，并在 PR 中明确报告 PTY 实测不可用的原始错误；随后在能运行 macOS Electron runtime 的机器上执行本步骤。无论哪种情况，`src/main/buddy/runner.ts` 的 PTY 与 pipe 调用都必须传入同一个 `signal` 参数，并经代码审查确认。

**Step 2: 运行定向、全量与类型检查**

~~~bash
pnpm vitest run tests/unit/main/buddy-launchers.test.ts tests/unit/main/buddy-runner.test.ts tests/unit/main/buddy-runner-launcher.test.ts tests/unit/main/buddy-queue-coordinator.test.ts
pnpm typecheck
pnpm test
git diff --check
~~~

预期：所有命令退出码为 0；不得有遗漏 signal 参数、未使用 controller、测试超时、未清理的子进程或格式空白错误。

**Step 3: 桌面人工验收**

使用一个可安全运行至少一分钟的测试任务（不得针对真实生产仓库执行写操作）：

1. 启动任务，确认状态为“运行中”，并通过活动监视器或 `ps` 确认 Buddy 启动的 actor launcher 存在。
2. 点击 Composer 的方形停止按钮一次。确认状态立即变为“已暂停”，事件列表出现一次“已打断”。
3. 在 5 秒内确认该 launcher PID 已退出，且工作区没有继续产生 actor 输出、文件写入或工具调用。
4. 等待超过原任务的正常一次输出间隔，确认没有失败 toast、失败事件、完成事件或自动启动另一个 actor。
5. 点击“继续”，确认只启动一个新 run；旧 PID 不复活，新的 `active_run.run_id` 与停止事件中的 run ID 不同。
6. 再运行一次，在指令队列中加入一条指令并选择“打断并插入”。确认旧 PID 退出，插入内容仅由新 run 接收，并且队列/FIFO 语义与停止前一致。
7. 对实际 OpenCode launcher 重复步骤 1–4，确认 PTY 分支行为一致。

**Step 4: 最终提交核对**

~~~bash
git status --short
git log --oneline -3
~~~

预期：只包含本任务的测试与 runner 修复提交；不提交临时 launcher、测试 PID 文件、构建产物、用户任务数据或 `~/Library/Application Support/buddy/` 内容。

## 验收标准

1. 运行中的普通 launcher 点击停止后收到 `SIGTERM` 并退出；不再只是 UI/状态暂停。
2. 停止后持久化状态为 `PAUSED`、`active_run === null`，且事件中可关联被中断的 `run_id`。
3. 被停止 run 不追加 `actor.failed`、`actor.completed`、`actor.finished`，不写错误，不触发 session reset / upgrade retry / 自动交接。
4. stop 后继续任务只启动一个新 run；旧 run 的 finally 不会删除新 run 的取消句柄。
5. `interruptAndInsert()` 终止旧 run，再顺序启动承接指令的新 run，不遗失或重复 queue item。
6. pipe launcher 与 OpenCode PTY launcher 都接收到同一 AbortSignal；PTY runtime 若不可验证，必须如实报告原因及后续实测结果。
7. 所有 Task 3 自动化命令通过，`git diff --check` 无输出。

## 回滚

回滚本任务的 runner 修复提交即可恢复原停止语义；没有 schema、数据迁移或用户任务文件格式变化。回滚不会删除用户任务、会话 ID、队列条目、transcript 或 artifacts。

如修复上线后发现特定 launcher 因 SIGTERM 退出方式异常，应立即停止将该 launcher 作为支持结论，并保留任务在 `PAUSED` 的状态；根据该 CLI 的实际进程树和退出日志另行评估其专用兼容策略。不得以广泛杀进程、重置用户仓库或删除任务数据作为应急手段。
