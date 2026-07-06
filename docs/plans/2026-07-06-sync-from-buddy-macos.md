# 同步计划：buddy-macos v1.0.18 -> v1.2.2

## 背景

GitHub 仓库（buddy）在迁移提交 9caa550 处停在 v1.0.18，而内网 GitLab 仓库（buddy-macos）已迭代到 v1.2.2。两个仓库 remote 独立，迁移提交包含重命名和配置适配，无法直接 merge。

本文档记录从 buddy-macos 同步 222 个提交（25 个有效提交）到 buddy 的方案和执行计划。

## 仓库状态

| 项目 | 路径 | Remote | HEAD | 版本 |
|------|------|--------|------|------|
| buddy (GitHub) | /Users/david/SynologyDrive/Projects/github/buddy | github.com:davidhoo/buddy | 9caa550 | v1.0.18 |
| buddy-macos (GitLab) | /Users/david/SynologyDrive/Projects/gitlab/buddy/buddy-macos | gitlab.weibo.cn:hubo3/buddy-macos | a2a4d11 | v1.2.2 |

- 基线 commit：4e1ee9d（v1.0.18 release），两个仓库在此点之前共享历史
- 迁移提交 9caa550 改动 20 个文件（重命名、release.sh 适配、electron-builder.yml 等）
- codex/* 分支均为迁移前死分支，与本次同步无重叠，可忽略

## 方案选择

采用思路 2：逐步同步，按功能模块分批执行，不逐 commit cherry-pick。

排除思路 1（自动化 skill/程序）的原因：
- 迁移层（重命名、配置适配）与功能层混合，自动化无法判断哪些改动该同步
- 222 个提交中约一半是 release chore，无实际代码变更
- 内网配置（glab、GitLab CI）对 GitHub 仓库无意义

## 变更范围

buddy-macos v1.0.18 -> v1.2.2 的 src/ 和 scripts/ 变更统计：31 个文件，+2111 / -189 行。

### 新增文件

| 文件 | 行数 | 说明 |
|------|------|------|
| src/main/buddy/notifications.ts | 111 | 任务状态系统通知 |
| src/renderer/lib/attachments.ts | 59 | 任务附件处理 |
| src/renderer/vite-env.d.ts | 14 | Vite 环境类型声明 |
| src/renderer/assets/logo.png | Bin | 应用图标 |
| scripts/buddy-stats.mjs | 166 | 统计脚本 |

### package.json 新增依赖

- node-pty: ^1.1.0（PTY 模式启动 actor）
- @vitest/utils: ^4.1.8
- jiti: ^2.7.0

### Schema / 类型变更

src/shared/types.ts - GlobalSettings 新增字段：
- max_compact_retries?: number
- auto_generate_commit_message?: boolean
- system_notifications_enabled?: boolean
- max_upgrade_retries?: number
- custom_prompt?: string

TaskState 新增：compact_retries?: number

新增接口：TestLauncherResult

src/shared/defaults.ts - 默认值：
- max_compact_retries: 3
- auto_generate_commit_message: true
- system_notifications_enabled: true
- max_upgrade_retries: 3
- custom_prompt: undefined

src/main/buddy/schemas.ts - Zod schema 同步上述字段，新增 optionalNonEmptyString transform

## 执行批次

### 批次 5 - 新增文件复制（2 个提交）

| Commit | 日期 | 说明 |
|--------|------|------|
| 0c3ee70 | 2026-06-17 | feat(notifications): 新增任务状态系统通知 |
| d1c5834 | 2026-06-18 | feat(composer): 创建任务时支持添加附件 |

操作：直接复制 notifications.ts、attachments.ts、vite-env.d.ts、logo.png、buddy-stats.mjs

### 批次 1 - Runner 核心（13 个提交，约 1200 行变更）

| Commit | 日期 | 说明 | 涉及文件 |
|--------|------|------|----------|
| c15fad3 | 2026-06-03 | feat(runner): 检测上下文窗口限制时自动压缩会话并重试 | runner.ts |
| 3a87cb5 | 2026-06-04 | feat(runner): 上下文窗口限制时改为重置会话而非执行 /compact | runner.ts |
| 2eacbd8 | 2026-06-04 | fix(runner): 识别中文上下文窗口限制错误信息 | runner.ts |
| 7e4bd5f | 2026-06-04 | fix(runner): 修复上下文耗尽时仅输出噪声事件导致的无限循环 | runner.ts |
| df00807 | 2026-06-05 | fix(runner): 修复上下文耗尽噪声事件的正则不匹配导致自动重置未触发 | runner.ts |
| 088df69 | 2026-06-05 | test(runner): 补充上下文耗尽噪声事件的正则匹配测试 | tests/ |
| d913f24 | 2026-06-08 | fix(runner): 过滤 step_finish 噪声事件并统一上下文耗尽短语 | runner.ts |
| 64c7dfa | 2026-06-08 | fix(parsers): 补充 Kimi parser 的 step_finish 噪声标记 | parsers.ts |
| 34280ec | 2026-06-09 | feat(runner): 支持 PTY 模式启动 actor，修复 opencode 无 TTY 时挂起问题 | runner.ts, launchers.ts |
| b693d88 | 2026-06-25 | fix(launchers): 防止子进程提前退出时 EPIPE 崩溃主进程 | launchers.ts |
| b73ea00 | 2026-06-25 | feat(runner): 支持子进程自动升级后自动重试 | runner.ts |
| 0f6d3ae | 2026-07-01 | fix(runner): 从轮次窗口暂停恢复时重置计数器 | runner.ts |
| 062369b | 2026-07-02 | fix(runner): detect runtime upgrade exits reported on stdout | runner.ts |

主要变更文件：runner.ts（+808 行）、launchers.ts（+121 行）、parsers.ts（+32 行）

### 批次 2 - Health Check（2 个提交）

| Commit | 日期 | 说明 |
|--------|------|------|
| 58cd547 | 2026-06-24 | feat(health-check): 支持连通性检查失败后重试 |
| c970c5a | 2026-07-02 | fix(health-check): auto-retry ping on CLI auto-upgrade exit |

### 批次 3 - Settings（2 个提交）

| Commit | 日期 | 说明 |
|--------|------|------|
| c89bf22 | 2026-06-17 | feat(settings): 新增自动生成 commit message 开关，创建任务时显示当前分支 |
| 6e9e844 | 2026-06-30 | feat(settings): 支持自定义提示词追加到系统提示词末尾 |

涉及文件：SettingsContent.tsx（+180 行）、prompts.ts（+7 行）、defaults.ts、types.ts、schemas.ts

### 批次 6 - 配置适配（手动调整）

| 文件 | 操作 | 注意事项 |
|------|------|----------|
| package.json | 版本号 + 依赖同步 | name 保持 buddy，不回退为 buddy-macos；新增 node-pty、jiti 等 |
| scripts/release.sh | 手动 merge | buddy-macos 用 glab，buddy 已改为 gh，不能直接覆盖 |
| scripts/buddy-stats.mjs | 直接复制 | 新文件 |
| src/shared/types.ts | 增量同步 | 新增 GlobalSettings 字段 + TestLauncherResult 接口 |
| src/shared/defaults.ts | 增量同步 | 新增默认值 |
| src/main/buddy/schemas.ts | 增量同步 | 新增 Zod schema 字段 |
| src/main/buddy/service.ts | 手动 merge | +178 行，需对比迁移层差异 |
| src/main/buddy/store.ts | 增量同步 | +5 行 |
| src/main/index.ts | 手动 merge | +13 行，notifications 注册 |
| src/main/ipc/buddy-handlers.ts | 增量同步 | +9 行 |
| src/preload/buddy-api.ts | 增量同步 | +5 行 |

### 批次 4 - UI 变更（5 个提交）

| Commit | 日期 | 说明 |
|--------|------|------|
| 319ca28 | 2026-06-08 | feat(i18n): 补充 actor 上下文管理相关事件的翻译 |
| 527f63c | 2026-06-09 | fix(renderer): 滚动按钮在详情展开时也显示 |
| 6842755 | 2026-06-17 | feat(sidebar): 展开项目时重置任务展开状态 |
| 45c317d | 2026-07-03 | feat(ui): 侧边栏品牌区显示应用图标 |
| 7d041ad | 2026-07-06 | 折叠按钮图标从 PanelBottomClose 改为 PanelBottomOpen |

涉及文件：App.tsx（+252 行）、Sidebar.tsx、ChatArea.tsx、Composer.tsx、FileStatus.tsx、MessageBubble.tsx、RunningStatusMessage.tsx、StatusBar.tsx、i18n.ts、format.ts、api.ts、useBuddy.ts

## 执行顺序

1. 批次 5（新增文件复制）- 零冲突风险
2. 批次 1（Runner 核心）- 改动最大，优先处理
3. 批次 2（Health Check）
4. 批次 3（Settings）
5. 批次 6（配置适配）- 需手动 merge
6. 批次 4（UI 变更）- 最后补外围

## 分支策略

在 feat/sync-from-buddy-macos 分支上执行，review 通过后合并到 main。

## 验证

每个批次完成后：
1. pnpm install 确认依赖正常
2. pnpm typecheck 确认类型正确
3. pnpm test 确认测试通过
4. pnpm build 确认构建成功
