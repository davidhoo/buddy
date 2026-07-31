# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2.6] - 2026-07-21

### Added
- 变更文件 diff 查看弹窗：右侧「文件状态-变更」行改为可点击按钮，弹出 ChangesModal 展示所有变更文件；文件列表采用抽屉式折叠，点击展开后通过 React Query 按需加载 git diff，语法着色显示（`@@` 高亮、`+` 绿、`-` 红），支持 Esc/遮罩关闭
- 新增 `gitFileDiff` IPC 链路（git.ts → service → handler → preload → renderer），支持单文件 unified diff 获取（优先 `git diff HEAD`，无 HEAD 回退 staged+unstaged 拼接，未跟踪文件合成伪 diff，二进制文件提示，200KB 截断）
- 新增 `session-insight.ts`：从 actor 本地会话存储读取 stdout 中缺失的模型名和 token 用量——kimi 从 `~/.kimi-code/sessions/*/<sessionId>/agents/*/wire.jsonl` 的 `usage.record` 聚合输入/输出/缓存 token；opencode 从 SQLite/JSON 会话存储读取模型名
- `getTaskStats` 新增 kimi token 时间窗归因：利用 transcript 时间戳和 `elapsed_ms` 构造运行窗口（±5s 容差），将 wire.jsonl 的 usage 记录归因到对应 run，健康检查 ping 用量在窗口外不会误计
- `model-detect.ts`：kimi 配置路径改为 `~/.kimi-code/config.toml` 优先（`~/.kimi` 兜底）；opencode 新增从 launcher 命令解析 `-m`/`--model`/`--model=`
- 任务完成总结消息末尾新增「点击查看变更文件」链接，点击弹出与右侧「文件状态-变更」相同的 ChangesModal diff 弹窗（MessageBubble → ChatArea → App 透传 `onViewChanges`，App 内按当前任务 repo 拉取 gitStatus）
- 右侧「文件状态-分支」行改为可点击，弹出分支切换弹窗（BranchModal）：列出本地分支并标记当前分支，点击即执行 `git checkout`；切换失败时在弹窗内展示 git 报错且不切换，成功后自动关闭并刷新 git 状态；新增 `gitBranches`/`gitCheckout` IPC 链路（分支名合法性校验防注入）
- BranchModal 新增「创建新分支」功能：弹窗顶部输入框 + 创建按钮（Enter 快捷提交），执行 `git checkout -b` 从当前 HEAD 创建并切换；失败在弹窗内展示报错，成功自动关闭并刷新；新增 `gitCreateBranch` IPC 链路

### Changed
- `BuddyStore.getRoundEvents` 模型回退链：kimi/opencode 优先从会话存储读取模型，再回退到配置文件

## [1.2.5] - 2026-07-13

### Added
- 新增按项目 FIFO 任务队列执行模式：创建任务时可选择「立即执行」或「排队执行」，排队任务在前置任务完成后自动推进，也可手动「立即执行」插队（更早的未完成排队任务标记为 superseded，数据保留）
- 新增 `QueueCoordinator`：基于磁盘状态重算每个 workspace 队列快照，per-workspace 串行 reconcile 锁保证同一等待任务只启动一次
- 数据模型扩展：新增 `QUEUED` 状态、`execution_mode`(immediate|queued) 与 `TaskQueueInfo`（waiting/active/superseded）；`Task` 增加 `created_at` 用于稳定排序
- 渲染层：创建任务弹窗新增执行方式切换；新增排队「立即执行」浮层显示排队位置/superseded 状态；Sidebar/StatusBar/TitleBar 处理 QUEUED 状态样式；i18n 补充 queue.* 事件与状态文案（zh-CN/zh-TW/en）
- `recoverInterruptedRuns` 扩展 `PINGING` 重置并在恢复后 rebuildAndReconcileAll；`deleteTask` 触发队列重新调度
- 新增 `buddy-queue-coordinator.test.ts` 单元测试

### Changed
- `detectModelFromConfig` 新增 `command` 参数：当通过 `wecode codex` 启动 codex 时，从 `~/.wecode-cli/config.json` 的 `codex.model` 读取实际模型，而非 `~/.codex/config.toml`（wecode 不会回写 config.toml）
- `BuddyStore.getRoundEvents` 与 `BuddyCoreService.getRoundEvents` 透传 `command`；当调用方未传入时，从任务 settings 的 `launchers[actor].command` 补全

---

## [1.2.4] - 2026-07-10

### Changed
- `detectModelFromConfig` 新增 `command` 参数，通过 `isWecodeCodexCommand` 判断命令是否为 `wecode codex`
- 当通过 wecode 启动 codex 时，从 `~/.wecode-cli/config.json` 的 `codex.model` 读取实际模型，而非 `~/.codex/config.toml`（wecode 不会回写 config.toml）
- `BuddyStore.getRoundEvents` 与 `BuddyCoreService.getRoundEvents` 透传 `command`；当调用方未传入时，从任务 settings 的 `launchers[actor].command` 补全
- 补充 wecode 配置缺失/无 codex.model、普通 codex、command 为空等分支的单元测试

---

## [1.2.3] - 2026-07-10

### Changed
- 统一 `formatDuration` 为 `xdxhxmxs` 紧凑英文格式，主进程通知与渲染进程逻辑一致
- 新增天(d)级别时长支持，移除渲染进程 600s 阈值特殊分支，sub-second 统一用 `Math.max(0, Math.floor(ms))` 防止负值

### Fixed
- 通知文案由中文（如「18分42秒」）改为紧凑格式（如 18m42s）
- 补充 `formatDuration` 单元测试，覆盖 ms/s/m/h/d 各级别

---

## [1.2.2] - 2026-07-07

### Added
- 项目从 GitLab 迁移至 GitHub 并重命名为 Buddy，作为迁移后首个正式发布
- 同步 buddy-macos v1.0.18 → v1.2.2 的全部功能：任务状态系统通知、任务附件处理、健康检查、紧凑重试与升级重试等
- 新增 GitHub Pages 官网与最佳实践文档，支持 push 到 main 自动部署
- Composer 支持附件上传，ChatArea / MessageBubble / Sidebar / SettingsContent 等界面同步增强

### Changed
- Runner 重构，扩展任务状态机与轮次处理逻辑（+808 行）
- i18n 扩展中英文资源，新增大量 UI 文案
- 应用图标同步更新

### Fixed
- 修复 README 章节顺序：特性列表曾被官网章节截断
- 官网首页卡片栅格宽度扩展至整段宽度（1400px）

---

## [1.0.18] - 2026-06-03

### Added
- 任务右键菜单：悬停任务行显示「⋯」按钮，点击展开菜单可重命名、置顶/取消置顶、删除
- 任务重命名：支持给任务设置自定义显示名称，替代默认的任务 ID
- 设置页新增「连续失败上限」配置项，可自行调整自动暂停阈值

### Changed
- 连续失败默认上限从 3 调至 10，减少正常使用中的误暂停
- 侧边栏任务操作从独立按钮改为统一的「⋯」菜单入口，界面更简洁

### Fixed
- 修复多项目切换时提交反馈显示在错误项目下的问题

---

## [1.0.17] - 2026-06-02

### Fixed
- 修复 git 提交信息生成超时后仍返回部分输出的问题：超时时间从 30s 提升到 120s，超时终止后不再将截断的不完整输出当作有效提交信息

---

## [1.0.16] - 2026-06-01

### Added
- 任务完成统计直接嵌入消息流：双确认结束时统计表随消息一同展示，无需额外加载查询
- 提交反馈组件改进：成功/失败提示移入文件状态区域，6 秒自动消失，带图标和关闭按钮

### Changed
- break 决策提示优化：收到对端 break 请求时，明确要求只做确认或驳回决策，不再开始新工作

### Fixed
- 修复 Claude 流式输出含 tool_result 时 JSONL 解析断裂的问题：被截断的事件不再阻塞后续有效事件的解析，buddy JSON 提取不再被 tool_result 中的 "content" 键干扰
- 修复 OpenCode/Kimi 通过 echo 命令输出 buddy JSON 时 break 信号无法被检测的问题：流式解析和输出提取均支持从 tool_use 事件中识别 buddy 消息，prompt 增加禁止使用 shell 命令输出 JSON 的规则
- 修复任务完成统计表中费用列在部分情况下仍显示的问题：移除不可靠的费用列展示

---

## [1.0.15] - 2026-06-01

### Changed
- Actor 退出错误信息更精准：区分信号杀死（如超时）与退出码，替代原来的硬编码文本
- PING 超时从 30 秒提升到 120 秒，减少网络较慢时的误超时
- 原生 Actor（Claude/OpenCode/Kimi）输出做规范化处理，统一生成 `{type, content}` JSON 格式，确保下游解析一致

### Fixed
- 修复 Claude 模型名称未正确提取的问题：从 modelUsage 对象中读取模型名称作为回退
- 移除轮次事件与任务统计中的费用（cost）显示，避免数据不准确时误导用户

---

## [1.0.14] - 2026-06-01

### Added
- 任务完成时展示汇总统计表：双 Actor 的模型、Token 用量（含缓存读取）、耗时、费用、轮次一目了然，合计行显示任务整体开销

### Changed
- 新建任务时默认使用当前选中任务的项目路径，减少重复输入

### Fixed
- 修复 GitHub Release 资产链接上传失败的问题：改用 gh release upload 命令

---

## [1.0.13] - 2026-06-01

### Added
- 支持从 Actor 配置文件回退检测模型名称：当流式输出中无法获取模型信息时，自动读取 opencode、codex、kimi 的本地配置文件作为回退，确保运行详情中的模型名称展示更可靠

### Fixed
- 过滤 stderr 中的 CLI 警告信息（如 `--dangerously-skip-permissions` 提示），避免因无害警告导致任务误报执行失败
- 过滤更多系统级事件（init、warning 等子类型），避免非 Actor 内容干扰任务状态判断

---

## [1.0.12] - 2026-06-01

### Fixed
- 修复 Claude Code 仅输出 system/hook 噪声事件时，原始 JSON 被当作错误消息展示的问题；现在过滤噪声事件并提供更有意义的错误提示
- 修复 `release.sh` 重复发布时资产链接创建失败的问题；改为先删除已有链接再重新创建，并打印警告而非静默忽略错误

### Changed
- Codex 输出解析增强：支持 tool_call 事件的工具名称和参数展示，优先提取 text/output_text 类型内容

---

## [1.0.11] - 2026-06-01

### Added
- 运行详情面板：支持展开查看每轮 Actor 运行的模型、耗时、Token 用量等详细信息
- 事件类型可读化：原始事件类型以友好标签展示，支持展开/折叠查看详情
- Kimi/OpenAI 兼容格式的 Token 用量解析（input_tokens/prompt_tokens/output_tokens/completion_tokens）和模型识别
- OpenCode 模型信息提取（从 step_finish 的 respondedModelID/requestedModelID 获取）

### Changed
- 当 Actor 未提供运行时长时，基于首末事件时间戳回退计算

---

## [1.0.10] - 2026-05-29

### Added
- 外部链接自动在系统浏览器中打开：应用内点击链接不再导航到空白页，而是拦截并调用系统浏览器
- Break 驳回机制：当一方请求 break 而另一方继续修改代码时，break 请求被驳回，请求方需重新审查变更后再确认
- `shell:openExternal` IPC 通道，供渲染进程打开外部 URL

### Changed
- 健康检查 prompt 改为更自然的问候式，不再要求固定 JSON 格式回复
- 健康检查增加空响应校验，actor 返回空内容视为失败
- Codex actor 健康检查优先使用 threadId 显示会话标识
- 更新下载完成后侧边栏按钮改为醒目的主色样式，文案改为"重启并更新"
- Launcher 配置输入框与保存按钮改为行内布局，改善编辑体验

---

## [1.0.9] - 2026-05-29

### Added
- Actor 连通性健康检查：任务首次启动时自动 ping 两个 actor，验证可用性后再执行任务，避免在 actor 不可用时盲目运行
- 健康检查失败时任务直接结束并显示详细错误信息，便于快速定位问题

### Changed
- 空字符串的 launcher command 自动回退到 actor 名称作为默认值

---

## [1.0.8] - 2026-05-29

### Changed
- Actor 失败处理增强：识别"静默失败"和"幽灵输出"，连续失败达到上限时自动暂停而非无限重试
- 对端已请求 break 时，当前 actor 失败自动确认 dual-break 结束任务
- 更新器开启自动下载并增加 30 分钟周期性检查
- 更新按钮区分"检查更新"与"安装更新"两种状态

### Fixed
- 修复 repoRoot 被写入 [object Object] 的问题，增加类型守卫与 localStorage 清理
- 修复 onCreateTask 调用缺少空括号导致的类型错误
- 修复 running-status 展开面板底部边框断线

---

## [1.0.7] - 2026-05-29

### Added
- 运行时可展开 Actor 实时输出面板，查看 AI Actor 的 stdout 流式输出
- 欢迎页增加"新建任务"按钮与 CLI 配置提示

### Changed
- Prompt 增加连续失败信息和循环卡顿时的 break 指引，避免 Actor 陷入无效循环
- 语言检测增加主进程 locale 作为 fallback，改善非浏览器环境的语言识别
- 禁用更新器差量下载，避免下载不完整问题
- ChatArea 滚动按钮在面板展开时隐藏，min-h-0 修复 flex 溢出

---

## [1.0.6] - 2026-05-29

### Fixed

- 修复自动更新下载完成后，状态被 checking/not-available 事件回退的问题
- 修复窗口销毁后菜单操作和更新器推送事件导致崩溃的问题

### Changed

- 更新器错误事件改为 not-available，简化状态机
- 侧边栏品牌文字布局修复，防止更新按钮挤压
- 发布脚本支持部署固定名称的最新安装包（buddy-arm64.dmg / buddy-x64.dmg）

---

## [1.0.5] - 2026-05-29

### Changed

- 更新项目标题、Slogan 和安装说明 (docs: readme)

---

## [1.0.4] - 2026-05-29

### Added

- 改为手动下载更新，侧边栏显示更新状态徽标 (feat: updater)

### Changed

- 优化 /release 命令，优先使用 upstream 远程仓库

---

## [1.0.3] - 2026-05-29

### Changed

- 移除 CI 配置，发布流程全部由本地 release.sh 完成
- 精简 CI 配置，移除 typecheck 和 unit-test

### Fixed

- release.sh 已存在的资产链接用 PUT 覆盖而非跳过
- release.sh Release 已存在时只更新资产链接，不覆盖 name/notes
- release.sh Release 创建失败时容忍已存在的资产链接

---

## [1.0.0] - 2026-05-28

### Added

- 原生 Buddy Core：TypeScript 重写 buddy-python 的双 Actor 轮转、break 双确认、失败暂停、session 复用
- 支持 4 种 AI Actor：Claude Code、Codex、OpenCode、Kimi Code（含变体检测）
- 任务状态机：READY → RUNNING → PAUSED/DONE/FAILED 完整生命周期
- 指令队列：运行期间可排队发送指令，轮次结束后连续执行
- Git 集成：本地化 conventional commit 消息自动生成、变更文件查看、提交与推送
- 消息附件：支持在对话中附加文件内容
- 新手引导：首次使用时的引导提示
- 记住上次选中的任务
- 任务未读状态指示
- 三栏 UI 布局：Sidebar + Chat + Right Panel
- 23 套预设主题，CSS 自定义属性驱动，支持自定义颜色选择器
- 国际化：中文简体 / 中文繁体 / 英文，CJK 自动检测
- 快捷键系统：可配置发送快捷键、Cmd+1/2/3/4 标签页切换、Cmd+Enter 发送
- macOS 原生菜单栏国际化
- 与 buddy-python 数据目录兼容（`~/Library/Application Support/buddy/`）
- 应用崩溃/重启后任务状态完整恢复
- GitHub Actions 流水线配置
- DMG 打包（arm64 / x64 分架构构建）

### Changed

- 移除倒计时机制，Actor 完成后直接启动下一轮
- 从 HTTP 代理架构迁移到原生 IPC 架构（移除 Python 运行时依赖）
- 全局设置中管理 max_rounds 和任务相关参数
- Actor 错误消息包含所有输出来源
- 默认 launcher 命令设为 actor 名称而非空字符串
- 侧边栏项目可折叠
- 紧凑的弹窗布局，可折叠的侧边栏事件
- 简化侧边栏行和状态栏布局

### Fixed

- 修复 macOS PATH 环境变量问题，Actor 子进程可正确找到 CLI 工具
- 修复 JSON 流式输出解析增强
- 修复 git status 路径解析截断首字符
- 防御性处理 gitStatus.files 可能为 undefined
- 统一侧边栏与弹窗的文件变更汇总计算
- 修复提交弹窗 +/- 列对齐和汇总数据不一致
- 修复弹窗 Escape 关闭与远程仓库选择记忆
- 目录选择对话框支持创建新目录并消除重复配置
- CommitModal 生成完成后自动聚焦提交信息输入框
- 统一下拉菜单样式
- 与 buddy-python 对齐 workspace key 哈希算法
- 允许 READY 和 FAILED 状态的任务重新启动
- 加载旧版 Buddy 数据兼容
- 保留原生 CLI 设置不被覆盖
- 移除已完成的 actor 文本从事件摘要中隐藏
- 修复侧边栏任务行 hover 对齐

---

## 早期开发阶段 - 2026-05-22 ~ 2026-05-25

### Added

- Electron 主进程与窗口管理器
- React 基础结构 + Tailwind CSS
- API 客户端与 React hooks
- 标题栏、侧边栏、状态栏、聊天区组件
- 组件集成到主应用
- E2E 测试基础框架
- 构建与打包配置
- MVP 设计与实施计划
- 可调整大小的侧边栏和状态栏、窗口拖拽
- 加载与错误状态
- 健康检查与错误处理
- Buddy session 工作流
- 侧边栏状态指示器
- 项目管理、自动开始倒计时、错误文本解码
- 任务置顶功能
- i18n (zh-CN/zh-TW/en) 与可配置发送快捷键

### Changed

- 从 HTTP API 代理迁移到 Vite 代理解决 CORS

### Fixed

- 侧边栏任务置顶时移除水平滚动条
- 侧边栏切换图标与状态栏样式统一

---

## 设计与规划 - 2026-05-22

### Added

- 项目需求文档 (REQUIREMENTS.md)
- 项目结构初始化

[1.2.2]: https://github.com/davidhoo/buddy/releases/tag/v1.2.2
[1.0.18]: https://github.com/davidhoo/buddy/releases/tag/v1.0.18
[1.0.17]: https://github.com/davidhoo/buddy/releases/tag/v1.0.17
[1.0.16]: https://github.com/davidhoo/buddy/releases/tag/v1.0.16
[1.0.15]: https://github.com/davidhoo/buddy/releases/tag/v1.0.15
[1.0.14]: https://github.com/davidhoo/buddy/releases/tag/v1.0.14
[1.0.13]: https://github.com/davidhoo/buddy/releases/tag/v1.0.13
[1.0.12]: https://github.com/davidhoo/buddy/releases/tag/v1.0.12
[1.0.11]: https://github.com/davidhoo/buddy/releases/tag/v1.0.11
[1.0.10]: https://github.com/davidhoo/buddy/releases/tag/v1.0.10
[1.0.9]: https://github.com/davidhoo/buddy/releases/tag/v1.0.9
[1.0.8]: https://github.com/davidhoo/buddy/releases/tag/v1.0.8
[1.0.7]: https://github.com/davidhoo/buddy/releases/tag/v1.0.7
[1.0.6]: https://github.com/davidhoo/buddy/releases/tag/v1.0.6
[1.0.5]: https://github.com/davidhoo/buddy/releases/tag/v1.0.5
[1.0.4]: https://github.com/davidhoo/buddy/releases/tag/v1.0.4
[1.0.3]: https://github.com/davidhoo/buddy/releases/tag/v1.0.3
[1.0.0]: https://github.com/davidhoo/buddy/releases/tag/v1.0.0
