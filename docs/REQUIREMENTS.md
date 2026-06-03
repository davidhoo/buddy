# Buddy 需求文档

## 1. 产品定位

Buddy 是一个 macOS 原生桌面应用，采用 Electron 构建。界面完全参照 Codex Desktop App 的三栏布局——左侧 Sidebar、中间 Chat、右侧面板（含运行状态 / 文件 / 审查 / 终端四个标签页）；业务逻辑完整移植自 buddy-python 的收敛式 AI 工程协作功能。

核心理念：两个 AI Actor（执行方 + Reviewer）轮流工作，每轮结束后给人 30 秒校准窗口，结果逐步收敛至正确。

### 1.1 目标用户

**主要用户**：
- 已经在日常开发中使用 Claude Code、Codex CLI、OpenCode 或 Kimi CLI 的个人开发者
- 需要让 AI 反复实现 / 审查 / 修正，并希望保留人工校准窗口的工程师
- 在多个本地项目之间切换，希望 AI 协作过程可恢复、可审计、可迁移的高级用户

**次要用户**：
- 希望观察 AI 工程协作过程、导出对话和运行证据的技术负责人
- 需要在 macOS 上用桌面界面管理 buddy-python 任务的既有用户

### 1.2 核心问题

Buddy 要解决的问题不是“再做一个聊天客户端”，而是把已经能工作的 buddy-python 收敛流程桌面化：

1. **多 Actor 协作难以持续管理**：人手动在不同 CLI 之间复制上下文、切换 reviewer、判断是否继续，成本高且容易漏状态。
2. **长任务缺乏可恢复性**：CLI 会话、倒计时、轮次、失败原因、输出文件分散，应用重启后难以准确接回。
3. **人工校准窗口不稳定**：没有明确的 30 秒决策窗口，用户容易错过“继续 / 修改 / 暂停 / 结束”的节点。
4. **本地工程上下文缺少统一视图**：任务状态、对话、文件、diff、终端分散在多个工具里，无法围绕同一 task scope 查看。

### 1.3 产品目标

| 目标 | 说明 | v0.1 验收信号 |
|------|------|--------------|
| 复刻收敛闭环 | TypeScript 等价重写 buddy-python 的双 Actor 轮转、break 双确认、失败暂停、session 复用 | Claude/Codex 可在真实仓库内完成“实现 → 审查 → 修正 → DONE” |
| 保持数据兼容 | 与 buddy-python 共用 `~/Library/Application Support/buddy/`，字段语义兼容 | buddy-python 创建的任务可被 macOS 打开，macOS 创建的任务可被 buddy-python 推进 |
| 降低操作负担 | 桌面 UI 常驻展示当前任务、状态、倒计时、下一 actor 和错误原因 | 用户不需要读 JSON 文件即可判断下一步操作 |
| 保留人工控制 | 每轮结束都有倒计时校准窗口，可跳过、暂停、补充指令、打断运行 | 任意自动推进前用户都有明确可见的取消入口 |
| 可审计和可恢复 | 事件、transcript、artifacts、状态文件完整持久化 | 杀进程后重启不丢失已完成轮次和失败原因 |

### 1.4 非目标

v0.1-v0.5 均不把以下事项作为产品目标，除非后续需求重新确认：

- 不提供云端同步、团队协作后台或远程任务队列
- 不实现通用 IDE，不替代 VS Code / Cursor / JetBrains
- 不承诺 Actor 子进程沙箱隔离，安全边界以本地 CLI 权限模型为准
- 不自动提交或推送用户代码，Review 标签页的 Accept/Reject 仅作用于本地工作区
- 不在 v0.1 支持 Windows / Linux

### 1.5 产品成功指标

| 指标 | 目标值 |
|------|--------|
| 首次可用路径 | 全新安装后 5 分钟内完成 launcher 配置并创建首个任务 |
| v0.1 核心闭环成功率 | 在示例仓库 smoke test 中，Claude/Codex 双 Actor 流程 3 次连续通过 |
| 恢复可靠性 | 主进程崩溃或应用重启后，最近一次稳定状态 100% 可恢复 |
| 数据兼容性 | buddy-python 与 Buddy 双向读取 golden fixture 全部通过 |
| 可诊断性 | launcher 不可用、权限提示、schema 不兼容、文件锁冲突均能给出明确错误和下一步 |

## 2. MVP 与版本规划

### 2.1 MVP（v0.1）

**目标**：最小可用产品，能完成 buddy-python 现有的核心收敛流程。

包含：
- Claude + Codex 两个 Actor（不含 OpenCode、Kimi）
- 三栏 UI 骨架（Sidebar + Chat + 右侧面板），右侧面板仅"运行状态"标签页可用，其余标签页按钮置灰
- 运行状态标签页采用 Codex App 风格的内嵌漂浮卡：进度 / 输出 / 来源三段式信息层级
- 任务 CRUD、Runner 状态机、倒计时、打断、双确认结束
- buddy-python 数据目录读写兼容
- Buddy Message Protocol 解析
- 错误态和基础诊断
- DMG 打包（不含签名公证）

不包含（推迟到后续版本）：
- OpenCode 和 Kimi（v0.2）
- 文件标签页（v0.2）
- 对话导出、UI 诊断页（v0.2）
- 终端标签页（v0.3）
- 审查标签页（v0.3）
- 系统托盘和后台运行（v0.3）
- Computer Use（v0.4）
- 自动更新、签名公证（v0.5）

### 2.2 版本路线图

| 版本 | 主要内容 |
|------|---------|
| v0.1 | MVP：Claude/Codex + 三栏 UI（Sidebar+Chat+右侧面板·运行状态标签页）+ 文件兼容 + Runner 闭环 |
| v0.2 | 补全 OpenCode/Kimi、文件标签页、对话导出、UI 诊断页 |
| v0.3 | 终端标签页（交互式 Shell）、审查标签页（diff/Accept/Reject）、系统托盘、通知、长对话性能 |
| v0.4 | Computer Use 基础版（截屏 + 点击 + 输入） |
| v0.5 | 代码签名、公证、自动更新 |

### 2.3 版本范围边界

| 版本 | 必须完成 | 明确不做 | 产品验收 |
|------|----------|----------|----------|
| v0.1 | Claude/Codex 双 Actor、任务 CRUD、Runner 闭环、数据兼容、Codex App 风格运行状态漂浮卡、DMG 打包 | OpenCode/Kimi、文件/审查/终端可用态、托盘、签名公证 | 用户能在单个 macOS 窗口里完成一个真实代码任务的 AI 实现与审查闭环 |
| v0.2 | OpenCode/Kimi、文件标签页、对话导出、诊断页 | 交互式终端、diff hunk 操作、后台常驻 | 用户能查看任务仓库文件、诊断 launcher、导出完整协作记录 |
| v0.3 | 终端标签页、审查标签页、托盘后台、通知、长对话性能优化 | Computer Use、自动更新 | 用户能在同一 task scope 内查看 diff、处理改动、执行 shell 命令并让任务后台运行 |
| v0.4 | Computer Use 基础操作、确认弹窗、应用白名单、Accessibility 权限引导 | 自动批准、跨设备控制、远程执行 | 用户能逐次批准 AI 对本机应用的受限操作，且每次操作可审计 |
| v0.5 | Developer ID 签名、公证、自动更新、发布流水线 | 企业 MDM 分发、云端账号体系 | 用户能安装可信 DMG，并在应用内收到更新 |

### 2.4 典型使用场景

#### 场景 A：从零创建 AI 协作任务（v0.1）

1. 用户打开 Buddy，确认 Claude/Codex launcher 可用。
2. 用户新建任务，选择本地 repo、填写目标、选择执行方和 reviewer。
3. 应用创建兼容 buddy-python 的任务目录与状态文件。
4. 用户点击启动，执行方开始运行；Chat 区展示结构化输出，运行状态标签页用漂浮卡展示进度、输出和来源。
5. Actor 完成后进入 30 秒倒计时，用户可补充指令、跳过、暂停或等待自动进入下一 actor。
6. 双方均输出 `type=break` 时任务进入 DONE，保留完整 transcript 与 artifacts。

#### 场景 B：恢复 buddy-python 任务（v0.1）

1. 用户此前用 buddy-python 创建并推进过任务。
2. Buddy 启动后扫描同一数据目录，展示 workspace 和任务列表。
3. 用户打开任务，看到历史 transcript、状态、next_actor、倒计时或失败信息。
4. 用户继续任务时，macOS 端使用原 session/thread ID 继续推进。

#### 场景 C：失败诊断与人工接管（v0.1-v0.2）

1. Actor 因 launcher 缺失、权限提示、非零退出码或 schema 问题失败。
2. 应用进入 FAILED 或 PAUSED，并在运行状态标签页显示错误类型、最近输出、建议操作。
3. 用户打开诊断页查看 launcher 命令、版本参数、工作目录权限和磁盘空间。
4. 用户修复配置后点击重试，任务从失败点继续，不清空历史记录。

#### 场景 D：审查和本地修改（v0.3）

1. Actor 完成一轮后，用户切换到审查标签页。
2. 应用显示当前 repo 的 git status 和 diff 摘要。
3. 用户按文件和 hunk 查看改动，选择接受、拒绝或保留给外部编辑器处理。
4. 用户可在终端标签页执行测试、查看日志或手动修复。

#### 场景 E：Computer Use 人工批准（v0.4）

1. Actor 请求对本机应用进行截屏、点击或输入。
2. 应用展示操作预览、目标应用和参数。
3. 用户批准后执行一次操作；拒绝则记录事件并让 Actor 收到失败反馈。
4. 每次操作都写入事件日志，不提供 v0.4 自动批准。

## 3. 技术架构

### 3.1 整体架构

```
┌─────────────────────────────────────────────────┐
│              Electron Main Process               │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │  Runner  │ │  Store   │ │  IPC Handler     │ │
│  │ (调度)   │ │ (持久层) │ │ (主进程 API)     │ │
│  └────┬─────┘ └────┬─────┘ └────────┬─────────┘ │
│       │            │                 │           │
│  ┌────┴─────┐ ┌────┴────┐      ┌─────┴────────┐ │
│  │ Launchers│ │   Git    │     │Window Manager│ │
│  │(spawn/PTY)│ │ (diff)   │     └──────────────┘ │
│  └──────────┘ └─────────┘                       │
└────────────────────┼────────────────────────────┘
                     │ IPC (ipcMain ↔ ipcRenderer)
┌────────────────────┼────────────────────────────┐
│           Electron Renderer Process              │
│  ┌─────────┬──────────────────┬───────────────┐ │
│  │         │                  │  Right Panel   │ │
│  │ Sidebar │  Chat (主对话)   │    400        │ │
│  │  260    │   (弹性宽度)     │  ┌──────────┐ │ │
│  │         │                  │  │Tabs:     │ │ │
│  │         │                  │  │运行状态  │ │ │
│  │         │                  │  │文件      │ │ │
│  │         │                  │  │审查      │ │ │
│  │         │                  │  │终端      │ │ │
│  │         │                  │  └──────────┘ │ │
│  └─────────┴──────────────────┴───────────────┘ │
└─────────────────────────────────────────────────┘
```

右侧面板通过标签页切换四个视图（运行状态 / 文件 / 审查 / 终端），默认显示"运行状态"。标签页与常驻三栏一体，不使用独立抽屉或浮层。

### 3.2 技术选型

| 层面 | 选型 | 说明 |
|------|------|------|
| 运行时 | Electron ^33（锁定主版本，不跨大版本升级） | macOS only |
| 主进程语言 | TypeScript 5+ | 完整重写 buddy-python 逻辑 |
| 渲染进程 | React 19 + TypeScript | 组件化 UI |
| 样式 | Tailwind CSS 4 | 延续 buddy-python 的 Starbucks 色系 |
| 构建 | electron-vite | 主进程/预加载/渲染进程统一构建 |
| 包管理 | pnpm | |
| 打包 | electron-builder | DMG 输出 |
| 子进程管理 | v0.1 默认 `child_process.spawn` 管道；PTY spike 通过后可切换 `node-pty` | 见 §3.3 进程模型 |
| Git 集成 | `simple-git` | 工作目录 diff、文件状态（v0.3+） |
| 终端渲染 | `xterm.js` + `xterm-addon-fit` | 右侧面板终端标签页（v0.3+） |
| 持久化 | JSON / JSONL / Markdown | 与 buddy-python 兼容 |
| Markdown 渲染 | react-markdown + remark-gfm | |
| 代码高亮 | Shiki | |
| 状态管理 | Zustand | 渲染进程内 |
| Schema 校验 | Zod | IPC 边界 + 文件读取边界 |

### 3.3 进程模型（待验证：PTY vs 管道）

> **决策状态**：待 PTY spike 验证。Spike 未通过前，默认使用 `child_process.spawn` 管道方案（与 buddy-python 一致）。

**方案 A：`child_process.spawn` 管道（与 buddy-python 一致，备选默认）**

- `stdout=PIPE`、`stderr=PIPE`、`stdin=PIPE`，与 buddy-python `launchers.py` 完全一致
- stdout 行读取 JSON stream，stderr 用 `select`/`poll` 非阻塞读取检测权限提示
- stdin 写入 prompt 后 `stdin.close()` 发送 EOF，语义清晰
- 缺点：无终端视图回放（右侧面板终端标签页需额外方案，如独立 Shell PTY）

**方案 B：`node-pty` 统一走 PTY（待验证）**

- PTY master 由主进程持有，stdout 流用于 JSON stream 解析
- 风险点（需 spike 验证）：
  1. **ANSI 混流**：PTY 会注入 ANSI 转义码、提示符、CRLF，与 JSON stream 解析冲突
  2. **stdin EOF**：PTY 没有标准 EOF 信号，prompt 写入后如何通知 Claude/Codex 输入结束？需要验证 `pty.write(text + '\x04')`（Ctrl+D）是否有效
  3. **stderr 分离**：PTY 合并 stdout/stderr，无法独立检测 stderr 中的权限提示关键词
  4. **交互控制字符**：PTY 可能回显输入，产生额外输出
- Codex 的 `-o OUTPUT_FILE` 选项将完整 JSON 输出写入指定文件；若走 PTY 方案，需确认 Codex 是否同时向 stdout 输出 JSON 流
- 主进程在内存中跑 JSON stream parser，提取结构化事件后通过 `events:push` 推给渲染进程

**Spike 验收标准**：
- Claude `stream-json` 模式：PTY 启动 → stdin 写入 prompt + EOF → 成功解析完整 JSON stream → 捕获 session_id
- Codex `--json` 模式：PTY 启动 → stdin 写入 prompt + EOF → 成功解析完整 JSON stream → 捕获 thread_id
- 两种模式下：stderr 权限提示关键词可检测；无 ANSI 残留干扰 JSON 解析

**Spike 未通过时**：使用方案 A（管道），右侧面板终端标签页使用独立 Shell PTY（方案 B 仅用于交互式 Shell，不用于 Actor 进程）。

此外，**右侧面板"终端"标签页拥有独立的 Shell PTY**（无论 Actor 进程走哪种方案）：
- 由用户点击"终端"标签页时创建，`cwd` 为当前任务的 `repo_root`
- Shell PTY 与 Actor PTY 完全独立，用户可交互输入（交互式 Shell）
- Shell PTY 通过 `terminal:data` IPC 推送原始字节到渲染进程，xterm.js 渲染并接受键盘输入
- 切换任务时销毁旧 Shell PTY 并在新 `repo_root` 下创建

### 3.4 与 buddy-python 的关系

类比 Codex CLI 与 Codex Desktop App 的关系：

- **同级独立产品**：两者各自可独立安装、独立运行，没有上下级依赖
- **共享同一数据层**：同一个 `~/Library/Application Support/buddy/` 目录，同一套 schema
- **任务可在两者间无缝切换**：在 buddy-python 创建/推进的任务，Buddy 能直接打开继续；反之亦然（前提是 schema 版本兼容）
- **逻辑等价但独立实现**：状态机、Runner、Launchers、Prompts 用 TypeScript 等价重写，行为与 buddy-python 一致；不通过 IPC 或子进程共享 Python 代码
- **并发策略**：允许两者同时运行，仅在「同一任务的运行权」上互斥，详见 §5.5

## 4. 状态机

### 4.1 状态集合

| 状态 | 含义 |
|------|------|
| `READY` | 任务已创建，未启动过任何 actor |
| `RUNNING_CLAUDE` / `RUNNING_CODEX` / `RUNNING_OPENCODE` / `RUNNING_KIMI` | 对应 actor 子进程运行中 |
| `COUNTDOWN` | actor 完成后的 30 秒校准窗口 |
| `PAUSED` | 暂停（轮次窗口到达、连续失败、用户主动暂停） |
| `INTERRUPTING` | 已发送打断信号，等待子进程退出 |
| `FAILED` | launcher 错误或非零 exit code，需人工介入 |
| `DONE` | 双确认结束 |

### 4.2 完整状态转移表

与 buddy-python 一致的转移用「沿用」标注，macOS 新增/变更用「macOS」标注。

| 当前状态 | 触发事件 | 下一状态 | 副作用 | 来源 |
|---------|---------|---------|--------|------|
| `READY` | `tasks:start` | `RUNNING_*`（按 next_actor） | 创建 run_id、写 prompt 文件 | 沿用 |
| `RUNNING_*` | actor exit 0 + 解析成功 + 非双 break | `COUNTDOWN` | 写 transcript、events、更新 round、设 countdown | 沿用 |
| `RUNNING_*` | actor exit 0 + 双方都 type=break | `DONE` | 清 pending_break，关闭任务 | 沿用 |
| `RUNNING_*` | actor exit 0 + 首方 type=break | `COUNTDOWN` | 设 pending_break={actor, round} | 沿用 |
| `RUNNING_*` | LauncherError（exit ≠ 0 或权限提示） | `FAILED` | consecutive_failures +1，写 last_error | 沿用 |
| `FAILED` | consecutive_failures 达到上限 | `PAUSED` | 不再自动重试，等待用户 | macOS：从 FAILED 拆出 |
| `RUNNING_*` | `tasks:interrupt` | `INTERRUPTING` | 发送 SIGINT | macOS |
| `INTERRUPTING` | 子进程退出 | `PAUSED` | 记录 interrupted event | macOS |
| `INTERRUPTING` | 2s 超时 | `INTERRUPTING` | 升级到 SIGTERM | macOS |
| `INTERRUPTING` | 再 2s 超时 | `PAUSED` | 升级到 SIGKILL | macOS |
| `COUNTDOWN` | 倒计时到期 | `READY`（瞬时持久化后立即启动 `RUNNING_*`） | 标记 countdown.status="elapsed"，写 `countdown.elapsed`，自动启动下一 actor；若 round_window 已满 → `PAUSED` | 沿用 |
| `COUNTDOWN` | `tasks:skip-countdown` | `READY`（瞬时持久化后立即启动 `RUNNING_*`） | countdown.status="skipped"，写 `countdown.skipped`，自动启动下一 actor | 沿用 |
| `COUNTDOWN` | `tasks:pause-countdown` | `READY` | countdown.status="paused" | 沿用 |
| `COUNTDOWN` | `tasks:message`（含选择 next_actor） | `RUNNING_*` | 写入 human transcript，启动指定 actor | 沿用 |
| `COUNTDOWN` | 5 分钟宽限期到期（应用重启场景） | `PAUSED` | 标记倒计时已过期 | macOS |
| `READY` | `tasks:start` 或 `tasks:message` | `RUNNING_*` | 重置 rounds_in_window 计数器 | 沿用 |
| `PAUSED` | `tasks:start` 或 `tasks:message` | `RUNNING_*` | 重置 rounds_in_window 计数器 | 沿用 |
| `FAILED` | `tasks:start`（用户点击重试） | `RUNNING_*` | 重置失败计数 | 沿用 |
| `FAILED` | `tasks:message` | `RUNNING_*` | 写入消息 + 重试 | 沿用 |
| `DONE` | `tasks:message` 或 `tasks:start` | `RUNNING_*` | 重新开启对话 | 沿用 |
| 任意 | `tasks:delete` | （任务消失） | 清理子进程、删除目录 | 沿用 |
| `RUNNING_*`（应用重启发现） | 启动时检测孤儿进程 | `PAUSED` | 标记 active_run 为 interrupted | macOS |
| `INTERRUPTING`（应用重启发现） | 启动时检测 | `PAUSED` | SIGKILL 残留子进程 | macOS |

### 4.3 边界规则

- **打断后 exit code 非零**：算 `PAUSED`（用户主动行为，不计入失败计数）
- **打断后 exit code 为零**：仍算 `PAUSED`（用户意图明确）
- **倒计时期间用户发消息**：next_actor 取请求中显式指定值；未指定则用 state.next_actor
- **pause-countdown**：状态回到 `READY`，countdown.status 设为 `"paused"`（与 buddy-python 一致）
- **skip-countdown**：状态先回到 `READY`，countdown.status 设为 `"skipped"`，随后立即启动下一 actor；用户语义是"跳过等待并继续"，不是只取消倒计时（与 buddy-python `server._skip_countdown()` 一致）
- **DONE 后重开**：保留全部历史 transcript，state.round 继续递增；`rounds_in_window` 重置为 0；`consecutive_failures` 重置为 0
- **FAILED 重试**：仅重置失败计数，不清理 events.jsonl 或 transcript
- **FAILED + 达到失败上限**：进入 `PAUSED`，需用户手动继续

## 5. 数据 Schema 与持久化

### 5.1 Schema 版本

所有结构化文件首字段为 `protocol_version: "1"`（等价于 `"1.0"`）。版本不一致时：
- 主版本相同（"1" / "1.0" / "1.x" → "1.y"）：兼容读取，仅用已知字段
- 主版本不同：拒绝读取并提示用户升级或导出迁移

`Buddy` v0.1 写入 `protocol_version: "1"`，与 buddy-python 当前版本一致。如未来需扩展字段，新字段必须有合理默认值，老版可忽略。次版本号仅在需要区分兼容性增量时引入（如 `"1.1"`），`"1"` 与 `"1.0"` 视为等价。

### 5.2 目录结构

```
~/Library/Application Support/buddy/
├── global_settings.json
├── runtime/
│   ├── tasks/
│   │   └── {workspace_key}__{task_id}.lock   # 任务级运行锁，见 §5.5
│   └── buddy.log            # 应用日志
└── workspaces/
    └── {project-name}-{12-char-hash}/
            # hash = sha256(default_repo_root).slice(0,12)，与 buddy-python 一致
        ├── workspace.json
        └── tasks/
            └── {task_id}/
                ├── task.md
                ├── context.md
                ├── settings.json
                ├── state.json
                ├── status              # 单行状态文件，便于外部脚本读取
                ├── events.jsonl
                ├── transcript.jsonl
                ├── rounds/             # 预留
                └── artifacts/
                    ├── {run_id}-prompt.md
                    ├── {run_id}-output.md
                    └── {run_id}-events.jsonl
```

### 5.3 文件 Schema 详细定义

#### `global_settings.json`

```typescript
{
  protocol_version: "1",
  launchers: {
    claude: { command: string, env: Record<string,string>, timeout_seconds: number },
    codex: { command: string, env: Record<string,string>, timeout_seconds: number },
    opencode?: { ... },  // v0.2+
    kimi?: { ... }       // v0.2+
  },
  max_rounds: number,                  // 默认 10
  countdown_seconds: number,           // 默认 30
  max_consecutive_failures: number,    // 默认 3
  allow_dangerous_flags: boolean,      // 默认 true，见 §10.2
  panel_widths?: {                     // 面板尺寸记忆
    sidebar?: number,                  // 默认 260
    right_panel?: number               // 默认 400，见 §6.3 右侧面板
  },
  active_right_tab?: string            // 右侧面板当前激活的标签页，默认 "status"
}
```

#### `workspace.json`

```typescript
{
  protocol_version: "1",
  workspace_key: string,                // 12-char hash，与 buddy-python 一致
  default_repo_root: string,            // 绝对路径
  display_name?: string,                // 可选，rename_workspace 时写入
  updated_at: string                    // ISO 8601
}
```

#### `settings.json`（每任务）

```typescript
{
  protocol_version: "1",
  countdown_seconds: number,
  flow_policy: string,                  // "claude_then_codex"，完全沿用 buddy-python
  role_mode: string,                    // "claude_implements" | "codex_implements"，完全沿用 buddy-python
  max_rounds: number,
  max_consecutive_failures: number,
  implementer_actor: "claude" | "codex" | "opencode" | "kimi",
  reviewer_actor: "claude" | "codex" | "opencode" | "kimi",
  allow_dangerous_flags?: boolean,      // macOS 新增，旧版忽略；默认继承 global_settings，见 §10.2
  computer_use_enabled?: boolean,       // macOS 新增，旧版忽略；默认 false，见 §10.2
  launchers: {
    [actor]: { command: string, env: Record<string,string>, timeout_seconds: number }
  },
  seed_claude_session_id?: string,
  seed_codex_thread_id?: string,
  seed_opencode_session_id?: string,    // 完全沿用 buddy-python
  seed_kimi_session_id?: string         // 完全沿用 buddy-python
}
```

#### `state.json`（每任务）

```typescript
{
  protocol_version: "1",
  task_id: string,
  repo_root: string,
  status: TaskStatus,                  // 见 §4.1
  round: number,                       // 总轮次
  rounds_in_window: number,            // 当前自动推进窗口已用轮次
  next_actor: ActorName,
  claude_session_id: string | null,
  codex_thread_id: string | null,
  opencode_session_id?: string | null,
  kimi_session_id?: string | null,
  context_hash: string,                // sha256(context.md)
  context_sent: { [actor]: boolean },
  active_run: ActiveRun | null,
  countdown: Countdown | null,
  pending_break: { actor: ActorName, round: number } | null,  // round 非 reason，与 buddy-python 一致
  event_seq: number,
  transcript_seq: number,
  consecutive_failures: number,
  last_error: {                        // 完全沿用 buddy-python
    message: string,
    actor: ActorName,
    run_id: string,
    ts: string,
    output_file: string,
    event_file: string
  } | null,
  created_at: string,
  updated_at: string
}

type ActiveRun = {
  run_id: string,
  actor: ActorName,
  started_at: string,
  status: "running",                   // buddy-python 仅 "running"
  session_id_before: string | null,
  session_id_after: string | null
}

type Countdown = {
  started_at: string,
  deadline: string,                    // ISO 8601
  after_actor: ActorName,
  default_next_actor: ActorName,
  status: "running" | "paused" | "skipped" | "elapsed" | "expired"   // 与 buddy-python 一致
}
```

#### `events.jsonl`

每行：`{seq: number, ts: string, type: string, actor?: ActorName, run_id?: string, task_id?: string, payload: object}`

| type | 含义 | payload 必含字段 |
|------|------|----------------|
| `task.created` | 任务创建 | `task_id` |
| `actor.started` | actor 开始 | `mode` |
| `actor.stream` | 流式片段 | `text`（脱敏后） |
| `actor.stderr` | actor stderr 输出 | `text` |
| `actor.finished` | actor 正常完成 | `elapsed_ms`, `exit_code` |
| `actor.failed` | actor 失败 | `error`, `output_file?`, `event_file?` |
| `actor.interrupted` | 被打断 | `discarded_output` |
| `break.pending` | 首方请求结束 | `elapsed_ms`, `exit_code`, `buddy_type`, `pending_confirmation_from` |
| `break.rejected` | 另一方拒绝结束 | `rejected_break_from` |
| `countdown.started` | 倒计时开始 | `seconds`, `after_actor`, `default_next_actor` |
| `countdown.skipped` | 跳过 | `next_actor` |
| `countdown.paused` | 暂停 | `next_actor` |
| `countdown.elapsed` | 正常倒计时到期并自动推进 | `next_actor` |
| `countdown.expired` | 应用重启恢复时发现倒计时超过 5 分钟宽限期，进入 `PAUSED` | `deadline`, `grace_seconds` |
| `round_window.paused` | 轮次窗口达到上限 | `max_rounds`, `rounds_in_window`, `next_actor` |
| `round_window.reset` | 轮次窗口重置 | `source` |
| `human.message` | 用户输入 | `content` |
| `task.done` | 双确认结束 | `reason`, `first_actor`, `second_actor`, `round` |
| `permission.detected` | 权限提示拦截 | `keyword`, `stderr_excerpt` |
| `buddy.session` | session/thread ID 捕获 | `actor`, `session_id?`, `thread_id?` |

unknown type 由 parser 原样保存到 raw event，不丢弃。

#### `transcript.jsonl`

每行：`{seq: number, ts: string, role: "human" | ActorName, content: string, meta: object}`

`meta` 至少包含 `round`、`session_id`（actor 行）、`run_id`（actor 行）。

### 5.4 原子写入

- **覆盖写**（`state.json`、`settings.json`、`status`）：写入临时文件 `{file}.tmp`，`fsync` 后 `rename` 替换原文件
- **追加写**（`events.jsonl`、`transcript.jsonl`、`artifacts/*-events.jsonl`）：以 `O_APPEND` 打开，单次 `write` 调用写完整行 + `\n`，仅在写完整行后 flush
- **崩溃恢复**：JSONL 末尾不完整行（缺 `\n`）忽略；其他文件回退到 `{file}.tmp` 不存在时使用原文件

### 5.5 并发策略

类比 Codex CLI 与 Codex Desktop App：buddy-python 和 Buddy 可同时运行，互不阻塞；仅在「同一任务的运行权」上互斥。

#### 写入锁：`{task_dir}/.buddy.lock`

沿用 buddy-python 的锁方案：每个任务目录下的 `.buddy.lock` 文件，通过 `flock(LOCK_EX)` 互斥。

- **锁文件位置**：`{task_dir}/.buddy.lock`（与 buddy-python 一致）
- **锁获取方式**：`flock(LOCK_EX | LOCK_NB)`，获取失败说明该任务正被另一进程操作
- **Node.js 实现**：`fs-ext` 包的 `flock()` 方法
- **锁粒度**：buddy-python 在 state 写入、event 追加时均持锁；macOS 沿用同一粒度
- **锁的生命周期**：buddy-python 在 `task_lock()` 上下文中持锁（包括 state 写入）；actor 运行期间不额外持锁

#### 运行锁：`runtime/tasks/{workspace_key}__{task_id}.lock`

macOS 新增运行锁，用于表达「某个任务当前有 actor 正在运行」。它不替代 `.buddy.lock`，两者职责不同：

- `.buddy.lock`：短生命周期写入锁，保护 `state.json`、`events.jsonl`、`transcript.jsonl`、`status`、`artifacts/*` 的一致性
- `runtime/tasks/*.lock`：actor 运行占用标记，生命周期覆盖 actor 子进程从启动到退出
- 运行锁内容：`{ pid: number, app: "buddy", started_at: string, run_id: string, workspace_key: string, task_id: string }`
- macOS 启动 actor 前必须先创建运行锁；退出、失败、打断完成后删除；发现 PID 不存在的陈旧运行锁时删除并写诊断日志

#### 与 buddy-python 的跨进程互斥（降级策略）

当前 buddy-python 的 `.buddy.lock` 仅在同一进程内互斥（threading RLock + flock），不写入 PID 等信息，无法跨进程发现。

为实现 buddy-python 与 Buddy 的精确跨进程运行互斥，需要后续同步修改 buddy-python：

- buddy-python 也写入同格式的 `runtime/tasks/{workspace_key}__{task_id}.lock`
- buddy-python 运行锁内容中的 `app` 为 `"buddy-python"`
- 此修改在 buddy-python 未同步前，macOS 端采用降级策略：若检测到 buddy-python 进程正在访问同一任务目录（通过 `lsof` 或 `fuser`），该任务在 macOS 中进入外部占用只读模式；若无法精确判断，则允许读取但启动前弹窗提示「无法确认 buddy-python 是否正在运行该任务」，用户确认后才可启动

#### 跨进程任务发现

每个进程在启动时和定期（5s 间隔）扫描 `runtime/tasks/*.lock`，并结合降级检测结果，构建「正被其他进程运行的任务」列表：

- Sidebar 任务卡显示外部运行图标（小圆点 + 工具提示「buddy-python 正在运行此任务」）
- 任务详情页只读模式打开：可查看 transcript、events，不能点击启动/打断/发送消息
- 用户尝试启动被别处占用的任务时，弹窗提示「该任务由 buddy-python (PID xxx) 占用」

#### 数据一致性

- **不假设监听文件变化**：渲染进程不通过 fs watch 接收外部进程的写入；用户切换到外部运行的任务时主动重读
- **写入隔离**：本进程仅在持有任务锁时写入 `state.json`、`events.jsonl`、`transcript.jsonl`、`status`、`artifacts/*`
- **读取容错**：读取外部进程正在写入的文件时，按 §5.4 的规则处理不完整 JSONL 行
- **schema 版本不一致**：仅当主版本号不同时报错；详见 §5.1

#### 全局设置的并发

`global_settings.json` 是覆盖写入文件，没有跨进程协调：
- 各进程读取后缓存到内存，定期（30s）轮询 mtime 检测变更
- 写入采用「读 → 改 → 写」三步，写入前检查 mtime 未变更，否则提示用户合并冲突
- 该文件变更不影响正在运行的 actor（启动时已快照到 task settings）

#### 文件读取容错

- 读取 JSON 失败：记录日志，回退默认值，IPC 推送 `system.warning` 事件
- 读取 JSONL 损坏行：跳过该行，继续后续行

### 5.6 数据迁移

v0.1 不主动迁移老数据。后续若 schema 升级：
- 启动时检测 `protocol_version`
- 若主版本不一致，引导用户进入「数据迁移」页面
- 迁移过程：创建备份目录 → 转换 → 校验 → 替换 → 失败时回滚

### 5.7 buddy-python 兼容契约

以 buddy-python 当前实现（`buddy3/`）为基准，逐字段标注兼容策略：

**图例**：沿用 = 字段名和语义完全一致；新增 = macOS 新增、旧版忽略；待同步 = 需要同步修改 buddy-python

#### `global_settings.json`

| 字段 | 策略 | 说明 |
|------|------|------|
| `protocol_version` | 沿用 | `"1"` |
| `countdown_seconds` | 沿用 | 默认 30 |
| `max_rounds` | 沿用 | 默认 10 |
| `max_consecutive_failures` | 沿用 | 默认 3 |
| `launchers` | 沿用 | 4 个 actor 各有 command/env/timeout_seconds |
| `allow_dangerous_flags` | 新增 | macOS 新增，buddy-python 不读取时忽略 |
| `panel_widths` | 新增 | macOS UI 专用，buddy-python 忽略 |
| `active_right_tab` | 新增 | macOS UI 专用，buddy-python 忽略 |

#### `workspace.json`

| 字段 | 策略 | 说明 |
|------|------|------|
| `protocol_version` | 沿用 | |
| `workspace_key` | 沿用 | 注意：文档曾误写为 `key`，已修正 |
| `default_repo_root` | 沿用 | |
| `display_name` | 沿用 | 可选，仅 rename 时写入 |
| `updated_at` | 沿用 | |
| `created_at` | **不沿用** | buddy-python 不写此字段，macOS 也不写入 |

#### `settings.json`（每任务）

| 字段 | 策略 | 说明 |
|------|------|------|
| `protocol_version` | 沿用 | |
| `countdown_seconds` | 沿用 | |
| `flow_policy` | 沿用 | `"claude_then_codex"`，文档曾遗漏，已补回 |
| `role_mode` | 沿用 | `"claude_implements"` / `"codex_implements"`，文档曾删除，已补回 |
| `max_rounds` | 沿用 | |
| `max_consecutive_failures` | 沿用 | |
| `implementer_actor` | 沿用 | |
| `reviewer_actor` | 沿用 | |
| `launchers` | 沿用 | |
| `seed_claude_session_id` | 沿用 | |
| `seed_codex_thread_id` | 沿用 | |
| `seed_opencode_session_id` | 沿用 | 文档曾遗漏，已补回 |
| `seed_kimi_session_id` | 沿用 | 文档曾遗漏，已补回 |
| `allow_dangerous_flags` | 新增 | macOS 新增，buddy-python 忽略 |
| `computer_use_enabled` | 新增 | macOS 新增，buddy-python 忽略 |

#### `state.json`（每任务）

| 字段 | 策略 | 说明 |
|------|------|------|
| `protocol_version` | 沿用 | |
| `task_id` | 沿用 | |
| `repo_root` | 沿用 | |
| `status` | 沿用 | 值集合见 §4.1 |
| `round` | 沿用 | |
| `rounds_in_window` | 沿用 | |
| `next_actor` | 沿用 | |
| `claude_session_id` | 沿用 | |
| `codex_thread_id` | 沿用 | |
| `opencode_session_id` | 沿用 | |
| `kimi_session_id` | 沿用 | |
| `context_hash` | 沿用 | |
| `context_sent` | 沿用 | |
| `active_run` | 沿用 | 注意：buddy-python 无 `pid` 字段 |
| `countdown` | 沿用 | status 值: `"running"` / `"paused"` / `"skipped"` / `"elapsed"` / `"expired"` |
| `pending_break` | 沿用 | `{ actor, round }`（非 `reason`） |
| `last_error` | 沿用 | 文档曾遗漏，已补回 |
| `event_seq` | 沿用 | |
| `transcript_seq` | 沿用 | |
| `consecutive_failures` | 沿用 | |
| `created_at` | 沿用 | |
| `updated_at` | 沿用 | |

#### 互斥锁

| 项目 | buddy-python 现状 | macOS 方案 | 策略 |
|------|-------------------|-----------|------|
| 锁获取方式 | `fcntl.flock(LOCK_EX)` | `fs-ext` flock | 沿用语义 |
| 锁粒度 | 任务级（state 写入、event 追加均持锁） | 同左 | 沿用 |
| 写入锁 | `{task_dir}/.buddy.lock` | 同左 | 沿用 |
| 运行锁 | 无 | `runtime/tasks/{workspace_key}__{task_id}.lock` | 新增：macOS 内部精确互斥 |
| 跨进程发现 | 无（单进程） | 扫描 `runtime/tasks/*.lock` + buddy-python 降级检测 | 待同步：buddy-python 写入运行锁后可精确互斥 |

#### 状态机差异

| 转移 | buddy-python | macOS | 策略 |
|------|-------------|-------|------|
| `pause_countdown` | 状态→READY，countdown.status→"paused" | 同左 | 沿用 |
| `skip_countdown` | 状态→READY | 同左 | 沿用 |
| `FAILED + 达到失败上限` | runner 抛异常，由上层决定 | 状态→FAILED，consecutive_failures 自增 | 沿用行为，但 UI 可在上层自动暂停 |

## 6. 界面设计

### 6.1 整体信息架构

参照 Codex Desktop 的三栏布局：左侧 Sidebar、中间 Chat、右侧面板（含四个标签页）。

```
┌──────────────────────────────────────────────────────────────────────┐
│  Buddy                                              [⌘1][⌘2][⌘3][⌘4]│
├──────────┬────────────────────────────┬──────────────────────────────┤
│          │  Task: fix-auth            │  ▸运行状态  文件  审查  终端  │
│  Sidebar │  ┌─ status pill ─────────┐ │                              │
│  260     │  │ READY · Round 0       │ │  运行状态（默认标签页）        │
│          │  └──────────────────────┘  │  ╭──────────────────────╮   │
│ ┌──────┐ │                            │  │ 进度                 │   │
│ │+ 新建│ │  ┌────────── Chat ──────┐  │  │ ✓ Claude 实现        │   │
│ ├──────┤ │  │ Human: ...           │  │  │ ◌ Codex 审查         │   │
│ │auth  │ │  │ Claude: ...          │  │  ├──────────────────────┤   │
│ ├──────┤ │  │ Codex: ...           │  │  │ 输出                 │   │
│ │refac │ │  └──────────────────────┘  │  │ 最近产物 / 暂无产物   │   │
│ └──────┘ │                            │  ├──────────────────────┤   │
│ ⚙ 设置   │                            │  │ 来源                 │   │
│ ? 帮助   │  ┌─ Composer ──────────┐   │  │ session / artifact    │   │
│          │  │ 补充指令...         │   │  ╰──────────────────────╯   │
│          │  │ [Claude▼] [继续]    │   │                              │
│          │  └─────────────────────┘   │                              │
└──────────┴────────────────────────────┴──────────────────────────────┘
```

**关键设计点**：

- **三栏一体**：Sidebar / Chat / Right Panel 始终可见，右侧面板通过标签页切换内容，不使用独立抽屉或窗口级浮层
- **运行状态漂浮卡**：运行状态标签页内部使用 Codex App 风格的白色漂浮卡（圆角、轻描边、轻阴影），作为右侧面板内容容器；它不覆盖 Chat，也不脱离右侧面板布局
- **四个标签页**：运行状态（默认）/ 文件 / 审查 / 终端，快捷键 Cmd+1/2/3/4 切换
- **作用域**：右侧面板所有标签页绑定当前任务（current task scope）；切换任务时内容跟随刷新
- **快捷键全局**：Cmd+1/2/3/4 在任意焦点下都生效（Composer 输入除外，需明确 escape）

### 6.2 响应式与最小尺寸

- 最小窗口尺寸：1280 × 800
- 默认窗口尺寸：1600 × 1000
- < 1280：拒绝缩放（macOS 系统限制窗口）
- 1280 - 1440：Sidebar 折叠为图标列（48），Chat 和 Right Panel 平分宽度
- 1440 - 1680：Sidebar/Chat/Right Panel 三栏全展开
- ≥ 1680：三栏均保持可读宽度，Chat 区空间充裕
- 各面板宽度持久化到 `global_settings.json` 的 `panel_widths` 字段（见 §5.3）；用户拖拽分割条调整后立即落盘

### 6.3 各栏详细设计

#### Sidebar（260 / 折叠 48）

- 顶部：Buddy logo + 副标题
- 新建任务按钮（绿色 pill）
- 任务列表：按 workspace 分组，显示任务名、状态色标、最近更新时间
- 底部：全局设置齿轮、帮助图标
- 折叠后：仅图标列

#### Chat 中间区（弹性宽度）

**顶部栏**：
- 任务名 + 状态 pill
- 失败重试按钮（仅 FAILED 显示）

**对话流**：
- 消息类型：human / claude / codex / opencode / kimi / system
- Actor 消息显示：badge、时间戳、耗时、session ID（可复制）、round
- Markdown + 代码高亮
- 流式输出 + 动态耗时
- 空状态：引导创建第一个任务

注意：原始 PTY 输出不嵌入对话流——Actor 结构化输出经 Buddy Message Protocol 解析后展示；原始字节存储在 `artifacts/{run_id}-events.jsonl`。

**Composer**：
- 多行文本框（Shift+Enter 换行，Enter 发送，Cmd+Enter 强制发送）
- 下一轮 actor 选择器
- "继续" 按钮（绿色 pill）
- "打断当前运行"（仅 RUNNING 显示）
- "取消自动开始"（仅自动开始倒计时期间显示）

#### 右侧面板（400，可拖拽 280-600）

顶部四个标签页切换按钮，点击或快捷键 Cmd+1/2/3/4 切换。

##### 运行状态标签页（默认，Cmd+1）

原 Inspector 功能合并到右侧面板，并采用 Codex App 风格的内嵌漂浮卡：

- **容器样式**：白色浮起面板，圆角 16-24px，浅灰描边，轻阴影，内边距 24-32px；在右侧面板内居中排列，不遮挡 Chat 或 Composer
- **进度 section**：展示当前任务的收敛步骤列表，每一项包含状态图标、Actor 名称、阶段说明和可选耗时
  - 已完成：实心勾选图标
  - 运行中：环形进度 / spinner
  - 等待中：空心圆
  - 失败：红色错误图标 + 简短原因
- **输出 section**：展示最近一次 actor 产物摘要，默认文案为"暂无产物"；有 artifact 时显示文件名、生成时间和打开/复制入口
- **来源 section**：展示 session/thread ID（脱敏显示，可复制完整值）、run_id、artifact 文件、事件序号范围
- **辅助信息**：轮次、next_actor、连续失败次数、倒计时剩余时间以紧凑行内信息展示，不再拆成多个卡片
- **诊断入口**：Launcher 状态以小型状态行展示，异常时可展开查看诊断详情
- 倒计时最后 10 秒：弹出全屏覆盖层
- **空状态**：无任务时显示"暂无任务"；任务尚未运行时显示 READY、下一 actor 和启动入口

##### 文件标签页（Cmd+2，v0.2+）

参照 Codex Desktop 的 File Tree 面板：

- **顶部**：当前 `repo_root` 路径（可复制）
- **文件树**：lazy load，遵循 `.gitignore`
- **文件预览**：点击文件在标签页内显示只读预览（Markdown / 代码 / 图片），左侧文件树 + 右侧预览的双栏布局
- **主进程 IPC**：`fs:list-directory` / `fs:read-file-preview`，限定路径必须在 `repo_root` 下
- **.gitignore**：使用 `ignore` 包解析
- **文件预览限制**：< 1MB 文本直接读，二进制显示占位，图片用 `<img>` 加载本地文件协议（沙箱中需配置 `protocol.registerFileProtocol`）
- **作用域**：当前任务的 `repo_root`

##### 审查标签页（Cmd+3，v0.3+）

参照 Codex Desktop 的 Review 面板：

- **触发可见**：仅当任务的 `repo_root` 是 git 仓库时启用标签页
- **结构**：
  - 顶部摘要条：本轮 actor 改动 N 个文件，+X / -Y 行；切换 base（HEAD / 上一轮 actor 完成时的 commit）
  - Changed files：手风琴列表，每个文件可展开查看 diff
  - Inline diff：双栏或单栏视图（用户偏好），Shiki 语法高亮
  - 每个 hunk 旁的 Accept / Reject 按钮：接受则保留工作区改动，拒绝则按 hunk 反向应用
- **数据来源**：`simple-git` 调用 `git diff` / `git status`；不依赖 actor 的 stdout
- **主进程 IPC**：`git:diff` / `git:status` / `git:apply-hunk` / `git:reject-hunk`
- **Accept hunk**：默认不执行写操作，仅将 hunk 标记为 accepted 并保留当前工作区改动；v0.3 不自动 commit
- **Reject hunk**：对指定 hunk 使用反向 patch（`git apply -R`）还原；整文件拒绝才使用 `git restore --source=HEAD -- {file}`
- **性能**：单文件 > 5000 行 diff 时仅显示摘要 + "查看完整 diff" 按钮（避免 Shiki 卡顿）
- **作用域**：当前任务的 `repo_root`

##### 终端标签页（Cmd+4，v0.3+）

交互式 Shell，独立于 Actor PTY：

- **Shell PTY**：点击标签页时在当前任务的 `repo_root` 下创建交互式 Shell（zsh/bash）
- **xterm.js** + `xterm-addon-fit` 渲染，接受键盘输入
- **交互**：用户可自由输入命令、执行 git 操作、查看文件等
- **与 Actor PTY 独立**：终端标签页的 Shell 与 Runner 管理的 Actor PTY 完全独立，互不影响
- **切换任务**：销毁旧 Shell PTY，在新 `repo_root` 下创建新 Shell
- **作用域**：每任务独立

### 6.4 模态弹窗

- 新建任务弹窗：任务名、说明（Markdown textarea）、工作目录、自动轮次、倒计时、执行方/Reviewer、seed session ID
- 全局设置弹窗：CLI 配置 tab + 协作参数 tab
- 帮助 overlay：理念 / 如何运作 / 核心特性 / 架构 / 注意事项 5 个 tab
- 诊断面板（v0.2+）：launcher 可用性、版本、工作目录、磁盘空间检查
- Computer Use 确认弹窗（v0.4+）：操作类型、目标应用、操作内容预览、批准/拒绝

### 6.5 色彩体系（延续 buddy-python Starbucks 风格）

| 用途 | 色值 |
|------|------|
| 页面画布 | `#f2f0eb` |
| 顶部/运行条 | `#1E3932` |
| 主绿色 / CTA | `#00754A` |
| 标题绿 | `#006241` |
| 卡片背景 | `#ffffff`，圆角 8-12px，轻阴影 |
| 主文字 | `rgba(0,0,0,0.87)` |
| 次要文字 | `rgba(0,0,0,0.58)` |
| 危险 | `#c82014` |
| 金色 / 警告 | `#cba258` |
| Sidebar 深色背景 | `#1E3932` |

## 7. Runner 调度

### 7.1 Prompt 构造

等价移植 buddy-python `prompts.py` 的 `build_actor_prompt()`：

1. Actor 标识
2. Buddy Message Protocol 说明
3. 任务目标（task.md）
4. 背景信息（按 context_hash + context_sent 条件附带）
5. Break 确认（pending_break 存在时）
6. 用户消息
7. 运行时设置（轮次、剩余、下一 actor）
8. 近期 transcript（最近 6 条 + 每角色补 1 条更早的）
9. 角色指令
10. 语言检测（CJK > 10% → 中文，否则 English）

### 7.2 Buddy Message Protocol

Actor 输出格式：

```json
{"type": "chat", "content": "..."}
{"type": "break", "content": "..."}
```

解析等价移植 `parse_buddy_message()`：fenced JSON、raw JSON、malformed JSON 提取、嵌入式 JSON、兜底为 `type=chat`。

### 7.3 双确认结束

一方 `type=break` → 暂存 `pending_break` → 另一方也 `type=break` → DONE。另一方若 `type=chat` → 撤回 break。

### 7.4 Session 复用

1. `state.json` 里的 ID 优先
2. 为空时使用 `settings.json` 的 seed ID
3. 仍为空时新会话
4. 新 ID 捕获后立即写入 `state.json`
5. 不使用 `--last`

### 7.5 自动轮次窗口与连续失败

- 自动推进窗口默认 10 轮，达到后 `PAUSED`
- 用户继续时重置 `rounds_in_window`
- 连续失败 3 次后 `PAUSED`，成功后重置计数

### 7.6 权限提示检测

实时监控 Actor 输出，匹配关键词后立即终止。spawn 管道方案监控 stderr/stdout；PTY 方案监控合并后的 PTY 输出：
- 英文：`requires permission`, `allow this action`, `approval required`, `do you want to proceed`, `do you want to allow`, `needs your approval`, `requires approval`
- 中文：`请授权`, `需要授权`, `需要确认`, `需要允许`

### 7.7 倒计时

- 后端驱动，state 中保存 `deadline`
- 前端计算 `deadline - now` 显示
- 应用重启后从 `state.json` 恢复
- 5 分钟宽限期外的过期倒计时直接进入 `PAUSED`
- 最后 10 秒弹出覆盖层
- 新建任务后 5 秒自动开始倒计时

## 8. Launchers

### 8.1 能力探测与降级

启动时和定期（如设置变更后）调用 `system:diagnose`：

| 检查项 | 方法 | 失败处理 |
|--------|------|---------|
| Launcher 可执行性 | `which {cmd}` | 在运行状态标签页显示警告，禁用对应 actor |
| Claude 版本和参数 | `{cmd} --help` 字符串匹配 | 见下表「能力降级」 |
| Codex 版本和参数 | `{cmd} exec --help` 字符串匹配 | 同上 |
| 工作目录可写 | `fs.access(W_OK)` | 阻止启动 |
| 数据目录磁盘空间 | `fs.statfs` | 低于 100MB 时警告 |

#### 最低版本与能力降级

| Actor | 最低参数要求 | 降级策略 |
|-------|------------|---------|
| Claude | `-p`, `--output-format stream-json`, `--input-format text`, `--resume` | 缺 `--resume` 时禁用 session 复用，每轮新建会话 |
| Codex | `exec`, `--json`, `-C`, `-o`, `exec resume` | 缺 `exec resume` 时禁用 session 复用 |
| OpenCode | `run`, `--format json`, `--session` | 缺 `--session` 时禁用 session 复用 |
| Kimi | `--print`, `--output-format stream-json`, `--session` | 同上 |

诊断结果在运行状态标签页的「Launcher 状态」区域以绿勾/红叉显示，不可用时禁用对应 actor 的选择器。

### 8.2 原生命令适配

| Actor | 用户输入示例 | 实际调用 |
|-------|-------------|---------|
| Claude | `claude --dangerously-skip-permissions` | `{cmd} -p --output-format stream-json --verbose --input-format text [--resume SID]`，prompt 通过 stdin |
| Codex | `codex` | 新会话：`{cmd} exec --dangerously-bypass-approvals-and-sandbox --json --skip-git-repo-check -C REPO_ROOT -o OUTPUT_FILE -`；resume：`{cmd} exec --dangerously-bypass-approvals-and-sandbox --json --skip-git-repo-check -C REPO_ROOT -o OUTPUT_FILE resume SID -` |
| OpenCode | `opencode` | `{cmd} run --format json --dangerously-skip-permissions [--session SID] [PROMPT]` |
| Kimi | `kimi` | `{cmd} --print --output-format stream-json --input-format text [--session SID]`，prompt 通过 stdin |

权限模式、profile、sandbox 等参数主要由用户写入启动命令。例外：`allow_dangerous_flags=true` 时，原生 Codex adapter 会为非交互流程自动追加 `--dangerously-bypass-approvals-and-sandbox`；`allow_dangerous_flags=false` 时绝不追加，并阻止用户命令中已有危险参数——见 §10 安全模型。

### 8.3 自定义 Launcher 契约

非原生命令按契约追加参数与环境变量：

参数：`--actor`, `--mode`, `--repo-root`, `--task-dir`, `--run-id`, `--prompt-file`, `--output-file`, `--event-file`, `--session-id`

环境变量：`BUDDY_ACTOR`, `BUDDY_MODE`, `BUDDY_REPO_ROOT`, `BUDDY_TASK_DIR`, `BUDDY_RUN_ID`, `BUDDY_PROMPT_FILE`, `BUDDY_OUTPUT_FILE`, `BUDDY_EVENT_FILE`, `BUDDY_SESSION_ID`

### 8.4 打断顺序

1. SIGINT → 等 2s
2. SIGTERM → 等 2s
3. SIGKILL

若 Actor 进程使用 PTY，信号通过 `pty.kill(signal)` 发送；若使用 v0.1 默认的 `child_process.spawn` 管道方案，信号通过 `child.kill(signal)` 发送。打断期间状态为 `INTERRUPTING`，结束后 `PAUSED`。

## 9. IPC 通信

### 9.1 Channel 列表

#### 任务管理

| Channel | 方向 | Request | Response |
|---------|------|---------|----------|
| `tasks:list` | invoke | `{ workspace_key?: string }` | `{ tasks: TaskSummary[] }` |
| `tasks:create` | invoke | `CreateTaskRequest` | `{ task_id, workspace_key }` |
| `tasks:get` | invoke | `{ task_id, workspace_key }` | `{ state, settings, transcript[], events[] }` |
| `tasks:delete` | invoke | `{ task_id, workspace_key }` | `{ ok: true }` |
| `tasks:rename` | invoke | `{ task_id, workspace_key, new_name }` | `{ ok: true }` |
| `tasks:start` | invoke | `{ task_id, workspace_key, idempotency_key }` | `{ run_id }` |
| `tasks:message` | invoke | `{ task_id, workspace_key, content, next_actor?, idempotency_key }` | `{ ok: true }` |
| `tasks:skip-countdown` | invoke | `{ task_id, workspace_key, idempotency_key }` | `{ ok: true }` |
| `tasks:pause-countdown` | invoke | `{ task_id, workspace_key }` | `{ ok: true }` |
| `tasks:resume-countdown` | invoke | `{ task_id, workspace_key }` | `{ ok: true }` |
| `tasks:interrupt` | invoke | `{ task_id, workspace_key, idempotency_key }` | `{ ok: true }` |

`tasks:rename` 允许在任意状态下调用（仅修改 `task.md` 中的任务名，不影响运行状态）。

#### 事件订阅

| Channel | 方向 | Payload |
|---------|------|---------|
| `events:subscribe` | invoke | `{ task_id, workspace_key, since_seq: number }` → `{ subscription_id }` |
| `events:unsubscribe` | invoke | `{ subscription_id }` |
| `events:push` | M→R | `{ subscription_id, events: Event[] }` |

#### 右侧面板·终端标签页（v0.3+）

| Channel | 方向 | Payload |
|---------|------|---------|
| `terminal:create` | invoke | `{ task_id, workspace_key }` → `{ subscription_id }` |
| `terminal:destroy` | invoke | `{ subscription_id }` |
| `terminal:data` | M→R | `{ subscription_id, data: Uint8Array }` |
| `terminal:input` | R→M | `{ subscription_id, data: Uint8Array }` |
| `terminal:resize` | R→M | `{ subscription_id, cols: number, rows: number }` |

#### 右侧面板·文件标签页（v0.2+）

| Channel | 方向 | 说明 |
|---------|------|------|
| `fs:list-directory` | invoke | 列出目录，遵循 .gitignore |
| `fs:read-file-preview` | invoke | 只读文件预览 |

#### 右侧面板·审查标签页（v0.3+）

| Channel | 方向 | 说明 |
|---------|------|------|
| `git:diff` | invoke | 获取 diff |
| `git:status` | invoke | 获取文件状态 |
| `git:apply-hunk` | invoke | Accept hunk |
| `git:reject-hunk` | invoke | Reject hunk |

#### 设置 / 系统

| Channel | 方向 | 说明 |
|---------|------|------|
| `settings:get` | invoke | 读全局设置 |
| `settings:save` | invoke | 写全局设置 |
| `system:bootstrap` | invoke | 应用启动数据 |
| `system:pick-directory` | invoke | 原生目录选择 |
| `system:diagnose` | invoke | 运行诊断（含 launcher 探测） |
| `system:export-transcript` | invoke | 导出 Markdown |
| `computer-use:execute` | invoke | v0.4+ |
| `computer-use:confirm` | invoke | v0.4+ |

### 9.2 错误模型

所有 invoke channel 统一使用以下响应模型：

- **成功**：直接返回业务数据（如 `{ run_id }`、`{ task_id, workspace_key }`、`{ subscription_id }`）
- **失败**：抛出结构化错误（Electron IPC 通过 `ipcMain.handle` 的 reject 传递）

```typescript
// 成功：invoke 直接 resolve 业务数据
tasks:create → { task_id: string, workspace_key: string }
tasks:start  → { run_id: string }

// 失败：invoke reject 为结构化错误
{
  code: ErrorCode,
  message: string,
  details?: object
}
```

| ErrorCode | 含义 |
|-----------|------|
| `E_TASK_NOT_FOUND` | 任务不存在 |
| `E_TASK_BUSY` | 任务有正在运行的 actor，操作冲突 |
| `E_INVALID_STATE` | 当前状态不允许该操作（如 DONE 状态调用 skip-countdown） |
| `E_LAUNCHER_NOT_FOUND` | launcher 命令不可执行 |
| `E_LAUNCHER_FAILED` | launcher 启动失败 |
| `E_FILE_LOCKED` | 文件被另一进程占用 |
| `E_SCHEMA_VERSION` | 数据 schema 版本不兼容 |
| `E_PERMISSION_DENIED` | macOS 权限不足（如 Computer Use 需要 Accessibility 权限） |
| `E_INVALID_INPUT` | 请求参数校验失败（Zod） |
| `E_INTERNAL` | 主进程内部异常 |

### 9.3 幂等性与并发

- **可幂等**（带 `idempotency_key`）：`tasks:start`, `tasks:message`, `tasks:skip-countdown`, `tasks:interrupt`
  - 主进程缓存最近 100 个 `idempotency_key` → 结果，5 分钟过期
  - 重复调用直接返回缓存结果，不产生副作用
- **顺序保证**：
  - 同一任务的事件 `seq` 严格递增
  - `events:push` 推送顺序与写入顺序一致
  - 渲染进程订阅时携带 `since_seq`，主进程补发缺失的事件后再开始增量推送
  - 主进程在内存中保留每个任务最近 2000 条事件用于 `since_seq` 补发；超出时从 `events.jsonl` 文件回放读取
- **取消语义**：
  - `tasks:interrupt` 是异步操作，立即返回；真正完成时通过 `actor.interrupted` event 通知
  - 渲染进程不应在 invoke 返回后立即假设状态已切换，必须依赖 events 推送

### 9.4 Race Condition 处理

| 场景 | 处理 |
|------|------|
| 同时收到 `tasks:start` 和 `tasks:interrupt` | 任务级锁串行化；后到的请求若发现状态已变，返回 `E_INVALID_STATE` |
| 倒计时到期 vs 用户跳过 | 任务级锁串行化；后到的请求成为 no-op |
| 多个渲染进程订阅同一任务 | 各自独立 subscription_id，互不影响 |
| 主进程重启时有正在运行的 actor | Actor 子进程已脱离主进程管理，标记 `active_run` 为 `interrupted`，清理陈旧运行锁，进入 `PAUSED` |

## 10. 安全模型

### 10.1 威胁模型

Buddy 是本地工具，不暴露远程接口。主要威胁面：
1. Actor 子进程在用户工作目录里执行任意命令（已默认绕过权限的设计选择）
2. Computer Use 控制其他 macOS 应用
3. Session ID、API key 等敏感信息可能泄露到日志或事件流
4. 数据目录可能被其他进程篡改

### 10.2 权限边界

#### Actor 子进程

- **工作目录约束**（非沙箱）：子进程 `cwd` 设为任务 `state.repo_root`。注意：这不是安全边界——Actor 仍可读写用户目录任意文件、访问网络、读取密钥文件。该约束仅确保 Actor 默认在正确的项目目录下工作。真正的安全边界依赖 §10.2 的 `allow_dangerous_flags` 和 Actor CLI 自身的权限模式
- **环境变量隔离**：launcher `env` 字段中的变量与主进程 env 合并，不继承敏感系统变量（如 `SSH_AUTH_SOCK` 默认透传，`AWS_*` 等可在设置中配置黑名单）
- **危险参数开关**（`allow_dangerous_flags`，全局设置中可控）：
  - **默认 `true`**：保留 buddy-python 当前行为，启动命令默认填充 `claude --dangerously-skip-permissions`，Codex 实际调用追加 `--dangerously-bypass-approvals-and-sandbox`；非交互流畅，但 actor 可在工作目录里执行任意命令
  - **关闭时（`false`）**：
    - Claude 默认填充改为 `claude`（无 `--dangerously-*`）；用户**不可**手动添加 `--dangerously-*` 或 `bypassPermissions`
    - Codex 实际调用去掉 `--dangerously-bypass-approvals-and-sandbox`
    - 启动前扫描用户输入的命令字符串，若仍含 `dangerously` / `skip-permissions` / `bypass-approvals` / `bypassPermissions` 等关键词，弹窗提示「该任务设置禁止使用危险参数，请修改启动命令」并阻止启动
    - 由于 launcher 走非交互模式，此时遇到权限提示会被 §7.6 的检测逻辑拦截并终止
  - **开关位置**：全局设置 → CLI 配置 tab 顶部，独立卡片，含红色警告图标和说明文字
  - **任务级覆盖**：每个任务 `settings.json` 可覆盖全局值（字段同名 `allow_dangerous_flags`），新建任务弹窗中默认继承全局值
  - **审计**：每次启动 actor 时，事件 `actor.started` 的 payload 记录 `dangerous_flags_active: boolean`，便于事后审计哪一轮使用了危险参数
- **危险参数 UI 提示**（不论开关状态）：
  - 新建任务和全局设置弹窗中，包含 `dangerously` 关键词的命令以黄色警告徽章显示
  - 帮助 overlay 的「注意事项」tab 详细说明这些参数的含义和风险

#### Computer Use（v0.4+）

- **默认关闭**：每个任务的 `settings.json` 中 `computer_use_enabled: false`
- **逐次确认**：每个操作弹窗预览（动作类型、目标应用、参数），用户必须显式批准
- **不允许"自动批准"配置**：v0.4 不提供自动批准选项；后续版本若加入，必须限定到具体应用白名单 + 操作白名单
- **应用白名单**：只能控制用户预先添加到白名单的应用
- **超时**：单次操作 30 秒超时
- **macOS Accessibility 权限**：首次使用时引导用户在系统设置中授予；权限缺失时禁用 Computer Use

### 10.3 敏感信息脱敏

- **脱敏原则**：API key、访问令牌、环境变量密钥等高敏信息写入持久化文件前必须脱敏。`events.jsonl`、`artifacts/{run_id}-events.jsonl` 写入前统一扫描脱敏，不保留这些高敏信息的原始字节
- **Session ID 与 thread ID**：属于运行状态数据，在 `state.json`、events、transcript、artifacts 中保留完整值（用于 session 复用）；在日志和 UI 中以 `xxxx****` 形式显示前 4 位
- **API key 检测**：写入前用正则扫描常见 API key 格式（OpenAI `sk-...`、Anthropic `sk-ant-...`、AWS `AKIA...`），命中后替换为 `[REDACTED]` 并在事件 meta 中标记 `redacted: true`
- **环境变量**：launcher `env` 字段中以 `_KEY`、`_TOKEN` 结尾的键，UI 显示和日志中脱敏
- **导出与诊断**：UI 导出、诊断包、日志均不含未脱敏的 API key

### 10.4 审计与日志

- **危险操作审计**：所有 `actor.failed`、`permission.detected`、`computer-use.execute`、launcher 启动事件追加到 events.jsonl，永不删除
- **日志保留**：`runtime/buddy.log` 滚动保留最近 7 天；崩溃日志另外保留 30 天
- **数据目录变更通知**：不监听其他进程的写入，但启动时校验 `state.json` 与 `events.jsonl` 末尾事件一致性，不一致时提示用户

### 10.5 Electron 安全配置

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`（渲染进程）
- preload 只暴露 IPC bridge，不直接暴露 fs / child_process
- `webSecurity: true`，不打开外部 URL（除帮助文档明确指向）
- 不使用 `<webview>` 或 `BrowserView` 加载第三方内容

## 11. macOS 特性

### 11.1 原生集成

- 应用菜单：关于、偏好设置、退出
- 编辑菜单、视图菜单（切换 Sidebar / 右侧面板标签页 Cmd+1/2/3/4）、窗口菜单
- Dock 图标 badge：运行中显示圆点
- macOS 通知：actor 完成、任务 DONE、FAILED 时（用户可关闭）
- 目录选择器：`dialog.showOpenDialog`
- 自动启动（v0.5+）：`app.setLoginItemSettings`

### 11.2 窗口与托盘（v0.3+）

- 记住窗口位置、大小
- 关闭窗口最小化到托盘，后台任务继续运行
- 托盘菜单：显示/隐藏窗口、当前任务状态、退出
- 快捷键：Cmd+N 新建任务、Cmd+W 隐藏窗口、Cmd+, 设置、Cmd+Enter 发送、Cmd+1/2/3/4 切换右侧面板标签页

### 11.3 终端标签页（v0.3+）

参见 §6.3 终端标签页。技术要点：

- `node-pty` 主进程创建独立 Shell PTY（与 Actor PTY 完全独立）
- xterm.js + xterm-addon-fit 渲染进程渲染，接受键盘输入
- 主进程通过 `terminal:data` IPC 推送 PTY 输出到渲染进程
- 渲染进程通过 `terminal:input` IPC 发送用户键盘输入到主进程
- 渲染进程通过 `terminal:resize` IPC 通知主进程 PTY 尺寸变化
- 切换任务时销毁旧 Shell PTY，在新 `repo_root` 下创建新 Shell

### 11.4 审查标签页（v0.3+）

参见 §6.3 审查标签页。技术要点：

- 主进程封装 `simple-git`，对外暴露 `git:diff` / `git:status` / `git:apply-hunk` / `git:reject-hunk` IPC channel
- diff 解析采用 `parse-diff` 或 `diff` 包，按 hunk 拆分
- Accept hunk：默认不执行写操作，仅将 hunk 标记为 accepted 并保留当前工作区改动；v0.3 不自动 commit
- Reject hunk：对指定 hunk 使用反向 patch（`git apply -R`）还原；整文件拒绝才使用 `git restore --source=HEAD -- {file}`
- 性能：单文件 > 5000 行 diff 时仅显示摘要 + "查看完整 diff" 按钮（避免 Shiki 卡顿）

### 11.5 文件标签页（v0.2+）

参见 §6.3 文件标签页。技术要点：

- 主进程暴露 `fs:list-directory` / `fs:read-file-preview` IPC，限定路径必须在 `repo_root` 下
- 遵循 `.gitignore`：使用 `ignore` 包解析
- 文件预览限制：< 1MB 文本直接读，二进制显示占位，图片用 `<img>` 加载本地文件协议（沙箱中需配置 `protocol.registerFileProtocol`）

### 11.6 Computer Use（v0.4+）

- 通过 macOS Accessibility API + AppleScript 实现
- 操作：截屏、点击、键盘输入、读取 UI 元素
- 安全控制：见 §10.2

### 11.7 对话导出（v0.2+）

- 导出 transcript 为 Markdown（含任务名、时间、role、session ID）
- 入口：右侧面板·运行状态标签页的任务设置区 + 右键菜单
- `dialog.showSaveDialog` 保存

### 11.8 诊断页（v0.2+）

- 入口：帮助 overlay 的诊断 tab、设置中的诊断按钮
- 与 §8.1 launcher 能力探测共用底层 `system:diagnose`
- 一键修复建议（如未配置 launcher 时跳到设置页）

## 12. 项目结构

```
buddy/
├── electron.vite.config.ts
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── tsconfig.web.json
├── tailwind.config.ts
├── postcss.config.js
├── resources/
│   └── icon.icns
├── src/
│   ├── shared/                       # 主进程与渲染进程共享类型
│   │   ├── ipc.ts                    # IPC channel 名称 + 类型定义
│   │   ├── models.ts                 # 状态、actor、event 类型
│   │   └── schemas.ts                # Zod schema
│   ├── main/
│   │   ├── index.ts
│   │   ├── ipc.ts                    # IPC handler 注册
│   │   ├── window.ts
│   │   ├── menu.ts
│   │   ├── tray.ts                   # v0.3+
│   │   ├── store.ts                  # 文件读写 + 锁
│   │   ├── runner.ts                 # 状态机 + 调度
│   │   ├── launchers.ts              # spawn/PTY + 命令适配
│   │   ├── prompts.ts
│   │   ├── parsers.ts                # Claude/Codex JSON stream 解析
│   │   ├── diagnose.ts               # 能力探测
│   │   ├── events.ts                 # 事件总线
│   │   ├── terminal.ts               # v0.3+ Shell PTY 管理（独立于 Actor PTY）
│   │   ├── git.ts                    # v0.3+ simple-git 封装、diff/apply/reject
│   │   ├── files.ts                  # v0.2+ 文件树读取、gitignore 过滤、预览
│   │   └── redact.ts                 # 敏感信息脱敏
│   ├── preload/
│   │   └── index.ts
│   └── renderer/
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── stores/
│       │   ├── task.ts
│       │   ├── ui.ts
│       │   └── settings.ts
│       ├── components/
│       │   ├── layout/
│       │   │   ├── AppShell.tsx
│       │   │   ├── Sidebar.tsx
│       │   │   ├── ChatPanel.tsx
│       │   │   └── RightPanel.tsx            # 右侧面板 + 标签页切换
│       │   ├── chat/
│       │   │   ├── Transcript.tsx
│       │   │   ├── MessageBubble.tsx
│       │   │   ├── Composer.tsx
│       │   │   └── StreamingIndicator.tsx
│       │   ├── task/
│       │   │   ├── TaskCard.tsx
│       │   │   ├── NewTaskModal.tsx
│       │   │   └── TaskSettings.tsx
│       │   ├── right-panel/                   # 右侧面板标签页
│       │   │   ├── StatusTab.tsx              # 运行状态（Codex App 风格漂浮卡）
│       │   │   ├── StatusFloatingCard.tsx
│       │   │   ├── ProgressList.tsx
│       │   │   ├── OutputSection.tsx
│       │   │   ├── SourceSection.tsx
│       │   │   ├── EventLog.tsx               # 漂浮卡内可折叠
│       │   │   ├── LauncherStatus.tsx         # 漂浮卡内紧凑状态行
│       │   │   ├── FilesTab.tsx               # v0.2+ 文件浏览
│       │   │   ├── FileTree.tsx               # v0.2+
│       │   │   ├── FilePreview.tsx            # v0.2+
│       │   │   ├── ReviewTab.tsx              # v0.3+ 代码审查
│       │   │   ├── ChangedFilesList.tsx       # v0.3+
│       │   │   ├── DiffViewer.tsx             # v0.3+ Shiki 高亮 + Accept/Reject
│       │   │   ├── TerminalTab.tsx            # v0.3+ 交互式终端
│       │   │   └── XtermView.tsx              # v0.3+ xterm.js 包装
│       │   ├── computer-use/                 # v0.4+
│       │   │   ├── ComputerUseConfirm.tsx
│       │   │   └── ComputerUseOverlay.tsx
│       │   ├── modals/
│       │   │   ├── GlobalSettingsModal.tsx
│       │   │   ├── HelpOverlay.tsx
│       │   │   └── DiagnosticsPanel.tsx    # v0.2+
│       │   └── common/
│       │       ├── PillButton.tsx
│       │       ├── StatusPill.tsx
│       │       └── CountdownOverlay.tsx
│       └── styles/
│           └── globals.css
├── tests/
│   ├── main/
│   │   ├── store.test.ts
│   │   ├── runner.test.ts
│   │   ├── launchers.test.ts
│   │   ├── parsers.test.ts
│   │   ├── prompts.test.ts
│   │   └── redact.test.ts
│   └── renderer/
│       └── components/
└── .github/
    └── workflows/
        └── build.yml
```

## 13. 非功能需求

### 13.1 可靠性

- 应用重启、主进程崩溃或窗口关闭后，任务状态必须能从持久化文件恢复到最近一次稳定状态。
- Actor 子进程运行中发生主进程崩溃时，重启后任务进入 `PAUSED`，并记录 active run 被中断；不得自动假设子进程成功。
- JSONL 末尾损坏行必须被忽略，不能阻止其余 transcript / events 展示。
- `state.json`、`settings.json`、`status` 覆盖写必须原子化，不能出现半写入文件被正常读取。
- 同一任务在同一进程内不得并发启动两个 actor；跨进程运行互斥按 §5.5 处理。

### 13.2 性能

| 场景 | 目标 |
|------|------|
| 冷启动到主窗口可交互 | 2 秒内（不含首次 launcher 诊断） |
| 任务列表加载 | 100 个任务内 1 秒内完成摘要展示 |
| 打开单个任务 | transcript 5000 行内 1 秒内完成首屏展示 |
| 事件增量推送 | actor stream 到 UI 展示延迟 P95 < 300ms |
| 倒计时显示 | 前端计时误差 < 500ms，最终动作以主进程 deadline 为准 |
| 文件预览 | < 1MB 文本 500ms 内展示 |
| 大 diff | 单文件 > 5000 行 diff 不做完整高亮，避免 UI 长时间阻塞 |

### 13.3 可用性

- 用户在任意任务状态下都能看清：当前状态、下一 actor、最近错误、是否自动推进、是否有外部占用。
- 所有会触发 actor 运行的入口都必须显示当前 repo_root 和 actor 名称。
- 失败态必须提供下一步：重试、修改设置、查看诊断或暂停。
- 倒计时最后 10 秒必须有明显提示和取消自动开始入口。
- v0.1 中未实现的文件 / 审查 / 终端标签页必须置灰并说明对应版本，不能显示空白可点击界面。
- 键盘快捷键不得在 Composer 正在输入文本时误触发标签页切换或任务操作。

### 13.4 安全与隐私

- 渲染进程不能直接访问 fs、child_process 或任意 Node API；所有本地能力通过 preload 暴露的受限 IPC 调用。
- 任何写入日志、events、artifacts 的高敏 token 都必须先经过脱敏。
- Session ID / thread ID 作为恢复所需状态可完整持久化，但 UI 与日志默认显示脱敏版本。
- `allow_dangerous_flags=false` 时，应用必须阻止用户配置中的危险参数，而不只是显示警告。
- Computer Use 每次操作都必须人工确认；v0.4 不提供自动批准。
- 文件标签页、终端标签页和审查标签页必须限定在当前任务 `repo_root` 语义下，不允许通过 IPC 任意读取系统路径。

### 13.5 可维护性

- 主进程、预加载、渲染进程的类型边界必须共享 `src/shared` 中的 IPC 与模型定义。
- 所有 IPC request 和持久化文件读取必须经过 Zod 或等价 schema 校验。
- 状态机新增转移时必须同步更新 §4.2 状态转移表、runner 测试和事件类型。
- buddy-python 兼容字段不得随意改名；新增字段必须可被旧版忽略。
- 与真实 CLI 相关的解析器必须有 fixture 测试，避免依赖一次性 smoke test。

### 13.6 可访问性与本地化

- v0.1 主要界面语言为中文；Actor 输出按原文展示，不自动翻译。
- 交互控件需要有可读 label / tooltip，尤其是状态图标、危险参数警告、标签页置灰原因。
- 颜色不能作为唯一状态表达；状态 pill、错误消息和 tooltip 需要补充文字。
- 关键操作按钮（启动、继续、打断、跳过倒计时、暂停）需要可通过键盘访问。

## 14. 产品验收矩阵

### 14.1 v0.1 MVP 总体验收

| 编号 | 验收项 | 验收方式 |
|------|--------|----------|
| A1 | 全新安装后可配置 Claude/Codex launcher 并创建任务 | 手工 smoke test |
| A2 | 真实 repo 中可完成 Claude → Codex → Claude/Codex 双确认 DONE | 真实 CLI smoke test |
| A3 | 任务状态、transcript、events、artifacts 按 schema 写入数据目录 | 文件检查 + 单元测试 |
| A4 | buddy-python 创建的任务可在 macOS 打开并继续 | golden fixture |
| A5 | macOS 创建的任务可由 buddy-python 读取并推进一轮 | golden fixture |
| A6 | Actor 失败、权限提示、打断、连续失败上限都有明确 UI 状态 | runner 测试 + 手工验证 |
| A7 | 应用重启后 READY/COUNTDOWN/FAILED/PAUSED/DONE 均能恢复 | 集成测试 |
| A8 | DMG 可安装并启动，不要求签名公证 | 打包测试 |

### 14.2 功能验收覆盖

| 模块 | v0.1 必验 | 后续版本必验 |
|------|-----------|--------------|
| 任务管理 | 创建、读取、重命名、删除、切换 workspace | 多窗口仍不支持，后台托盘状态保持一致 |
| Runner | 状态转移表全覆盖、倒计时、break 双确认、失败暂停 | OpenCode/Kimi 接入后同一状态机复用 |
| Launchers | Claude/Codex 参数适配、session/thread 捕获、权限提示检测 | OpenCode/Kimi 参数适配和能力降级 |
| UI | 三栏布局、运行状态标签页、Composer、事件订阅 | 文件/审查/终端标签页可用 |
| 数据兼容 | schema v1、JSONL 容错、锁策略 | schema 迁移页和备份回滚 |
| 安全 | 脱敏、危险参数开关、Electron 安全配置 | Computer Use 白名单和逐次确认 |
| 分发 | DMG 输出 | 签名、公证、自动更新 |

### 14.3 回归测试基线

- 每次修改状态机：运行 runner 状态转移测试、倒计时恢复测试、break 双确认测试。
- 每次修改 schema：运行 buddy-python ↔ macOS golden fixture。
- 每次修改 launcher：运行对应 CLI fixture parser 测试和至少一次真实 smoke test。
- 每次修改 IPC：运行 preload 暴露面测试和 Zod 校验失败路径测试。
- 每次修改 UI 布局：验证 1280、1440、1600、1680 宽度下无遮挡、置灰标签状态正确。

## 15. 风险与开放问题

### 15.1 已知风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| PTY 统一承载 Actor 输出可能破坏 JSON stream | 真实 launcher 无法稳定解析 | Phase 0.5 spike；未通过则 v0.1 使用 spawn 管道 |
| buddy-python 暂未写运行锁 | 两端可能同时运行同一任务 | macOS 降级检测 + 启动确认；后续同步 buddy-python |
| 危险参数默认开启 | Actor 可执行高权限本地操作 | 明确 UI 警告、任务级开关、事件审计 |
| 真实 CLI 输出格式变化 | parser 失效，任务进入 FAILED | fixture 覆盖、诊断页展示 CLI 版本、解析失败保留 artifacts |
| 大 transcript / diff 造成 UI 卡顿 | 长任务体验下降 | 增量加载、虚拟列表、大 diff 降级摘要 |
| Electron 文件协议暴露本地资源 | 文件预览存在越权风险 | 自定义协议校验 repo_root，禁止任意 file URL |
| Computer Use 权限过强 | 可误操作其他应用 | 默认关闭、白名单、逐次确认、审计日志 |

### 15.2 开放问题

| 问题 | 需要决策时间 | 当前默认 |
|------|--------------|----------|
| PTY spike 是否通过 | Phase 0.5 结束 | 未通过前使用 spawn 管道 |
| buddy-python 是否同步运行锁格式 | v0.1 兼容测试前 | macOS 先实现运行锁与降级检测 |
| Review 标签页 Accept 是否只保留工作区改动，还是支持 stage | v0.3 设计前 | v0.3 默认只修改工作区，不自动 commit |
| 自动更新渠道使用 GitHub Releases 还是自托管 | v0.5 前 | GitHub Releases |
| Computer Use 是否允许读取 UI 元素文本 | v0.4 设计前 | 仅在白名单应用 + 单次确认后允许 |
| 是否支持英文 UI | v0.2 前 | v0.1 中文 UI，后续评估 i18n |

## 16. 分期实施计划

### Phase 0：脚手架（1-2 天）

- 初始化 Electron + electron-vite + React 19 + TypeScript + Tailwind 4
- 配置 eslint、prettier、vitest
- 主/预加载/渲染进程能各自构建并打包通过
- IPC bridge 跑通一个 ping/pong demo

**验收**（每条都可执行）：
- `pnpm install && pnpm dev` 能启动空白窗口
- `pnpm test` 跑通 ping/pong IPC 测试
- `pnpm build` 输出可启动的 .app

### Phase 0.5：PTY Spike（1-2 天）

验证 §3.3 方案 B（PTY）是否可行：

- Claude `stream-json` 模式：PTY 启动 → stdin 写入 prompt + `\x04`（Ctrl+D）→ 成功解析完整 JSON stream → 捕获 session_id → 无 ANSI 残留干扰
- Codex `--json` 模式：PTY 启动 → stdin 写入 prompt + EOF → 成功解析完整 JSON stream → 捕获 thread_id
- stderr 权限提示关键词检测（PTY 合并 stdout/stderr 下的检测策略）
- 记录 PTY 输出中的 ANSI 转义码样本，评估清洗成本

**Spike 结果决定**：
- 通过 → Phase 4 使用 PTY 方案
- 未通过 → Phase 4 使用 spawn 管道方案（与 buddy-python 一致），终端标签页使用独立 Shell PTY

### Phase 1：持久层（2-3 天）

- shared/models.ts、shared/schemas.ts（Zod）
- main/store.ts：workspace 创建、任务 CRUD、原子写、文件锁、JSONL 追加、损坏行跳过
- main/redact.ts：API key 检测与脱敏
- 单元测试：store CRUD、原子写崩溃恢复、文件锁互斥、JSONL 损坏行处理

**验收**：
- `pnpm test src/main/store.test.ts` 全部通过
- 在 Node REPL 中能创建 workspace + task，文件出现在 `~/Library/Application Support/buddy/workspaces/...`

**兼容性 Golden Fixture**（由 buddy-python 生成 → macOS 读取；由 macOS 生成 → buddy-python 读取）：
- buddy-python 创建任务 → macOS 读取 state.json/settings.json，字段值完全一致
- macOS 创建任务 → buddy-python 读取并推进一轮，无报错
- macOS 写入损坏 JSONL 行 → 读取时跳过损坏行，正常返回其余行
- macOS 读取 buddy-python 设置的倒计时 deadline → 正确恢复倒计时
- buddy-python 设置 pending_break → macOS 读取并正确展示 break 状态

### Phase 2：状态机 + Runner 骨架（3-5 天）

- main/runner.ts：状态转移、倒计时、round window、consecutive failure
- main/prompts.ts：prompt 构造 + 语言检测
- main/launchers.ts：FakeLauncher（用 spawn echo 模拟；PTY spike 单独覆盖）
- 单元测试覆盖 §4.2 状态转移表全部转移

**验收**：
- `pnpm test src/main/runner.test.ts` 覆盖所有状态转移
- 用 FakeLauncher 跑通 READY → RUNNING → COUNTDOWN → RUNNING → DONE 的完整流程
- 倒计时 deadline 准确，应用重启后能恢复倒计时

### Phase 3：UI 接通（5-7 天）

- 三栏布局（Sidebar + Chat + RightPanel） + 响应式折叠
- 右侧面板标签页切换（Cmd+1/2/3/4），v0.1 仅"运行状态"标签页可用，其余标签页按钮置灰提示版本
- Sidebar 任务列表、新建任务弹窗、全局设置弹窗
- Chat：transcript 渲染、Composer、流式输出、状态 pill
- 运行状态标签页：Codex App 风格漂浮卡，包含进度列表、输出摘要、来源信息、倒计时行、Launcher 状态和可折叠事件日志
- IPC 全部接通，事件订阅推送
- 渲染进程订阅 events、subscribe `since_seq` 补发逻辑

**验收**：
- 浏览器（DevTools）操作流程：创建任务 → 启动（FakeLauncher）→ 看到 transcript 增长 → 倒计时显示 → 跳过 → 继续推进
- 关闭窗口重开，状态、对话、倒计时全部恢复
- 主进程重启，渲染进程通过 `since_seq` 拿回缺失事件
- 文件/审查/终端标签页置灰且 tooltip 标注预计版本

### Phase 4：真实 Launcher 接入（5-7 天）

- main/launchers.ts：Claude/Codex 两个原生命令的 spawn（v0.1 仅此两个；OpenCode/Kimi 接口预留但不实现）
- main/parsers.ts：Claude stream-json、Codex --json 解析
- 流式输出、Session ID 捕获、Buddy Message Protocol 解析、双确认结束
- 打断顺序（SIGINT → SIGTERM → SIGKILL）
- 权限提示检测
- main/diagnose.ts：launcher 能力探测（v0.1 仅检测 Claude/Codex）
- 安全脱敏在 events 写入前应用

**验收**：
- 真实 smoke test：用 Claude + Codex 跑 `/tmp/buddy-smoke` 项目下的简单任务，DONE 退出
- 打断 + 重新启动能恢复
- 诊断显示 Claude/Codex 两个 launcher 状态
- API key 在 events.jsonl 中已脱敏

### Phase 5：MVP 收尾（3-5 天）

- 错误态、空态、failure box
- macOS 菜单 + 快捷键
- 应用图标、Dock badge
- 倒计时覆盖层（最后 10 秒）
- 自动开始倒计时
- DMG 打包（不签名）
- README + 安装指引

**MVP 验收**：
- `pnpm dist` 输出 DMG
- 全新安装后能跑通：创建任务 → 启动 Claude → 倒计时 → Codex review → 双确认 DONE
- 杀进程后重启数据完整恢复

——以下是 v0.1 之后——

### Phase 6a：补完 OpenCode/Kimi + 文件标签页 + 导出（v0.2，4 天）

- launchers 加 OpenCode/Kimi 适配
- 诊断页 UI（在帮助 overlay 内）
- 对话导出 Markdown
- main/files.ts + components/right-panel/FilesTab.tsx：文件标签页（Cmd+2），见 §6.3 / §11.5

**验收**：
- Cmd+2 切换到文件标签页，显示当前任务 `repo_root` 的文件树（遵循 .gitignore）
- 点击文件能预览文本内容
- 切换任务时文件树刷新

### Phase 6b：终端标签页 + 审查标签页 + 托盘（v0.3，7 天）

- main/terminal.ts + components/right-panel/TerminalTab.tsx：终端标签页（Cmd+4），交互式 Shell，见 §6.3 / §11.3
- main/git.ts（simple-git）+ components/right-panel/ReviewTab.tsx + DiffViewer.tsx：审查标签页（Cmd+3），见 §6.3 / §11.4
- 系统托盘 + 后台运行
- macOS 通知

**验收**：
- Cmd+4 切换到终端标签页，能交互式输入命令；切换任务时在新 repo_root 下启动 Shell
- Cmd+3 切换到审查标签页，列出工作目录的 git 改动；逐个 hunk Accept/Reject 生效
- 右侧面板宽度持久化到 `panel_widths`，重启后恢复

### Phase 6c：Computer Use（v0.4，1-2 周）

- macOS Accessibility 权限引导
- 截屏 + 点击 + 输入实现
- 操作确认弹窗 + 应用白名单
- 操作日志与审计

### Phase 6d：分发（v0.5，3 天）

- Apple Developer ID 代码签名
- 公证（notarization）
- electron-updater 自动更新
- GitHub Actions CI（lint + test + build + sign + release）

## 17. 已确认决策

| 项目 | 决策 |
|------|------|
| 后端逻辑 | TypeScript 重写，不嵌入 buddy-python |
| UI 布局 | 三栏布局（Sidebar/Chat/RightPanel），右侧面板含四个标签页；运行状态标签页采用 Codex App 风格内嵌漂浮卡 |
| Actor 支持 | v0.1 仅 Claude/Codex，v0.2 补 OpenCode/Kimi |
| 目标平台 | macOS only |
| 系统托盘 | v0.3 需要，关闭窗口后常驻后台 |
| Review | v0.3 需要右侧面板审查标签页（Cmd+3），simple-git + DiffViewer + 按 hunk Accept/Reject |
| Terminal | v0.3 需要右侧面板终端标签页（Cmd+4），xterm.js + node-pty，交互式 Shell，独立于 Actor PTY |
| Files | v0.2 需要右侧面板文件标签页（Cmd+2），遵循 .gitignore |
| 进程模型 | v0.1 Actor 默认使用 spawn 管道（与 buddy-python 一致）；PTY spike 通过后可切换为统一 PTY，否则 PTY 仅用于 v0.3 终端标签页 |
| 多窗口 | 单窗口，sidebar 切换任务 |
| 诊断功能 | v0.2 UI 内诊断页 |
| Computer Use | v0.4，逐次确认，应用白名单 |
| 对话导出 | v0.2，Markdown |
| Approval mode | 不需要，延续 buddy-python 非交互 |
| Schema 版本 | `protocol_version: "1"`，与 buddy-python 兼容 |
| 互斥锁 | `.buddy.lock` 作为短生命周期写入锁；`runtime/tasks/{ws}__{task}.lock` 作为 actor 运行锁；buddy-python 未同步运行锁前按 §5.5 降级为只读/确认启动 |
| 敏感信息 | API key 写入前正则脱敏，session ID 在 UI 中显示前 4 位 |
