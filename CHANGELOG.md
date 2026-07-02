# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.2.1] - 2026-07-02

### Fixed
- 运行时 Actor 执行兼容 stdout 升级提示：wecode 将升级进度（如 `A new version is available`、`upgrade complete`）输出到 stdout，而 `extractActorOutput` 会将其过滤掉，导致运行中遇到升级退出时检测漏判、轮次直接失败。现在升级检测综合 stderr + 原始 stdout，运行中遇到升级也会自动保留会话重试当前轮次（与连通性检查的升级重试对称）

## [1.2.0] - 2026-07-02

### Changed
- 重做应用图标：由渐变背景配 "B" 字样的旧方案改为全新路径图形设计，同步更新 SVG / PNG / ICNS 三套素材

---

## [1.1.12] - 2026-07-02

### Fixed
- 连通性检查兼容 CLI 自动升级：当 Actor CLI（如 wecode-cli-cc）在首次启动时因自动升级而退出（升级成功要求重启，或升级脚本下载失败），健康检查现在会识别升级场景并自动重试 ping，而不再直接判失败、要求用户手动「重新检查」。复用 `max_upgrade_retries` 设置，并在事件日志与转录中记录重试过程

---

## [1.1.11] - 2026-07-01

### Fixed
- 修复任务因轮次窗口上限被暂停后，手动继续时重复报错无法推进的问题：从暂停状态恢复时自动重置窗口计数器，恢复正常运行

### Changed
- max_rounds 默认值从 10 改为 9999，避免低默认值意外触发自动轮次限制

---

## [1.1.10] - 2026-06-30

### Added
- 自定义提示词：在设置页新增「提示词」标签页，可编写一段自定义指令追加到系统提示词末尾，对每个 Actor 的每一轮生效，方便统一注入项目规范、编码偏好或输出格式要求

---

## [1.1.9] - 2026-06-25

### Added
- 子进程自动升级后自动重试：当 Actor CLI（如 wecode 等）因自动升级而提前退出时，自动识别升级场景并保留会话重试当前轮次，无需人工干预
- 新增 `max_upgrade_retries` 全局设置项，可配置升级退出后的最大重试次数（默认 3 次）

### Fixed
- 修复子进程因自动升级提前退出时管道关闭触发 EPIPE 异常导致主进程崩溃的问题
- 增加全局未捕获异常守卫，兜底处理 EPIPE 等意外异常并记录日志，避免主进程直接崩溃

---

## [1.1.8] - 2026-06-24

### Fixed
- 连通性检查失败后支持重试：检查失败时任务状态改为 FAILED（而非直接完成），并在失败提示与状态栏中提供"重新检查"按钮，无需重新创建任务即可重新发起连通性检查；重试前自动清除上次的失败记录

---

## [1.1.7] - 2026-06-18

### Added
- 创建任务时支持添加附件：可在任务创建弹窗中附加文件，附件会保存到任务目录并自动写入 task.md，支持图片预览和多种文件类型图标

### Changed
- 展开侧边栏项目时自动折叠任务列表，避免一次性展开过多任务

---

## [1.1.6] - 2026-06-17

### Added
- 任务状态系统通知：任务完成、失败、暂停时发送 macOS 系统通知，完成通知附带轮次、耗时和 Token 用量统计，可在设置页关闭
- 自动生成 commit message 开关：新增全局设置项（默认开启），关闭后提交对话框不再自动生成提交信息
- 创建任务弹窗中显示当前 git 分支名，方便确认工作目录

### Fixed
- 修复 execGit 中 child process `error` 与 `exit` 事件竞态导致的双重 resolve/reject

---

## [1.1.4] - 2026-06-09

### Added
- Launcher 连通性测试：在设置页面为每个 Actor 的命令添加测试按钮，一键验证命令是否可用并实际调用 Actor 获取响应，支持工具检查和 Ping 两阶段检测，测试结果实时展示成功/失败状态及响应预览
- `TestLauncherResult` 类型和 `buddy:testLauncher` IPC 通道，前后端完整支持 Launcher 测试能力

---

## [1.1.3] - 2026-06-09

### Fixed
- 补充 Actor 上下文管理相关事件的翻译：上下文超限、会话重置、精简成功/失败/跳过等事件在界面中显示为原始 key 而非可读文本，现已补充中英繁三语翻译
- 过滤 Kimi `step_finish` 噪声事件：Kimi Actor 在上下文耗尽退出时发出 `step_finish` 事件，该事件不含实际内容却被当作有效输出，与 OpenCode 的同类问题一致，现在标记为 noise 并过滤

---

## [1.1.2] - 2026-06-08

### Fixed
- 过滤 OpenCode `step_finish` 噪声事件：上下文耗尽的 Actor 在退出时也会发出 `step_finish` 事件，这些生命周期事件不含实际内容却被当作有效输出，导致任务无法触发会话重置；现在 `step_finish` 与 `step_start` 一样标记为 noise 并在判断纯噪声输出时过滤
- 统一上下文耗尽短语：将两处错误信息中的上下文耗尽描述统一为 `context window exhausted`，并同步修正正则匹配模式从 `/context window likely exhausted/` 改为 `/context window.*exhausted/`，确保不论错误信息是否含 `likely` 都能正确匹配并触发自动重置

---

## [1.1.1] - 2026-06-04

### Fixed
- 修复 Actor 上下文耗尽时仅输出噪声事件（step_start）导致的无限循环：当 OpenCode/Kimi 上下文窗口耗尽后只发出 step_start 事件时，其占位符 "..." 被当作有效内容处理，导致任务无法触发会话重置而无限循环；现在 step_start 事件标记为 noise，纯噪声输出会正确抛出上下文耗尽错误，触发自动重置机制

---

## [1.1.0] - 2026-06-04

### Fixed
- 识别中文上下文窗口限制错误信息：新增 8 条中文正则匹配规则，覆盖 GLM、Qwen、DeepSeek 等模型返回的上下文超限错误，确保自动重置会话机制在中文错误场景下正常触发

---

## [1.0.20] - 2026-06-04

### Changed
- 上下文窗口限制时的处理方式从 /compact 改为重置会话：/compact 在 `-p`（pipe）模式下会被当作普通文本输入而非斜杠命令，无法实际压缩会话；现在改为清空会话 ID 并注入 LLM 生成的精简上下文摘要，在新会话中继续执行

### Fixed
- 修复上下文溢出后 /compact 无效导致反复触发的问题：重置会话后生成高质量摘要，失败时回退到截断式摘要，并备份原始上下文防止信息丢失

---

## [1.0.19] - 2026-06-03

### Added
- Actor 触达上下文窗口限制时自动压缩会话并重试：检测到上下文溢出错误后，自动发送 /compact 命令压缩会话，然后重新执行当前轮次，无需人工干预
- 新增「压缩重试上限」设置项（默认 3 次），可在全局/任务级别控制自动压缩的最大重试次数

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
- 修复 GitLab Release 资产链接创建失败的问题：改用 Web 可访问的下载 URL，并用 tab 分隔解析替代管道符解析避免链接名称含空格时出错

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

- 移除 .gitlab-ci.yml，发布流程全部由本地 release.sh 完成
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
- GitLab CI/CD 流水线配置
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

[1.2.1]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.2.1
[1.2.0]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.2.0
[1.1.12]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.1.12
[1.1.11]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.1.11
[1.1.10]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.1.10
[1.1.9]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.1.9
[1.1.8]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.1.8
[1.1.7]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.1.7
[1.1.6]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.1.6
[1.1.4]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.1.4
[1.1.3]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.1.3
[1.1.2]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.1.2
[1.1.1]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.1.1
[1.1.0]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.1.0
[1.0.20]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.20
[1.0.19]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.19
[1.0.18]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.18
[1.0.17]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.17
[1.0.16]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.16
[1.0.15]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.15
[1.0.14]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.14
[1.0.13]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.13
[1.0.12]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.12
[1.0.11]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.11
[1.0.10]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.10
[1.0.9]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.9
[1.0.8]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.8
[1.0.7]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.7
[1.0.6]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.6
[1.0.5]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.5
[1.0.4]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.4
[1.0.3]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.3
[1.0.0]: https://gitlab.weibo.cn/ailab/buddy-macos/-/tags/v1.0.0
