# Agent 发现能力扩充：Magpie 差异分析与实施方案

日期：2026-11-02。状态：P0–P3 声明式目录已落地（含 ACP 优先规则与发现-only 行）；本机缺安装产品保持「已声明、未实测」；Gemini 原生 CLI / App 包内 CLI 仍待续。

## 1. 结论与比较口径

Buddy 的差距包含产品目录较小、安装入口覆盖不足、发现结果与执行能力衔接不完整三个方面。建议先完善发现与能力模型，再分批增加 Agent。

本次基线：

- Buddy 当前源码：v2.0.10，`f28cf80`，分析开始时工作区干净。
- Magpie 本地源码：`1a85394329e9b87bc3f2ba3669578b10c635bc6c`（2026-10-29）。
- 为避免比较旧名单，又读取了 Magpie 上游 2026-11-02 的 `066ece93bbb7c85a634bd565aae4377678ad8580`，以该提交的 `onMachine` 为目录基线。
- 没有启动 Magpie 网关、修改 Agent 配置、执行更新或发送生成请求。以下新 Agent 的协议路线是官方文档支持的接入建议，不是 Buddy 已通过实测的声明。

| 比较项 | Buddy 当前源码 | Magpie 上游基线 |
| --- | --- | --- |
| 固定目录 | 16 个 recipe，其中 12 个有命令、4 个仅 App | `onMachine` 有 71 个固定注册调用，另有动态 profile、WSL 和插件 |
| 有命令的目录 | 9 个产品家族 + 3 个 WeCode 包装入口 | 包含 CLI、桌面应用、IDE 插件、其他代理/客户端，不能直接换算为可执行 Actor 数 |
| 原生 CLI 执行适配 | 8 类：Claude、Codex、Cursor、Antigravity CLI、OpenCode、Kimi、dsh、CodeBuddy；WeCode 复用对应适配 | 主要能力是识别客户端、修改其原生配置、接入网关；不等于完成 Buddy 的两轮协作适配 |
| 扩展来源 | 内置 recipe；后端还能读取额外 launcher 配置，没有新增自定义 Agent 的界面入口 | 内置目录 + Agent 插件 + 部分产品的动态实例 |

Buddy 的 12 个命令入口是：Claude Code、Codex、Cursor CLI、Antigravity CLI、OpenCode、Kimi Code、DeepSeek Harness、CodeBuddy、Gemini CLI、WeCode Claude、WeCode Codex、WeCode OpenCode。

纯 App 的四个 recipe 是 Claude Desktop、Zed、VS Code、WorkBuddy，目前被扫描逻辑排除。继续保持“具备 CLI/ACP 执行入口才进入 Agent 列表”的现有范围；App 内确有可驱动 CLI 时，应作为该产品的安装候选，而不是仅凭 App 存在就宣称可运行。

来源：[Buddy 目录](../../src/shared/agents.ts)、[CLI 分派](../../src/main/buddy/launchers.ts)、[Magpie 上游目录](https://github.com/yetone/magpie/blob/066ece93bbb7c85a634bd565aae4377678ad8580/internal/agent/agents.go)、[Magpie 插件接入](https://github.com/yetone/magpie/blob/066ece93bbb7c85a634bd565aae4377678ad8580/internal/agent/plugged.go)。

## 2. 具体缺哪些

### 2.1 优先补齐的执行型产品

下表中的优先级按接入路径清晰度、能否复用 Buddy 的 ACP、以及协作编码用途划分，不代表用户当前已安装或登录。

| 优先级 | Agent | Buddy 当前缺口 | 建议路线 |
| --- | --- | --- | --- |
| P0 | Gemini CLI | 有 recipe、模型参数、ACP 候选，但没有原生 CLI adapter | 先让 ACP 可用时正确成为默认；原生 CLI 单独补齐，不能落入 contract |
| P1 | Qwen Code（`qwen`） | 无发现规则、无原生适配 | 优先 `qwen --acp`；需要 CLI 时再接 headless/stream-json |
| P1 | GitHub Copilot CLI（`copilot`） | 无发现规则、无原生适配 | 优先 `copilot --acp --stdio`；与 VS Code/JetBrains Copilot 区分 |
| P1 | Goose（`goose`） | 无发现规则、无原生适配 | 优先验证官方 ACP server；CLI 是另一个独立能力 |
| P1 | Factory Droid（`droid`） | 无发现规则、无原生适配 | 官方 exec 已列出 ACP 输出模式，先验证其兼容性；可保留 `droid exec` 结构化输出路线 |
| P2 | Pi、oh-my-pi/omp | 无发现规则、无原生适配 | 分别核验 JSON/RPC/headless 与会话恢复，不能因同源就共享所有参数 |
| P2 | Cline CLI、Crush | 无发现规则、无原生适配 | 先补安装发现，再依本机版本核验 ACP 或非交互模式 |
| P2 | Qoder、Qoder CN | 无发现规则、无原生适配 | 分别识别 `qodercli` / `qoderclicn`、账号/配置目录；再适配执行 |
| P2 | Hermes Agent | 无发现规则、无原生适配 | 核验 headless、会话与权限交互，再接入协作任务 |
| P3 | MiMo Code、DevEco Code、StepCode、MiniMax Code | 无发现规则、无原生适配 | 按实际需求与本机安装情况推进；分别验证产品身份及 CLI 协议 |
| P3 | Command Code、Grok Build、AtomCode、Snow CLI、jcode、Devin | 无发现规则、无原生适配 | 先收集明确安装证据，按产品实现适配；通用命令名不能直接证明身份 |
| P3 | MothX、PenguinHarness、OmO、Prime Agent、Empryo、Ante | 无发现规则、无原生适配 | 纳入扩展目录；确认执行协议后再开放任务使用 |

官方协议依据：

- [Qwen 架构](https://qwenlm.github.io/qwen-code-docs/en/developers/architecture/)明确提供 `qwen --acp`；[headless 文档](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/headless.md)列出非交互、结构化输出与会话恢复。
- [Copilot ACP 文档](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)给出 stdio 入口，当前仍标记 public preview，能力需按安装版本检测。
- [Goose 官方站](https://block.github.io/goose/)明确可作为 ACP server；具体命令和兼容性由实施时的本机帮助及握手确认。
- [Droid Exec 文档](https://docs.factory.com/droid-exec/overview)列出 `acp`、JSON/stream-json、模型与会话参数；不能仅据文档就标记本机支持。

### 2.2 Magpie 有条目，但不应直接变成 Buddy Actor 的部分

除上表和 Buddy 已有产品家族，Magpie 固定目录还包括以下条目。这里列的是发现范围差异，不是断言这些产品永远没有可执行接口。

| 类型/处理方向 | 条目 |
| --- | --- |
| Buddy 已保留 App recipe、当前排除纯 App | Claude Desktop、Zed、VS Code、WorkBuddy |
| 其他桌面/IDE/应用集成，需另证执行入口 | Claude Science、Antigravity 桌面端、OpenChamber、Aside、Cursor 桌面端、VS Code Insiders、VSCodium、ZooCode、Copilot JetBrains、JetBrains Air、Reasonix Studio、Muse、Grok App、ZCode、WorkBuddy AI、Pencil、OpenPencil、NewMax、Raycast、Kiro Crew、T3 Code、OpenHanako、Alma、Cindy、AionUi、Lody |
| 用途更广、需要独立评估任务生命周期 | fx、Mister Morph、AstrBot、QwenPaw、OpenClaw、OpenBot |

不通过增加纯桌面条目来扩大“可用 Agent 数”。如后续需要软件资产视图，可另行设计；不改变当前任务选择器语义。

Magpie 的 `Detected()` 允许配置文件、合适的配置目录、产品特有标记或二进制证明“已安装或已配置”；它也排除一些仅由 skills 安装器制造的残留。Buddy 应借鉴证据采集，但配置存在只能作为线索，不能直接作为可执行证据。参考：[本地检测实现](../../../magpie/internal/agent/agent.go)。

## 3. 发现机制差在哪里

### 3.1 Buddy 已具备的部分

- `fixShellPath()` 在主进程启动时读取用户登录/交互 shell 的 PATH 和代理变量。
- 有 `~/bin`、现有 `~/.*/bin`、Homebrew 等回退目录。
- 有库存磁盘缓存、后台刷新、四项一批的并发扫描、多安装基础展示、版本/更新渠道识别、ACP 探测。
- 动态 Actor ID、`RUNNING_AGENT`、通用会话映射已经存在，无需为每个新产品增加一个任务状态。

因此本轮不是重新做 PATH 修复、缓存或整个执行引擎。

### 3.2 需要补的发现能力

| 差距 | 当前实现与后果 | 改进 |
| --- | --- | --- |
| 产品规则不足 | 没有 recipe 的产品，通常不会被主动发现 | 扩展可维护的声明式产品目录 |
| 深层安装目录 | 当前通用回退仅覆盖一层隐藏目录下的 `bin`；nvm/fnm/mise 多版本、asdf shims、pnpm 深层目录等依赖 shell PATH 是否已经包含 | 有界读取已知安装布局；区分 shell 当前默认与其他候选 |
| 自定义 npm prefix | PATH 未包含时不会主动解析 prefix 布局 | 读取 prefix 配置或受限包管理器查询，只提取路径信息 |
| App 内 CLI | 目前读取 App 版本，没有统一提取应用包内 CLI | 为已知产品配置 bundle ID/允许的相对路径，验证可执行身份 |
| 多安装枚举不一致 | 首选 `find()` 含回退目录与 aliases，但 `installations` 仅遍历 PATH 中的主命令 | 首选和全部候选使用同一个收集器，统一去重 |
| wrapper/shim | `realpath` 不能解开版本管理器脚本 | 为已知管理器做受限解析，保留入口路径、实际目标与 runtime；不执行任意包装脚本来猜身份 |
| ACP adapter 单独安装 | 目前部分 recipe 会在寻找 adapter 前因为主 CLI 缺失而提前返回 | CLI 与 adapter 候选分别采集，再判断依赖是否齐全 |
| 刷新环境 | 手动刷新重扫库存，但未重新读取启动后变化的登录 shell PATH | 显式刷新可更新路径快照；UI 仍先显示缓存 |
| 原生配置目录环境 | shell 修复主要传回 PATH/代理；不等于所有 Agent 的配置目录变量都已取得 | 按产品白名单读取目录变量，保留原生路径与 Buddy 隔离规则 |

Magpie 可借鉴实现：[路径来源](https://github.com/yetone/magpie/blob/066ece93bbb7c85a634bd565aae4377678ad8580/internal/proc/path_other.go)、[路径缓存](../../../magpie/internal/proc/look.go)、[安装渠道识别](https://github.com/yetone/magpie/blob/066ece93bbb7c85a634bd565aae4377678ad8580/internal/agent/cliupdate.go)。注意它的 `UserBinDirs()` 与 macOS 实际调用链也有边界，不能简单宣称每条目录在每种发现路径都被扫描。

### 3.3 扩大目录前应解决的能力衔接问题

1. **Gemini 落入 contract。** `AGENT_RECIPES` 有 Gemini，但 `commandKindFor()` 没有 Gemini 分支。不能把“支持 `--model`”等同于已有原生任务协议。
2. **任务可用性未按所选协议计算。** 设置页和 `App.tsx` 使用 `a.runnable || a.acpStatus === 'verified'`；默认协议又可能是 CLI。由代码推导：仅 ACP 可用的产品可能被放入任务选项，但仍选中无适配的 CLI；当前没有用实际 Gemini 任务复现。
3. **更新后验证依赖 CLI `runnable`。** `agents/updates.ts` 的校验会拒绝仅 ACP 可用的目标；新增 Agent 时必须一起调整。
4. **探测强度偏重。** 当前 `probeTarget()` 在 `initialize` 之后调用 `session/new`，不仅是握手。扩到几十项后，扫描成本和原生会话副作用也增加，应拆开安装发现、协议识别、认证/会话可用性验证。
5. **目录规则与执行适配分散。** 命令/模型参数在 recipe，命令类型在 launcher，ACP 参数回退及缓存又各有逻辑。新增产品不能只更新其中一处。
6. **命令别名存在断层。** launcher 识别 CodeBuddy 的 `cbc`，recipe 没有对应 alias。此次本机只读检查确认 `/opt/homebrew/bin/cbc` 指向 `@tencent-ai/codebuddy-code/bin/codebuddy`；应以包身份验证别名，避免误认同名程序。

本机默认 Buddy 库存缓存时间为 2026-11-02 13:45:40（北京时间），包含 11 行，不含 Gemini；缓存中部分协议失败，不能视为 11 个全部就绪。对本次候选在当前 shell PATH 与常见用户 bin 目录的有限检查，没有找到 Qwen/Copilot/Goose/Droid 等入口。这不是全盘安装审计，也不能据此断言机器上绝对没有这些产品。因此不能承诺扩充后本机立即新增几十个可用 Agent。

## 4. 推荐设计

### 4.1 分开产品规则、安装事实和运行能力

建议保留现有 Actor ID，逐步将数据职责拆成：

- **AgentDefinition**：产品 ID/名称、主命令与 aliases、包身份、已知安装布局、可用的 CLI adapter、ACP 候选规则、模型与更新规则。
- **AgentInstallation**：入口路径、真实目标、runtime、安装来源、包名、版本、发现证据；支持多个安装候选。
- **AgentRuntimeCapability**：按安装和协议分别记录 adapter 是否支持、协议版本、认证状态、会话能力、验证时间及错误。

不能只增加一个更复杂的 `runnable` 布尔值。至少区分：已发现、版本读取失败、执行方式尚未适配、缺 adapter、协议不兼容、待登录、可用。任务选择器统一调用按 `selectedProtocol` 判断的函数。

新发现项目：有已支持且可运行的 CLI 则默认 CLI；只有 ACP 通过则默认 ACP；没有就绪入口则展示原因，不允许成为可执行任务选项。已有协议选择保持不变，失败时提示修复，不静默切换身份或安装。

### 4.2 统一候选收集

推荐优先顺序：用户显式选择 → 登录 shell 当前解析入口 → PATH 其他入口 → 已知用户安装目录 → 版本管理器其他安装 → 已知 App 内 CLI。

- 只有候选集合扩大，不把所有 Node 版本同时塞进全局 PATH。
- 对同一真实目标去重，同时保留包装器语义；WeCode 三个子入口不能只因共用一个可执行文件就合并。
- 安装来源未知时允许发现/使用，但不猜测更新命令。
- 包名、帮助签名、bundle ID 等用于验证身份，尤其 `agent`、`step`、`grok`、`cbc` 等通用名称。
- 拒绝空 PATH 项引入当前目录误匹配；残留配置、失效符号链接、仅有 skills 的目录不能成为可用安装。

### 4.3 执行接入以 ACP 为优先路线

有标准 ACP 的产品先复用现有 transport/client、权限交互、输出与双轮逻辑，按实际协议版本验证。不要把任何陌生 CLI 自动认作 Buddy contract，也不要假定所有 ACP 都使用 `acp` 子命令。

没有合适 ACP 的产品，通过明确的 native adapter 提供：prompt 输入、输出归一化、完成/错误判定、模型参数、会话恢复、取消与超时。相同 JSON 格式可以共享解析器，但产品参数与完成语义独立验证。

模型目录与更新是可选能力：未实现模型枚举不妨碍发现；允许原生默认或经核实的模型 ID。更新能力仅在安装来源和实际目标都可验证时开放。

### 4.4 扫描与验证分层

1. 快速发现：文件/包身份/已知版本命令，尽早更新列表。
2. 能力探测：读取帮助、受限 ACP initialize，独立缓存。
3. 会话验证：首次选择、显式测试或任务启动时验证登录/模型/会话；避免每次扫描都创建原生会话。
4. 用已有并发限制与租约，增加总预算、逐项结果发布和失败缓存；缓存指纹含目录规则版本、路径/文件变化、启动参数与相关环境摘要。

不自动下载缺失 adapter，不扫描时运行 `npx -y` 安装，不自动更新 Agent。缓存仍采用 `.tmp` → rename；schema 放在现有 `schemas.ts`。

### 4.5 界面范围

保留现在的紧凑列表和高级编辑。新增产品自然使用相同行组件，图标优先现有资源或 lucide-react，文本走三语言 i18n。

主行说明当前协议是否就绪；高级区域给出安装路径、来源、其他候选和无法使用的原因。未安装的整个目录不自动铺满列表。此方案不恢复此前移除的“添加自定义 Agent”入口；如需要第三方 recipe 导入，可作为单独的后续需求。

## 5. 实施顺序与改动范围

| 阶段 | 交付 | 主要涉及文件 |
| --- | --- | --- |
| P0：基础修正 | 统一协议可用性、Gemini 默认方式、ACP-only 更新校验、别名和多安装收集一致性 | `src/shared/agents.ts`、`agents/service.ts`、`agents/updates.ts`、`App.tsx`、`AgentsSettings.tsx`、相关 schema |
| P1：核心扩充 | Qwen、Copilot、Goose、Droid 的发现与经验证的 ACP；完善路径来源/安装身份；必要的 Gemini CLI 适配 | 新增 `agents/discovery.ts`、`agents/definitions.ts` 或等价模块；复用 `shell-path.ts`、`acp/`、`launchers.ts` |
| P2：第二批 | Pi、omp、Cline、Crush、Qoder 双版本、Hermes；每个产品独立完成能力验收 | 产品规则、协议/native adapter、输出解析、模型服务 |
| P3：持续扩展 | 按用户实际安装推进其他产品；完善声明式 recipe schema，评估受控导入 | 目录与适配模块，不扩散至任务状态机 |

第一批完成后的固定命令入口目标为 **12 → 16**，新增 4 个产品，并修正已有 Gemini 的能力衔接。这个目标衡量已实现规则，不代表本机发现数，更不代表所有安装版本均可用。Gemini 原生 CLI 如与 ACP 首批交付拆分，应明确标为后续工作，不能将 ACP 接入当作 CLI 已实现。

保留旧任务 Actor ID、会话、launcher、默认模型与更新队列。新增定义和 schema 使用兼容迁移；不会因为新规则覆盖用户已保存命令，也不会重置 Codex 的现有隔离目录。

## 6. 验收条件

- 发现：临时目录覆盖 Finder 精简 PATH、shell 超时、nvm/fnm/mise/asdf/pnpm、npm prefix、多安装、别名、wrapper、App 内 CLI、断链、同名非 Agent、配置残留。
- 能力：CLI-only、ACP-only、两者都有、缺 adapter、版本读取失败、待登录、不兼容分别呈现；任务列表与当前协议一致。
- 执行：每个首批新增产品至少验证两轮、会话恢复、dual-break、取消、超时、错误输出、默认模型及显式模型。协议握手成功不能替代执行验收。
- 更新：验证真实安装归属、共享包/包装器去重、ACP-only 校验；测试使用隔离安装或假执行器，不升级用户工作机软件。
- 性能：新目录不能阻塞进入设置/新建任务；扫描分批可见，失败不会使整页不可用。
- 回归：定向单测、类型检查、构建和 Agent/新建任务页面 E2E；必要时全量回归并区分既有问题。
- 本机验收记录必须区分“声明支持”“发现安装”“协议通过”“实际生成通过”；缺少安装或账号的产品保留未验证标记。

建议先落地 P0 + P1，拿到真实新增产品的完整任务闭环后再扩第二批。当前文档完成只代表分析与方案完成。
