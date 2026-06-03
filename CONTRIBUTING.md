# 贡献指南

感谢你对 Buddy 的关注！本文档介绍如何参与项目开发。

## 开发环境

### 前置要求

- macOS 12+ (Monterey)
- Node.js >= 18
- pnpm 11 (`corepack enable && corepack prepare pnpm@11 --activate`)
- 至少一个已安装的 AI CLI 工具（用于 E2E 测试）：Claude Code / Codex / OpenCode / Kimi Code

### 快速开始

```bash
pnpm install          # 安装依赖
pnpm dev              # 开发模式（HMR 热更新）
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 开发模式（HMR） |
| `pnpm build` | 编译 main/preload/renderer |
| `pnpm test` | 单元测试（vitest run tests/unit） |
| `pnpm test:e2e` | E2E 测试（Playwright） |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm dist` | 构建 + 无签名 DMG |
| `pnpm release:signed` | 构建 + 签名 + 公证（需 CSC_NAME） |

运行单个测试文件：

```bash
pnpm vitest run tests/unit/main/buddy-store.test.ts
```

## 项目结构

```
src/
├── main/              # Electron 主进程
│   ├── buddy/         # 核心逻辑：service, store, runner, events, launchers, schemas
│   ├── ipc/           # IPC 处理器
│   ├── menu.ts        # 原生菜单
│   └── updater.ts     # 自动更新
├── preload/           # 预加载脚本
│   ├── buddy-api.ts   # 暴露 window.buddy
│   └── index.ts       # 暴露 window.api
└── renderer/          # 渲染进程
    ├── components/    # React 组件
    ├── hooks/         # 自定义 hooks
    ├── lib/           # 工具函数
    └── main.tsx       # 入口

tests/
├── unit/              # 单元测试（vitest）
│   ├── main/
│   ├── preload/
│   └── renderer/
└── e2e/               # E2E 测试（Playwright）
```

## 代码规范

### Commit 消息

使用 Conventional Commits 格式，支持中文或英文：

```
type(scope): 简短描述
```

**类型**：`feat`、`fix`、`refactor`、`style`、`chore`、`docs`、`test`、`ci`

**范围**（可选）：`core`、`ui`、`git`、`runner`、`updater`、`ci`、`dialog`

示例：

```
feat(ui): 添加任务未读状态指示
fix(core): 修复 macOS PATH 问题
refactor(runner): 移除倒计时机制
ci: 添加 GitHub Actions 流水线配置
```

### TypeScript

- `strict: true`，启用所有严格检查
- 主进程使用相对路径导入；渲染进程使用 `@/` 别名映射到 `src/renderer`
- Zod schema 定义在 `src/main/buddy/schemas.ts`，读取时校验

### 关键约定

- **图标**：仅使用 lucide-react，不引入其他图标库或自定义 SVG
- **JSON 写入**：必须走 `.tmp` → `rename` 原子写入，不做直接写入
- **敏感数据**：API key 在事件写入前由 `redact.ts` 自动脱敏
- **国际化**：UI 文本通过 `useI18n` hook 处理，不硬编码字符串
- **注释**：仅注释「为什么」，不注释「做什么」

## 提交 PR

1. Fork 仓库并从 `main` 创建功能分支
2. 确保通过类型检查和测试：`pnpm typecheck && pnpm test`
3. 按照规范编写 commit 消息
4. 提交 Merge Request，描述变更内容和动机

### PR 检查清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过
- [ ] 新功能有对应测试
- [ ] UI 变更已在开发模式下验证
- [ ] 国际化文本已提取（不硬编码中英文）
- [ ] 图标使用 lucide-react

## 架构要点

### 三进程模型

- **Main**：Node.js 环境，文件系统访问、子进程管理、原生菜单
- **Preload**：contextBridge 暴露 `window.api`（系统操作）和 `window.buddy`（核心业务）
- **Renderer**：浏览器环境，React UI

### IPC 通信

- 请求-响应：`ipcMain.handle('buddy:xxx')` ↔ `ipcRenderer.invoke('buddy:xxx')`
- 推送事件：`webContents.send('buddy:event', ...)` → EventBus

### 数据持久化

纯文件系统（`~/Library/Application Support/buddy/`），无数据库。所有 JSON 写入为原子操作，Zod 在读取时校验而非写入时，保证前向兼容。

## 问题反馈

在仓库 Issues 中提交，请包含：

- macOS 版本
- Buddy 版本
- 复现步骤
- 预期行为与实际行为
