# 扩展能力基线

日期：2026-10-28。本机对照已经跑过。Buddy 的发现仍是文件扫描，不是原生列表。对照结果不一致的项不能写成已支持。

## 对照环境

工作目录是本仓库。用户目录是当前登录用户的 home。Buddy 扫描用的是临时 dataRoot 和默认 Launcher，没有创建 Codex ACP 私有目录，也没有调用会建目录的初始化。

| 程序 | 版本 | 路径 |
| --- | --- | --- |
| Claude Code | 2.1.159 | `/Users/david/.local/bin/claude` |
| Codex CLI | 0.164.0 | `/opt/homebrew/bin/codex` |
| OpenCode | 1.19.4 | `/opt/homebrew/bin/opencode` |

页面上的版本仍显示「未探测」。上表是这次手工执行的版本，不是资源库页面自己读出来的。

用过的只读命令：`claude mcp list`、`claude plugin list`、`codex mcp list`、`codex plugin list`、`opencode mcp list`，以及一次 `codex app-server` 的 `skills/list`。进程在拿到结果后已结束。这些命令不是 Buddy 页面的刷新路径。`claude mcp list` 对已批准的服务器会做健康检查；这次它直接返回没有配置 MCP。

## 本机对照

### Claude MCP

`claude mcp list`：没有配置 MCP 服务器。同一工作目录下，Buddy 对 claude 的文件扫描状态是 empty，条目是 0。这一项对得上。空清单和读取失败不是同一种状态。

### Claude 插件和技能

Claude 2.1.159 没有 `skills list` 子命令。原生能对上的是 `claude plugin list`。

已安装 9 个插件。启用：code-review、commit-commands、feature-dev、frontend-design、hookify。禁用：clangd-lsp、codex、两份 superpowers。

Buddy 文件扫描没有插件启用状态。它在插件目录里找到一份用户技能 `weekly-report-mail-summary`，以及多份插件技能。superpowers 的技能出现了两份，对应两个安装来源。codex 插件在原生列表里是禁用的，文件扫描仍然列出了它带的技能。所以 Claude 技能扫描不能当成原生插件列表。

### Codex MCP

`codex mcp list` 有 4 项：`codex_app` 禁用，`computer-use` 禁用，`cua_repl` 启用，`node_repl` 启用。环境变量值已被 CLI 打成星号，这里不记录值。

`~/.codex/config.toml` 里的 MCP 表只有 `mcp_servers.node_repl` 和 `mcp_servers.computer-use`。Buddy 文件扫描正好扫到这两项，没有把参数吞掉。另外两项不在这个表里，来自已安装插件，扫描看不到。扫描也不知道启用还是禁用，所以禁用的 `computer-use` 仍显示为普通用户配置。

### Codex 技能

`codex app-server` 的 `initialize` 返回 userAgent `buddy-baseline/0.164.0`，codexHome 是 `~/.codex`。接着 `skills/list`，cwd 为本仓库，errors 为 0，返回 13 项，且都带 enabled：

- 插件：documents:documents、pdf:pdf、presentations:Presentations、spreadsheets:Spreadsheets、spreadsheets:excel-live-control、template-creator:template-creator、visualize:visualize
- 用户：weekly-report-mail-summary，路径在 `~/.claude/skills/weekly-report-mail-summary`
- 系统：imagegen、openai-docs、review-agent、skill-creator、skill-installer，路径在 `~/.codex/skills/.system`

同一 cwd 下，Buddy 对 codex 只扫到 1 项：`~/.agents/skills/weekly-report-mail-summary`。它是指向 `~/.config/magpie/library/skills/weekly-report-mail-summary` 的链接，和原生列表里的 Claude 路径不是同一个路径。

漏掉的原因已经对上代码：技能遍历会跳过点号开头的目录，所以 `.system` 进不去；插件缓存 `~/.codex/plugins/cache` 也不在扫描根里。`config.toml` 里还有 14 条 `[[skills.config]]`，名字都是 `superpowers:*`，enabled 都是 false。原生 `skills/list` 没有返回它们。文件扫描也没看见，是因为根本没扫那些目录，不是因为已经识别了禁用。

`codex plugin list` 能列出已安装插件和启用状态，其中包含上面的 documents、pdf、spreadsheets、presentations、template-creator、visualize，以及 browser、chrome、computer-use、codex-app-tools、unified-computer-use。Buddy 没有接这个列表。官方 app-server 的 plugin 写接口仍不作为生产能力；这次只读了 CLI 的 `plugin list`。

### OpenCode MCP

在本仓库执行 `opencode mcp list`，得到 3 个已连接的远程服务器：websearch、context7、grep_app。不记录 URL。

`~/.config/opencode/opencode.json` 的顶层键是 schema、model、plugin、provider，没有 mcp 或 mcpServers。plugin 只有 `oh-my-openagent@latest`。Buddy 只解析 mcp / mcpServers，所以 opencode 的扫描状态是 empty。这不是「0 个扩展」的原生事实，是扫描没读到原生列表。

OpenCode 1.19.4 的帮助里没有技能列表子命令。文件扫描只看到共享目录里的 weekly-report 链接。没有原生技能列表可逐项对齐。

### WeCode

默认 Launcher 下，wecode_claude、wecode_codex、wecode_opencode 的文件扫描和对应的 Claude、Codex、OpenCode 桌面目录结果相同。这只说明当前默认命令走到了同族路径，不是三个变体各自的原生列表。

## 已落地

- 目标解析看启动命令、参数、protocol、HOME、CODEX_HOME、CLAUDE_CONFIG_DIR、XDG_CONFIG_HOME。任务 Launcher 覆盖全局 Launcher。
- Codex / WeCode Codex 的 ACP 在没有单独设置 CODEX_HOME 时，有效目录是 dataRoot 下的私有 codex-home。只读页面不会创建它，也不会把桌面 `~/.codex` 算成这个 ACP 目标已加载的技能。
- 认不出的命令不带猜测目录。Cursor、Antigravity、Kimi、dsh 仍是「发现尚未验证」。
- 空清单、未初始化、读取失败分开表示。
- 资源库文件在 dataRoot/extensions/library.json。缺文件、空文件、读失败是三种状态。
- 普通技能目录可以迁入资源库并在原位置留下链接。已有外部链接只记录引用。行内分配只增删指向资源库的链接。MCP 条目可以按保存过的内容写入或撤回，配置文件用同目录临时文件再改名。
- 查找框接受绝对路径，或以 ~/ 开头、且这一层自己带有 SKILL.md 的文件夹。它不递归子目录。
- owner/repo、GitHub、GitLab 和其他 https Git 地址会用 `git clone` 的参数列表安装，不经过 shell。地址里的用户名、token、空格和 shell 符号会直接拒绝。克隆进临时目录，复制带 `SKILL.md` 的目录（含 scripts 等文件，不执行脚本）到资源库，记下仓库地址和 commit，然后删掉临时目录。同一个仓库和技能名再装一次不会再建一条。没有 `SKILL.md` 或克隆失败时不留内容目录。最多装 20 个技能，不会先弹出选择。装好后不会自动打开任何 Agent。
- 已经在某个 Agent 用户或项目技能根里的目录，导入时迁入资源库，并在原路径留下链接。不在这些根里的外部文件夹只记录引用，原目录保持原样。是否插件或系统技能，看已解析目标的技能根：插件根里的目录，以及技能根下 `.system` 里的目录，不导入。路径名字里出现 plugins 不会单独被拒绝。
- 行内 Agent 按钮按目标状态置灰。未初始化、不支持、未识别、读失败的目标不能点开。已经打开的仍可关掉。All 只改能接链接的目标。
- 软链失败返回 `symlink_failed`，不会改成直接复制。副本编辑同步（先回收最新编辑再备份）和原生 list 适配器还没接上。发现页仍是文件扫描。阶段 B 已按日常可用收口，这些项进阶段 C。

## 隔离目录里的 Codex 回读

没有改用户正在用的 `~/.codex` 或 `~/.claude`。临时 HOME 和 CODEX_HOME 都在系统临时目录，用的是本机 `/opt/homebrew/bin/codex`，版本 `codex-cli 0.164.0`。Buddy 的 ExtensionService 在这个临时 dataRoot 里做导入和分配，然后同一个 CODEX_HOME 启动 `codex app-server`，发 `initialize` 和 `skills/list`。进程在拿到结果后结束。临时目录随后删除。

技能目录名是 `code review`，带空格。`SKILL.md` 里的名字是 `buddy-readback-space`。

| 步骤 | 结果 |
| --- | --- |
| 导入 | `imported`。原目录变成指向资源库内容的链接 |
| 分配给 Codex | `assigned`。链接落在临时 `CODEX_HOME/skills/code review` |
| 分配后的 `skills/list` | 返回的 codexHome 就是这个临时目录。6 项里有 `buddy-readback-space` |
| 撤回 | `revoked`。只删了这条链接 |
| 撤回后的 `skills/list` | 同一临时 codexHome。5 项，没有 `buddy-readback-space` |

空的临时 CODEX_HOME 仍会列出 imagegen、openai-docs、review-agent、skill-creator、skill-installer。这是 CLI 自带的系统技能，不是用户桌面 `~/.codex` 里的插件技能。所以不能用固定数量当断言。这次能证明的是：打开分配后原生列表出现该名字，关掉后消失。

这次没有启动 Buddy 协作任务，也没有用 Claude 或 WeCode 做同样的回读。Claude 2.1.159 没有技能列表子命令，不能用 `claude --version` 代替加载检查。本机 `wecode --help` 和 Claude 一样，也没有技能列表子命令。

## 外部引用的 Codex 回读

另一次隔离实验没有使用桌面 `~/.codex`。外部目录 `outside/code review` 的 `SKILL.md` 名字是 `buddy-external-ref`。导入结果是 `referenced`。导入后和撤回后，这个目录都仍是普通目录，不是链接。

分配给显式 `CODEX_HOME` 的 Codex CLI 0.164.0 后，`skills/list` 返回的 codexHome 就是该临时目录，6 项里有 `buddy-external-ref`。撤回后剩 5 项，没有这个名字。空目录里的另外 5 项仍是 CLI 自带系统技能。

同一条资源再分配给 Codex ACP。私有 home 还不存在，结果是 `uninitialized`，`dataRoot/acp` 没有被创建。这次没有启动 ACP 会话，所以不能把 CLI 的 `skills/list` 说成 ACP 已经加载。

## 隔离会话里的技能目录

另一次实验仍使用临时 HOME、CODEX_HOME 和 dataRoot，没有读写桌面 `~/.codex`。Buddy 先把 `buddy-session-readback` 从临时 Codex 技能根导入资源库，原路径留下链接。然后用同一个 CODEX_HOME 运行 `codex debug prompt-input`。这是 Codex 0.164.0 生成的、模型看得见的会话上下文，不是再调一次 `skills/list`。

上下文里有这个技能的名字、描述，以及指向 `SKILL.md` 的文件位置。正文里的标记没有被写进这段上下文。跑完之后，原路径仍是指向资源库的链接，库里的那一条还在。输出里没有出现桌面 `~/.codex`。这条检查留在 `tests/unit/main/extensions-session-readback.test.ts`，本机有 `/opt/homebrew/bin/codex` 时会跑，没有这个二进制就跳过。

接着用 `codex exec --sandbox read-only --json` 在同一个隔离家目录里开过一轮。会话事件走到 `thread.started` 和 `turn.started`，随后模型接口返回 401，缺少登录凭证，回合以 `turn.failed` 结束。隔离目录里没有桌面那份登录状态。没有把 `~/.codex` 的认证文件复制进来，也没有改用桌面 CODEX_HOME，避免把一轮会话写进正在使用的家目录。所以这次不能说模型读到了技能正文。Buddy 自己的 Runner 用的是关闭沙箱的 `codex exec`，这次验证故意没有跟那组参数，也没有启动双 Actor 协作任务。

## 结论

阶段 A 的逐项对照仍然成立：只有 Claude MCP 的空列表和文件扫描对得上。Codex 技能 13 对 1，OpenCode MCP 3 对 0。文件扫描继续只作为有缺口的降级。

阶段 B 的链接分配，在隔离的 Codex CLI 上做过两次 `skills/list`：一次是迁入后的链接，一次是外部引用。打开后能看见，撤回后看不见，外部源目录没有被换成链接。资源库分配之后，`codex debug prompt-input` 会把该技能的名字和描述放进模型可见的会话上下文，但不会把正文内联进去。隔离家目录里的 `codex exec` 能建会话，但因为没有登录凭证而以 401 失败，不能当成模型已经读到技能。Codex ACP 未初始化时分配被拒绝，私有 home 没有被创建。Git 安装和 stdio MCP 握手已有本地测试。软链失败返回 `symlink_failed`，不改走副本。阶段 B 按日常可用收口。副本 takeEdits、Claude/WeCode 原生技能列表、ACP 会话加载，进入阶段 C。

## 阶段 C1：Cursor / agy / Kimi / dsh 只读解析

本机版本：`cursor-agent 2026.09.15-d2fe57e`、`agy 1.4.9`、`kimi 0.8.0`、`dsh 0.2.1-rc.2`。没有改桌面配置，也没有开放写入。

| Actor | 用户技能 / MCP 根 | 项目根 | 写入 |
| --- | --- | --- | --- |
| Cursor | `~/.cursor/skills`，产品目录 `~/.cursor/skills-cursor`（plugin/只读），`~/.cursor/mcp.json` | `.cursor/skills`，`.cursor/mcp.json` | 否 |
| agy | `~/.gemini/config/skills`，builtin `~/.gemini/antigravity-cli/builtin/skills`，`~/.gemini/config/mcp_config.json`（`mcpServers`） | `.gemini/skills`，`.agent/skills` | 否 |
| Kimi | `$KIMI_CODE_HOME/skills`（默认 `~/.kimi-code/skills`），共享 `~/.agents/skills`，`$KIMI_CODE_HOME/mcp.json` | `.kimi-code/skills`，`.agents/skills`，`.kimi-code/mcp.json` | 否 |
| dsh | 只记录 `$DSH_HOME/profiles`（默认 `~/.dsh/profiles`）为 execution_env；不猜技能目录 | 无 | 否 |

`discovery=filesystem`，`writesNativeConfig=false`。行内分配与从 Agent 导入都返回 `unsupported`，不会在这些目标上建链接。空的 `mcp_config.json` 当作没有服务器，不当成读失败。Kimi 若实际命令是 `opencode`，仍按 OpenCode 族解析（已有 `program_differs_from_actor`）。

## 阶段 C2：指令（Instructions）

资源库可新建/编辑指令正文（`content/instructions/<id>.md`）。分配到 Claude / Codex / OpenCode 时，在对应用户指令文件写入成对标记块：

`<!-- BEGIN BUDDY MANAGED INSTRUCTION: <uuid> -->` … `<!-- END BUDDY MANAGED INSTRUCTION: <uuid> -->`

| 目标 | 用户指令文件 | 写入 |
| --- | --- | --- |
| Claude | `~/.claude/CLAUDE.md`（可建空文件） | 是（`writesNativeConfig`） |
| Codex | `$CODEX_HOME/AGENTS.md` | 是；ACP 私有 home 未初始化仍阻断 |
| OpenCode | `~/.config/opencode/AGENTS.md` | 是 |
| Cursor / agy / Kimi / dsh | 无指令写入路径 | 否，`unsupported` |

单测覆盖：已有用户正文注入、多指令并存、撤回单条、用户原文保留、撤回后空文件收口。未整文件覆盖。

## 阶段 C2：子代理与 Hooks

| 类型 | 资源库 | 可写目标 | 所有权 |
| --- | --- | --- | --- |
| 子代理 | `content/subagents/<id>.md`（name/description/prompt） | Claude `agents/<name>.md`；Codex `agents/<name>.toml`；OpenCode `agents/<name>.md` | 绑定记录文件哈希；用户改过则拒绝删除（`changed_externally`）；同名非库文件不覆盖（`conflict`） |
| Hooks | `content/hooks/<id>.json`（event/command/matcher） | Claude `settings.json`；Codex `hooks.json` | 记录条目 canonical JSON；只删完全一致的条目；其他 hooks/顶层字段保留 |

可移植事件：`turn-end`→Stop、`after-tool`→PostToolUse、`before-tool`→PreToolUse、`prompt`→UserPromptSubmit、`session-start`→SessionStart。OpenCode 无 hooks 位置。Cursor/agy/kimi/dsh 仍 `writesNativeConfig=false`。

## 阶段 C3：技能副本与 takeEdits

对照 Magpie `skill_edits.go` / `skill_how.go`（c3b0484）：

| 能力 | 行为 |
| --- | --- |
| 标记 | 受管理副本含 `.buddy-library`（来源路径 + 内容哈希）；无标记目录不删不覆盖 |
| 分配 | `mode: 'copy'` 直接副本；默认先软链，`symlink_failed` 时回退受管理副本 |
| takeEdits | `action: sync` 或再次 copy 分配前：找比标记更新的副本，最新者若新于资源库则备份库内技能后镜像回收，落败副本 `set_aside` 进 backups |
| 熔断 | 任一副本 `changedAt` 读失败 → `read_failed`，不回收、不覆盖其他副本 |

插件入库仍未接（方案：独立入口；无稳定原生写接口前不做虚假安装按钮）。

## 阶段 D：发现与体验（首轮闭环）

| 能力 | 行为 |
| --- | --- |
| Found 只读 | `isImportableFoundInstance`；插件行「导入」与勾选禁用；`import_all` 自动排除只读行 |
| 技能精选 | `shared/skill-catalog.ts` 3 张；`save` + `buddy-catalog:<id>` 入库；不自动开 Agent |
| MCP 精选 | `shared/mcp-catalog.ts`：memory / filesystem / sqlite 模板；同路径入库；分配前用户可改路径 |
| 远程目录服务 / 内置编辑器 / 插件独立入口 | 明确后续；退出标准不依赖在线目录 |

Cursor / agy / Kimi / dsh 写入仍关闭。

## 2026-10-28 资源库审查修复

本节更新前文“副本同步未接入”等阶段记录。页面发现仍为文件扫描，不代表原生运行时完整清单或已加载能力。

- 目标识别补齐直接 `claude-agent-acp` / `codex-acp` 及绝对路径，与 npx 包装形式一致；覆盖 Claude/Codex 与 WeCode 两个变体。
- 库内技能/MCP 按类型过滤；移除请求在后端校验实体类型。已分配的受管理副本不再重复列入未导入资源。
- `skillDefaultMode` 和 `skillAgentModes` 保存默认及各 Agent 覆盖方式，缺省跟随资源库。旧库的已记录副本选择会保留。共享同一技能目录时，任一共享 Agent 要求副本则使用副本。
- 模式设置影响现有和未来分配；支持链接/副本双向转换。撤回、删除和转换前先回收副本编辑并备份；读取失败或目录被替换时保留现场。
- 通过 bootstrap 的一次初始化同步、导入后同步、显式同步入口完成生命周期；纯 discover/刷新不写文件。服务内变更串行，避免并发覆盖模式设置。
- 技能列表改为紧凑分组行，包含图标开关、筛选、排序、折叠、选择、批量开关、预览、默认分发条与按 Agent 面板。后续按用户明确要求直接使用 Magpie 原始 Agent 品牌图标；通用操作保留 lucide，来源与许可见 third-party.md。
- Git 技能支持检查更新、版本状态和整目录指纹。本地修改默认拒绝覆盖，明确确认替换后先备份，再以目录重命名更新；副本随后同步。检查只取仓库内容，不执行技能脚本。

回归用例位于 `extensions.test.ts` 的 library review regressions / library upstream updates，以及 renderer 的 `library-resource-list.test.tsx`。覆盖实际目录内容、模式形态、重启恢复、共享目录、错误类型删除、原生目标变化和上游修改保护。Playwright 以实际 ExtensionService 的隔离目录验证界面操作；不将该结果等同于已安装 Electron 或真实模型会话验收。
