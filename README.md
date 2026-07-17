# Buddy

> Let's Go, Every Buddy! 让我们一起出发，每一位 Buddy！

双 AI Agent 协作编码的 macOS 桌面应用。两个 AI Actor（执行方 + 审查方）轮流工作，逐步收敛至正确结果，支持人工校准窗口与双确认结束机制。

官网：[https://davidhoo.github.io/buddy/](https://davidhoo.github.io/buddy/) · [下载](../../releases)

## 特性

- **双 Actor 协作**：执行方实现代码，审查方检查修正，循环推进直到双方确认完成
- **5 种 AI backend**：Claude Code、Codex、OpenCode、Kimi Code、Cursor Agent；支持多个独立 Cursor profile
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

- macOS 12+ (Monterey)
- 至少一个已安装的 AI CLI 工具：[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex CLI](https://github.com/openai/codex)、[OpenCode](https://github.com/opencode-ai/opencode)、[Kimi Code](https://github.com/MoonshotAI/kimi-cli)、[Cursor Agent](https://cursor.com/docs/cli/installation)

## 安装

### GitHub Releases（推荐）

从 [Releases](../../releases) 页面下载最新版本 DMG，打开后将 Buddy 拖入 Applications 文件夹即可。

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
pnpm dist             # 构建 + 无签名 DMG
pnpm release:signed   # 构建 + 签名 + 公证（需 CSC_NAME 环境变量）
```

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
│  Launchers → Claude / Codex / OpenCode / Kimi │
│              / Cursor Agent profiles           │
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
| OpenCode | `{cmd} run --format json [--session SID]` | `--session` |
| Kimi | `{cmd} --print --output-format stream-json --input-format text [--session SID]` | `--session` |
| Cursor Agent | `{cmd} -p --output-format stream-json [--model MODEL] [--resume SID]` | `--resume` |

非原生命令使用契约模式，传递 `BUDDY_ACTOR`、`BUDDY_MODE` 等环境变量。
Cursor Agent 可创建多个命名 profile，每个 profile 独立配置模型、prompt preset、CLI 权限参数和 session。详见 [Cursor Agent backend](docs/cursor-agent-backend.md)。

## 技术栈

| 层面 | 选型 |
|------|------|
| 运行时 | Electron 33 |
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
