# 本机 Agent 管理实现与验证记录

验证日期：2026-10-29。基线为 v2.0.6；工作分支 `codex/dev-from-v2.0.6`。

## 已实现

- 设置中的 Agent 页面位于常规和外观之间；只列具有 CLI/ACP 执行入口的 Agent，展示路径、版本、安装来源和协议状态。
- 识别规则集中在 `src/shared/agents.ts`，任务选项从发现结果生成；保留旧 Actor ID 和历史 launcher。
- 通过受限 `initialize` 自动验证本地 ACP，缺少 adapter 或握手失败不会触发下载或生成请求。
- CLI/ACP 各自保存命令、argv、环境和默认模型；超时统一使用常规设置。每行高级面板支持安装候选切换，暂不提供添加自定义 Agent 的界面入口。
- CLI 模型通过实际命令参数传递；Cursor/Antigravity/CodeBuddy/OpenCode/Kimi Code 提供原生来源的候选列表，其他支持模型参数的 CLI 可以输入模型 ID。
- 新建任务按角色和运行上下文保存模型记忆；已有记忆优先于设置默认，显式原生默认也可记忆。模型记忆 key 不包含明文凭据。
- 新 Agent 使用通用运行状态、消息角色和会话映射，测试覆盖两个新 ID 的 ACP 两轮及 dual-break。
- 更新按识别到的安装渠道执行，支持单个/批量、串行去重、取消待执行项目、持久作业状态及更新后的版本/可运行验证。
- 全局运行租约保护任务、扫描、启动器测试和模型查询，更新不会与这些操作同时替换安装。

## 本机只读发现与握手

以下是本机检查时的历史结果，不是产品固定支持版本。没有执行本机软件更新。后续按用户要求，纯桌面应用已从 Agent 列表及独立扫描中排除；有执行入口的 Agent 仍可附带显示 App 版本。

| Agent | CLI/App 版本 | 安装来源识别 | ACP 证据 |
| --- | --- | --- | --- |
| Claude Code | CLI 2.1.159 | 原生 self | 本地适配器握手通过 |
| Codex | CLI 0.164.0 | Homebrew | 本地适配器握手通过 |
| Cursor | CLI 2026.09.15-d2fe57e | 未确定 | 原生握手通过 |
| Antigravity | CLI 1.4.9 | 未确定 | 此安装未暴露可验证入口 |
| OpenCode | CLI 1.19.4 | Homebrew | 原生握手通过 |
| Kimi Code | CLI 0.8.0（历史安装） | 未确定 | 当时未发现 ACP 入口；当前 2.4.0 的复验见下文 |
| DeepSeek Harness | CLI/App 0.2.1-rc.3 | 应用内 CLI | 原生握手通过 |
| WeCode Claude | CLI 2.1.159 | WeCode wrapper | 本地适配器握手通过 |
| WeCode Codex | CLI 0.164.0 | WeCode wrapper | 本地适配器握手通过 |
| WeCode OpenCode | CLI 1.19.4 | WeCode wrapper | 原生握手通过 |
| CodeBuddy | CLI 2.155.0 | npm | `--acp` 握手返回 protocolVersion=1 |
| Claude Desktop | App 1.3561.0 | 应用包 | 仅展示安装 |
| VS Code | App 1.141.0 | 应用包 | 仅展示安装 |
| WorkBuddy | App 5.5.6 | 应用包 | 仅展示安装 |
| Zed | App 0.233.10 | 应用包 | 仅展示安装 |

CodeBuddy CLI 另做真实生成冒烟测试：使用新命令构建器指定 `deepseek-v4.1-flash`，在临时空目录请求固定回复、禁用任务中的工具操作。进程 exit 0，返回实际模型 `deepseek-v4.1-flash`，回复匹配；没有改动仓库文件。

## 自动化验证

- 类型检查和三目标构建通过。
- 完整单测串行执行：81 个文件通过，848 项通过、1 项跳过；之后修改的服务和弹窗相关测试定向通过。
- 动态 ACP 两轮与 dual-break 测试通过，真实执行临时 Node stdio 服务并重新读取状态文件。
- 更新测试使用临时安装树和受控包管理器响应，验证原 prefix、包身份、去重、更新后版本及可执行检查。没有把用户本机 Agent 当更新试验对象。
- Playwright 的应用启动、Agent 页展开/编辑/保存两项测试通过；截图存放在临时目录，不提交仓库。
- 全量 E2E 另有四项失败：侧边栏隐藏时欢迎页仍有同名“新建任务”按钮、快捷键录制的 Meta 修饰键断言、倒计时自动跳过。Agent 页面目标测试通过；全量 E2E 未宣称通过。
- 默认并发单测中，原有 task-services 进程清理测试间歇出现 `kill EPERM`。v2.0.6 独立源码副本的全量单测也复现了同一测试文件的三项失败；当前分支串行全量通过。

## 能力限制

- 安装来源未知时，会读取已识别 CLI 的帮助声明检测原生更新；无可验证更新能力才不提供更新按钮。不会改用其他包管理器重装。没有验证过所有第三方渠道的真实升级。
- 当前更新互斥采用全局保守租约：任一 Buddy Agent 正在运行时更新会跳过；不终止任务。后续可在保持测试约束下细化到安装包级互斥。
- 未支持的 CLI 模型枚举采用手工 ID；没有统一供应商、云模型目录或网关。
- ACP 握手通过表示协议入口可用；不等于所有模型均已登录、可计费调用或全部扩展能力均可用。
- 本次没有发布、生成安装包或替换系统内已安装的 Buddy。

## Agent 列表界面更新

按用户提供的 Magpie 截图改为 56px 紧凑列表，版本更新按钮、协议选择、默认模型和任务启用开关直接在行内操作，详细启动配置放在每行“高级”展开区域，高级按钮位于更新按钮前。菜单继续位于设置中的常规与外观之间。

14 个品牌/模型图标从 Magpie `c3462d5f` 原样复制，逐文件 SHA-256 对照一致。彩色图标使用图片，单色图标使用 CSS mask 适配主题；保留 MIT 许可并将许可文件随应用资源打包。

本次定向验证：类型检查、三目标构建、46 项相关单测和 3 项 Playwright 页面测试通过。页面测试覆盖行内模型、CLI/ACP 切换、启用开关、单个/全部更新、管理编辑、1100×876 明暗主题以及 640×850 窄窗口；数据为隔离测试夹具，没有升级本机软件。截图与参考图逐项核对了图标、行高、字级、列对齐和下拉框底色。

## 协议切换等待与列表范围修复

- Agent 菜单使用与 Magpie 相同含义的终端 `>_` 图标，与常规的设置齿轮区分。
- 保存协议、默认模型和启用状态不再调用发现服务。原链路在保存后强制全量扫描，等待全部 CLI 版本查询与 ACP 握手；前端全局 busy 又让等待期间整页控件禁用。
- 当前保存直接原子持久化并更新对应行，只有该行短暂禁用；失败时回滚。启动命令/参数/环境变化时，后续只刷新对应 Agent；后台扫描不会覆盖期间保存的新配置。
- Claude Desktop、VS Code、Zed、WorkBuddy 等只有应用包、没有 CLI/ACP 执行入口的项目不进入列表。Codex/dsh 等可驱动 Agent 的 App 版本仍作为附属信息保留。
- 临时配置进行 20 次 WeCode Claude 协议交替切换，后端平均 0.39ms、最大 1.67ms，外部进程启动次数为 0；该数值不包含 Electron IPC 与页面渲染。
- 类型检查、构建、40 项相关单测和 5 项页面测试通过；覆盖挂起的发现不阻塞保存、当前行独立等待、失败回滚、定向重扫、扫描/配置并发及纯 App 过滤。


## Antigravity CLI 模型列表修复

- 原模型查询仅接入 CodeBuddy/OpenCode，遗漏了 `agy models`。现在按当前启动命令、参数和环境执行该命令，解析制表符分隔的模型 ID/显示名称，忽略进度文本和 ANSI 控制符并去重。
- 模型查询优先使用已发现的 Agent，不等待全量扫描。单次命令上限 30 秒，失败不会自动连续重试；成功且非空的目录在页面缓存 5 分钟，默认模型变更不影响目录缓存，空目录可以重新打开重试。
- 真实本机命令经 Buddy 查询代码成功返回 6 个模型，耗时约 9.3 秒，包含 Gemini 3.8 Flash 的 High/Medium/Low、Claude Sonnet 4.6、Claude Opus 4.6、GPT-OSS 120B。该验证只查询目录，没有运行生成任务。
- 最新定向验证：类型检查、构建、42 项相关单测和 6 项 Playwright 页面测试通过。新增测试覆盖实际输出解析、启动参数/环境、使用缓存 Agent 避免重扫、模型名称展示和对应 ID 的保存；页面测试使用隔离夹具，真实目录另经上述主进程服务路径验证。


## Kimi Code 原生模型列表与 ACP 修复

- 当前本机安装是 `~/.kimi-code/bin/kimi` 2.4.0。`kimi --help` 明确列出 `acp`；通过 Buddy 的 `AcpClient`/stdio transport 真实握手返回 protocolVersion=1、agentInfo.version=2.4.0，耗时约 570ms。历史版本检查和旧的“Kimi 不支持 ACP”提示不能代表当前能力，旧提示已移除。
- 扫描实际读取 Kimi 的帮助，识别 `acp` 子命令或 `--acp` 参数后才构造候选，再以当前启动参数和环境执行握手。未声明入口或帮助查询失败时保留 CLI；用户已有配置及默认协议不被自动覆盖。
- CLI 模型通过只读命令 `kimi provider list --json` 获取当前原生已配置的别名表，使用 `display_name` 或别名显示；`--model` 使用别名键，不能替换成提供商的上游模型名。仅传出模型 ID/名称，输出中的 providers/API key 不传给页面；无效输出的错误也不回显原文。
- 当前本机原生目录包含 `kimi-k2-6` 和 `kimi-k2-5`（分别映射上游 `moonshot-kimi-k2.6` / `moonshot-kimi-k2.5`）。修改后的 `AgentManagementService` 在临时 Buddy 数据目录中实际发现 ACP、验证握手、查询两个模型并保存 ACP 配置成功；模型查询约 349ms（含临时配置保存），没有生成调用。
- 自动化覆盖帮助候选识别、缺失/失败降级、真实临时 stdio 握手、原生模型别名解析、凭据字段隔离、启动参数/环境、协议保存和 CLI 模型参数传递。定向类型检查、构建、68 项相关单测和 7 项 Playwright 页面测试通过，覆盖协议切换与独立默认模型保留。
- 依据：[官方快速参考](https://www.kimi.ai/zh-hans/academy/kimi-code-cheat-sheet)、[kimi acp 文档](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html)、[kimi provider list 文档](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/kimi-command.md#kimi-provider-list)。只读取本机已配置模型，不导入公共目录、不添加提供商、不启动 Web 服务。

## 2026-10-29 行内高级、JSON 编辑和原生能力修正

- 高级区域仅保留安装位置、启动命令、参数、环境变量；协议、模型、任务启用继续使用主行控件。参数和环境变量支持 JSON 着色、格式化及独立实时校验，无效输入禁止保存。移除单 Agent 超时及添加自定义入口。
- 常规超时同步到 CLI/ACP 配置，保存高级配置、模型或切换协议不会恢复旧超时。
- Cursor 官方 ACP 启动方式是 `agent acp`：https://cursor.com/docs/cli/acp 。旧配置仅有 `cursor-agent` 命令、无 args 时，管理页曾漏补 `acp`，而 runner 会补，导致误报 10 秒 initialize 超时。现在统一参数回退规则。真实 `agent acp` / `cursor-agent acp` 均约 0.5 秒完成协议 1 握手；修正后的 AgentManagementService 同样验证通过。
- 真实 `cursor-agent models` 读取 36 个模型；保留真实 ID/名称，移除 current/default 标记和重复项，CLI 模型选择已接入。
- WeCode 必须使用 `wecode help`、`wecode codex help`、`wecode opencode help`；`--help` 被转发至内层 CLI。读取命令声明检测原生更新，已有包管理器的安装仍按原渠道更新。
- 本机 WeCode wrapper 为 4.0.39，Claude/Codex/OpenCode 内层分别为 2.1.159 / 0.164.0 / 1.19.4。根入口使用 `wecode upgrade` + `wecode version`；子入口使用 help 声明的 `wecode codex update` / `wecode opencode update`，以及各自 `--version` 复验。更新目标和版本不混用，去重按真实执行文件加子命令计算。
- 没有独立只读 latest 查询的原生渠道显示“检查并更新”（根 WeCode 显示“更新 WeCode”），不会把已支持更新误标成“发现新版本”；列表扫描/刷新不执行 upgrade/update。
- 本机验证仅执行帮助、版本、模型列表和 ACP initialize；实际升级流程使用临时安装树和受控执行器测试，没有升级用户的软件。

本轮验证：`pnpm typecheck`、`pnpm build` 通过；6 个相关单测文件共 41 项通过；Agent 页 Playwright 9 项通过（8 项页面回归及 1 项原生更新按钮检查）。UI 使用本地开发页和模拟后端，覆盖 1280×980、640×980、亮/暗主题、JSON 格式化与校验、安装切换、协议/模型切换及保存失败回退；Cursor/WeCode 能力另用本机真实命令只读复验。未执行完整仓库 E2E 或实际 Agent 升级。


## 2026-10-29：库存缓存与后台更新批次

库存读取改为恢复磁盘/内存快照；进入设置或新建任务不会扫描。启动按新鲜度后台发现，手动刷新可选择仅安装扫描或仅版本检查。高级配置只使相关目标失效，普通发现保留同一安装的版本检查结果，刷新不清空未保存输入。

更新由主进程持久队列管理；立即返回批次，跨页面及 macOS 关窗继续执行。活动进度与“最后更新记录”分区，支持取消剩余、重试失败项、全局状态、完成通知、正常退出协调及中断恢复。安装子进程在身份持久化后才开始实际修改，重试先排除存活的旧进程。WeCode 包装器与内层更新仍使用各自的原生命令和版本。

相关单测 43 项、页面 E2E 10 项、类型检查与构建通过；独立 Electron 数据目录中的临时 CLI 验证了关窗续跑、重启恢复和退出等待。未更新用户的真实 Agent。全量测试仍有任务服务清理 `kill EPERM` 的既有失败，未修改的 HEAD 快照也可复现。完整范围及验证边界见 `docs/plans/2026-10-29-agent-update-background-jobs-proposal.md` 第 9 节。
