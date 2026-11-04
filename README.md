# Buddy

> Let's Go, Every Buddy! 让我们一起出发，每一位 Buddy！

双 AI Agent 协作编码的 macOS 桌面应用。两个 AI Actor（执行方 + 审查方）轮流工作，实现、审查并修正代码。你可以随时追加指令，任务在双方确认完成后结束。

官网：[https://davidhoo.github.io/buddy/](https://davidhoo.github.io/buddy/) · [下载](../../releases)

## 特性

- **双 Actor 协作**：执行方实现代码，审查方检查修正，循环推进直到双方确认完成
- **本机 Agent 管理**：发现 Claude Code、Codex、Cursor CLI、Antigravity CLI、OpenCode、Kimi Code、DeepSeek Harness（dsh）、WeCode 等本机工具。按 Agent 选择可用的 CLI 或 ACP 入口，查询模型，并为支持的安装方式执行后台更新
- **Skills 与 MCP**：发现并导入本机 Agent 的技能和 MCP 配置，按 Agent 分配。支持手动添加 MCP 和检测同名配置冲突
- **双确认结束**：双方均发出 `type=break` 才结束任务，单方 break 不终止
- **指令队列**：在 Actor 运行期间排队发送指令，轮次结束后自动执行
- **Git 集成**：本地化 conventional commit 消息生成、变更查看、提交与推送
- **23 套预设主题**：CSS 自定义属性驱动的主题引擎，支持自定义颜色
- **国际化**：中文简体 / 中文繁体 / 英文，CJK 自动检测
- **可恢复**：应用崩溃或重启后，任务状态从磁盘文件完整恢复

## 官网

Buddy 官网使用 GitHub Pages 部署，源码在 [`docs/`](docs/) 目录，包含：

- **首页**（`index.html`）：产品介绍、核心特性、工作原理、架构设计、支持的 AI Actor、下载、FAQ
- **最佳实践**（`best-practices.html`）：任务说明模板、推荐用法、避坑指南

推送 `docs/` 目录的变更到 `main` 分支会自动触发 GitHub Actions 部署（见 [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)）。

## 系统要求

- **GitHub 最新发行版 v2.0.13**：macOS 12（Monterey）或更高版本，提供 Apple Silicon 和 Intel 安装包。
- **当前源码**：Electron 45.2.2，运行需要 macOS 13（Ventura）或更高版本。
- 安装并登录所需的本机 Agent，例如 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex CLI](https://github.com/openai/codex)、[Cursor CLI](https://docs.cursor.com/en/cli/overview)、[OpenCode](https://github.com/opencode-ai/opencode)、[Kimi Code](https://github.com/MoonshotAI/kimi-cli)、DeepSeek Harness（`dsh`）

## 安装

### GitHub Releases（推荐）

从 [Releases](../../releases) 页面按芯片下载 DMG（Apple Silicon 选带 arm64 后缀的文件，Intel 选无架构后缀的 DMG），打开后将 Buddy 拖入 Applications 文件夹。

首次使用时，在 Buddy 的 Agent 设置中确认已发现的工具和可用入口。新建任务时选择 Git 仓库，分别为执行方和审查方选择 Agent 及可用模型，再填写任务目标和验收标准。

或从源码构建：

```bash
pnpm install
pnpm dist
```

DMG 输出在 `release/` 目录。

## 开发

```bash
pnpm install          # 安装依赖
pnpm dev              # 开发模式（HMR）
pnpm build            # 编译 main/preload/renderer
pnpm test             # 单元测试 (vitest)
pnpm test:e2e         # E2E 测试 (Playwright)
pnpm typecheck        # 类型检查
pnpm dist             # 构建本地 ad hoc DMG / ZIP
pnpm release:signed   # 构建并验证 Apple Development 签名（需 CSC_NAME）
```

官方发行包使用 Apple Development 签名，发布流程见 [发布指南](docs/RELEASE.md)。

## 架构

三进程 Electron 架构（main / preload / renderer），基于 electron-vite 构建。

```
┌──────────────────────────────────────────────┐
│               Main Process                    │
│  BuddyCoreService                             │
│  ├── BuddyStore    (原子写入持久层)            │
│  ├── BuddyRunner   (状态机 + 子进程调度)       │
│  └── BuddyEventBus (事件发布/订阅)            │
│                                               │
│  Launchers → Claude / Codex / Cursor /        │
│              OpenCode / Kimi / dsh            │
│  Git Integration → diff / status / commit     │
└──────────────────┬───────────────────────────┘
                   │ IPC (buddy:* channels)
┌──────────────────┴───────────────────────────┐
│             Renderer Process                  │
│  React 18 + TanStack React Query 5            │
│  ┌────────┬──────────────┬──────────────┐    │
│  │Sidebar │ Chat         │ Right Panel   │    │
│  │ 260px  │ (flex)       │  400px       │    │
│  └────────┴──────────────┴──────────────┘    │
└──────────────────────────────────────────────┘
```

### 任务状态机

```
READY → RUNNING_{ACTOR} → (READY | PAUSED | DONE)
                                 ↓
                              FAILED (recoverable)
                                 ↓
                              PAUSED
```

- Actor 完成后直接启动下一轮（已移除倒计时机制）
- 双方均 `type=break` → DONE
- 失败可恢复，连续失败达上限 → PAUSED
- 应用重启时，`RUNNING_*` 状态的任务自动重置为 `PAUSED`

### 数据模型

纯文件系统，无数据库。数据目录：`~/Library/Application Support/buddy/`

```
buddy/
├── global/
│   └── settings.json           # 全局设置
└── workspaces/
    └── {project-hash}/
        ├── workspace.json
        └── tasks/
            └── {task_id}/
                ├── state.json       # 任务状态
                ├── settings.json    # 任务设置
                ├── task.md          # 任务目标
                ├── context.md       # 上下文
                ├── events.jsonl     # 事件流
                ├── transcript.jsonl # 对话记录
                └── artifacts/       # 产物文件
```

所有 JSON 写入均为原子操作（`.tmp` → `rename`），Zod 在读取时校验。

### IPC 通信

- **请求-响应**：`ipcMain.handle('buddy:xxx')` ↔ `ipcRenderer.invoke('buddy:xxx')`
- **推送事件**：`webContents.send('buddy:event', ...)` → EventBus 发布/订阅

## Actor 启动适配

| Actor | 调用方式 | Session 复用 |
|-------|---------|-------------|
| Claude | `{cmd} -p --output-format stream-json --input-format text [--resume SID]` | `--resume` |
| Codex | `{cmd} exec --json -C REPO -o OUTPUT [resume SID]` | `exec resume` |
| Cursor | `{cmd} --print --force --output-format stream-json --stream-partial-output [--resume SID] PROMPT` | `--resume` |
| OpenCode | `{cmd} run --format json [--session SID]` | `--session` |
| Kimi | `{cmd} --print --output-format stream-json --input-format text [--session SID]` | `--session` |
| DeepSeek Harness | `dsh headless --json [--session-id SID]`（prompt 走 stdin） | `--session-id` |

非原生命令使用契约模式，传递 `BUDDY_ACTOR`、`BUDDY_MODE` 等环境变量。

## 技术栈

| 层面 | 选型 |
|------|------|
| 运行时 | Electron 45.2.2（当前源码） |
| 语言 | TypeScript 5 |
| UI | React 18 + Tailwind CSS 3 |
| 构建 | electron-vite |
| 包管理 | pnpm |
| 打包 | electron-builder (DMG) |
| Schema | Zod |
| 图标 | lucide-react |
| i18n | 自定义 hook，CJK 自动检测 |

## 约定

- 图标使用 lucide-react，不引入其他图标库
- JSON 写入走 `.tmp` → `rename`，不做直接写入
- Zod schema 定义在 `src/main/buddy/schemas.ts`，读取时校验
- API key 在事件写入前自动脱敏（`redact.ts`）
- UI 文本通过 `useI18n` hook 国际化

## License

MIT
