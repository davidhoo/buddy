# Skills / MCP 从 Magpie 移植到 Buddy 的方案

日期：2026-11-02  
状态：方案草案（已吸收审查 4 项阻断收敛）；**本任务只新增本文档，不实现功能代码**。功能实现另开任务。

## 1. 目标与范围

在 Buddy 现有 Agent 菜单旁增加两个同级一级菜单：**Skills** 和 **MCP**。不增加“资源库”父菜单，不做二级菜单，也不做 Hooks。

两个页面沿用 Magpie 的列表布局、已有资源发现、导入、按 Agent 分配、编辑和移除交互。外层导航、主题和窗口框架使用 Buddy 的现有体系。

首期入口以本地已安装 Agent 的现有资源为主：

- Skills：发现 Agent 已有技能，导入 Buddy 管理，再按需分配给兼容的 Agent。
- MCP：发现 Agent 已有服务器配置，导入 Buddy 管理，再按需写入所选 Agent 的原生配置。
- 不做 Skills/MCP 市场、在线推荐、从远程仓库安装或在线更新。
- 不做 MCP Hub、网关、请求路由、共享服务进程、统一 OAuth 或凭据同步。
- 本期不扩展 Instructions、Subagents、RTK、云端同步。

这里将“各自维持、不共享”落实为：**MCP 运行和认证由各 Agent 自己负责**。保留 Magpie 的配置分配能力；将同一配置交给两个 Agent，不表示它们共享连接、进程、登录或访问令牌。

## 2. 已核对的代码基线

### Buddy

本地 `main`：`62731ef`，`package.json` 版本为 `2.0.12`。当前有 Agent 发现、安装库存、启动配置和更新管理，没有 Skills/MCP 资源库模块（工作区无 `src/main/buddy/library/`、无相关 IPC）。

- Agent 库存及启动配置：[agents/service.ts](../../src/main/buddy/agents/service.ts)、[shared/agents.ts](../../src/shared/agents.ts)。
- 菜单及页面：[Sidebar.tsx](../../src/renderer/components/Sidebar.tsx)、[SettingsContent.tsx](../../src/renderer/components/SettingsContent.tsx)、[App.tsx](../../src/renderer/App.tsx)。
  - 当前 `SettingsTab` 为 `'general' | 'agents' | 'appearance' | 'keyboard' | 'prompts'`；侧栏设置项顺序为 常规 → Agent → 外观 → 快捷键 → 提示词。实现时在 Agent 后插入 Skills、MCP 两个同级项，并扩展该联合类型与 `SettingsContent` 分支。
- Codex ACP 配置隔离：[codex-home.ts](../../src/main/buddy/acp/codex-home.ts)、[agent-catalog.ts](../../src/main/buddy/acp/agent-catalog.ts)。`prepareCodexHome` 首次复制 `config.toml` 等引导文件，并对 `skills`/`rules` 建符号链接到源 home；`codex` 与 `wecode_codex` 都会走该隔离 home。不能假设只改原生 `~/.codex/config.toml` 后 ACP 任务就拿到全部 MCP 变化；Skills 若已通过链接共用真实目录，则避免重复迁移。
- IPC：[buddy-handlers.ts](../../src/main/ipc/buddy-handlers.ts)。现有通道均为 `buddy:*`；资源库新增通道沿用此前缀，由 `BuddyCoreService` 组合，不挂到任务状态机。
- 许可先例：Agent 图标已有 [LICENSE.magpie](../../src/renderer/assets/agent-icons/LICENSE.magpie)。移植 Magpie 交互/样式/编辑逻辑时同样保留 MIT 与出处说明。

### Magpie

本地参考提交：`1a853943`（与同日 Agent 发现方案所用基线一致）。以下是已检查的源码行为，不是对 Buddy 当前功能的描述：

- [资源库设计](../../../magpie/docs/subsystems/library.md)。
- [页面与交互](../../../magpie/internal/gui/assets/plugins/library/client.js)：`renderSkills`、`renderServers`、发现列表、Agent chips、批量操作。
- [样式](../../../magpie/internal/gui/assets/plugins/library/library.css)：紧凑列表、工具栏、分组、弹窗及窄窗口布局。
- [Skills](../../../magpie/internal/library/skills.go)、[handover](../../../magpie/internal/library/skill_handover.go)：发现、同名差异、导入、链接/复制；`HandOver`/`HandBack` 迁入与写回。
- [MCP](../../../magpie/internal/library/mcp.go)、[导入与同步](../../../magpie/internal/library/sync.go)、[目标位置](../../../magpie/internal/library/targets.go)、[agent sign-in 探测](../../../magpie/internal/library/mcp_agent_signin.go)：原生配置读写；Claude Code 仅静态读 `.credentials.json` 是否存在 `mcpOAuth` 条目，不托管登录进程。
- [无损编辑](../../../magpie/internal/edit/)：约 51 个文件；`toml.go` ≈25KB，专用于保留注释/空行/未知字段的局部编辑。Node 生态的 `@iarna/toml` 等 stringify **会抹掉注释**，禁止用作写回路径。

实现采用 TypeScript/React，移植这些行为及测试场景，不嵌入 Magpie 的 Go 服务或整套插件运行时。复用的代码、样式、编辑语义需保留 Magpie MIT 许可及出处；界面图标遵循 Buddy 的 lucide-react 约定，复用已有 Agent 图标组件。

## 3. 菜单与页面

与现有 Agent 位于同一侧栏层级，顺序建议为：

```text
常规
Agent
Skills
MCP
外观
快捷键
提示词
```

Skills 和 MCP 各自有独立页面；页面内不再保留 Magpie 的资源类型切换标签。

### Skills 页面

```text
Skills                                  刷新  打开目录  备份

库内技能                    搜索 / 排序 / 分组 / 选择 / 按 Agent
名称、说明、来源                         Agent 图标开关  操作
名称、说明、来源                         Agent 图标开关  操作

Agent 中已有，尚未导入                         批量导入
名称、说明、来源 Agent、作用域                 导入  操作
```

- 保留 Magpie 的紧凑行列表、来源分组、排序、折叠、批量选择和 Agent 图标开关。
- 分组只使用已知本地来源，不为了分组请求远程仓库。
- 点击技能查看 `SKILL.md`、真实路径、来源、Agent 使用情况；支持打开目录。
- “按 Agent”查看该 Agent 获得了哪些技能，并执行兼容的批量分配操作。
- 顶部计数只统计库内条目；发现区另计数，避免把一个技能在多个 Agent 的副本重复算成多个库内技能。
- 移除 Magpie 的市场、在线安装卡片、检查远程更新等入口。
- 操作区必须提供 **解除管理（Eject）**，见第 5.2 节；不能只有“从库删除元数据”。

### MCP 页面

```text
MCP                                     刷新  打开目录  备份

库内服务器                              排序 / 选择 / 按 Agent
名称、命令或 URL、传输方式                 Agent 图标开关  操作

Agent 中已有，尚未导入
名称、配置摘要、来源 Agent、作用域          导入  操作
```

- 沿用 Magpie 的发现区、库内区、行内分配、编辑弹窗和批量操作。
- 首期由发现区导入已有服务器；编辑已导入项保留原生配置细节，不提供市场或远程安装入口。
- 展开服务器显示每个 **目标** 的配置位置、启用状态、认证状态（见第 6.2）、诊断结果及“如何登录”入口。
- 状态归属于具体目标/配置上下文，不能用服务器行上一个“已登录”代表所有目标。
- 去掉 MCP Hub、共享登录、OAuth 客户端统一配置和网关相关提示。

## 4. 发现：以实际 Agent 配置为依据

复用 Buddy 的 Agent 库存。资源管理不依赖“允许用于任务”的开关：已安装但暂未启用任务的 Agent，其资源仍可管理。纯桌面应用不因为资源功能而自动加入当前执行型 Agent 列表。

增加独立的资源适配器，逐项声明 Skills/MCP 的读取、写入、启停、认证探测及诊断能力。一个 Agent 可以支持 Skills 而暂不支持 MCP；界面分别给出原因。

发现范围：

1. 该 Agent 实际使用的用户级配置和技能目录，包括启动器环境变量覆盖的路径。
2. Buddy 已登记项目中的原生项目级配置，明确标记项目和作用域。
3. 原生 Agent 会读取的继承目录、共享 Skills 目录及插件提供的资源，分别标记来源和可管理范围。

不遍历整台机器寻找任意项目，不凭残留目录认定 Agent 已安装；未覆盖的原生来源要显示发现能力的限制，不能冒充完整清单。

### 4.1 目标身份与物理键

每个可操作对象是 **目标（Target）**：

```text
targetId = agentId + configContext + scope
physicalKey(skills) = realpath(skillsDir)
physicalKey(mcp)    = realpath(configFile) + 格式内服务器集合路径
```

- `configContext`：`native` | `buddy-acp` | `wecode-…` 等，与任务实际 home/profile 对齐。
- **相同 `physicalKey` 只写一次**；UI 列出所有受影响入口，但底层一次操作。
- **不同 `physicalKey` 不得合并**（典型：Codex 原生 `~/.codex/config.toml` vs Buddy ACP `dataRoot/acp/<actor>/codex-home/config.toml`）。

扫描只读，不启动 MCP 服务、不运行技能内容、不触发登录、不创建缺失的 ACP home。先显示缓存及扫描时间，再后台刷新；某个目录失败时保留其他结果，并显示“读取失败”，不能显示为“没有安装”。

## 5. Skills 导入和管理语义

按照 Magpie，**“导入”表示纳入管理，原 Agent 继续能用**，而不是仅保存一份看起来已安装的备份。

### 5.1 导入规则（含高危来源兜底）

| 来源 | 导入行为 |
| --- | --- |
| Agent 自有普通技能目录（普通文件夹，非 git 根、非符号链接） | 先备份；将完整技能目录迁入 `dataRoot/library/skills/`；原 Agent 位置改为指向库内的符号链接；目标不支持符号链接则改用复制模式并记录基线指纹 |
| 已有外部符号链接 | **禁止**跟随并搬走真实目录；库中记录链接与最终 `realpath`；管理入口挂在稳定引用上 |
| 目录本身是 git 仓库根（含 `.git`），或导入会拆散用户仓库布局 | **禁止 `mv` 迁入**；默认改为「原地引用 / 外部托管」或「复制进库、原目录不动」；必须在 UI 明示，由用户二选一 |
| 原生共享目录中的技能（如 `~/.agents/skills`） | 保留共享目录，记录引用及继承关系；原生继承的 Agent 显示为已获得、不可单独关闭 |
| 插件或应用内置技能 | 标记所属插件/应用，不迁走缓存或篡改包内容；首期不自动接管 |
| 同名、内容不同 | 展示差异来源，选择要导入的版本或另命名；不覆盖另一个 Agent 的不同版本 |

附加硬约束：

- 携带完整技能目录及相对资源，不能只复制 `SKILL.md`。
- 同一 `realpath` 及内容相同的副本可以聚合展示；名称相同不足以认定为同一个资源。
- 库内 Agent 图标开关控制实际链接/副本；对原生继承、未验证支持或只读来源提供明确状态。
- 延续 Magpie 的链接/复制选择。复制模式记录内容基线，识别 Agent 端修改；存在多个不同修改时提示冲突，不用刷新把用户改动覆盖掉。
- 批量导入逐项返回成功、已存在、冲突、失败、拒绝迁入（git/链接）；一个项目失败不抹掉其他成功结果。
- 迁移事务：备份 → 迁入库 → 验证库内完整 → 再替换原位置为链接；任一步失败必须回到“源目录仍可用”的状态，禁止留下“源已删且链接无效”。

### 5.2 解除管理（Eject）与卸载风险

必须区分三种删除，并在确认框列出实际路径影响：

| 操作 | 行为 |
| --- | --- |
| 从某目标移除 | 只去掉该目标上的链接/副本；库内资源与其它目标保留 |
| 删除库内资源 | 在无残留托管链接、或用户确认级联后，删除库内目录；第三方改过的内容按归属规则保留 |
| **解除管理（Eject）** | 对标 Magpie `HandBackSkill`：把库内物理目录安全写回原 Agent 路径（替换 Buddy 留下的符号链接为真实目录），更新/清除库元数据；原位置若已有用户新文件则报冲突并中止 |

硬性要求：

1. Eject 是一级操作，不是“删库记录”的附带效果。
2. 迁入前备份保留可手动恢复路径；备份目录对用户可“打开”。
3. 方案与日后实现说明中必须写明：若用户直接删除 Buddy 数据目录而不先 Eject，原 Agent 侧托管链接会变成死链。产品内在 Skills 页提供批量 Eject；不做静默“卸载钩子改用户家目录”以外的魔法。
4. 已卸载 Agent 的遗留管理记录可清理，不再向它添加资源；清理前若仍有指向库内的链接，先提示 Eject 或保留链接。

## 6. MCP 配置和登录语义

### 6.1 配置导入与分配

- 导入保存服务器定义及原始字段，并保留它原本所在目标的配置关系和作用域。
- 支持 stdio、HTTP/SSE 等配置表示；是否可分配由目标 Agent 实际能力决定。
- 同名、不同 command/args/URL/环境配置分别呈现差异，不按名称覆盖。
- 为另一个目标开启时，用该目标的格式写入独立配置；配置转换不能悄悄丢失字段。无法等价转换时说明原因并阻止该次分配。
- 项目级来源不能因导入自动提升为全局可用；目标选择需要明确作用域。
- MCP 的环境变量、API key、headers 保留原生引用；敏感值不进入普通库元数据、事件日志或普通页面响应。确需保存的值使用受保护本地存储，并按目标绑定，分配时不自动复制另一目标的凭据。
- 插件提供或应用动态注入的 MCP 标记为原生维护，避免修改后被应用重建、或离开原应用就不能运行。

### 6.2 登录与状态：两层能力，禁止虚构托管

对照 Magpie `mcp_agent_signin.go`：只对已知路径做**静态探测**，不后台拉起登录 CLI，不提供结构化进度，不提供“取消登录进程”。Codex / Cursor / Antigravity 等也没有可无头调用、返回进度的 MCP 登录子命令可依赖。Buddy **不做**“托管原生登录流程”。

| 目标示例 | 显示状态 | 页面动作 |
| --- | --- | --- |
| Claude Code 原生 | 静态探测到 `mcpOAuth` 条目 →「原生侧似已登录」；读不到/无条目 →「未探测到 / 请在 Agent 中确认」 | 「打开终端并提示原生操作」（如在对应配置目录打开终端，提示使用 Claude Code 的 `/mcp` 或设置页）；**不**由 Buddy 代跑登录 |
| Codex 原生 / Codex ACP | 无可靠静态接口 →「未知 / 请在 Agent 中确认」 | 打开对应 home/配置说明 + 操作指引；不假装能查到登录态 |
| 其它 Agent | 默认「未知」；仅当适配器登记了**已核实**的只读探测路径时才显示更具体标签 | 打开应用/终端 + 指引 |

硬约束：

- 允许：只读探测已知凭据文件是否**存在相关条目**（对标 Magpie）；**禁止**把 refresh token / access token 读入 Buddy 库或日志。
- 允许：`open -a Terminal`（或等价）到正确 cwd，或打开原生设置 UI；弹窗给准确步骤。
- **禁止**：后台 spawn 登录子进程、进度条、取消令牌、统一 OAuth、把 Buddy 模型账号登录扩展到 MCP。
- 没有可靠状态接口时显示「未知」，不能把“没读到文件”等同于“未登录”。
- 优先使用目标侧既有信息；Buddy 自己不带凭据的探测请求失败，不能据此判定 Agent 登录失效。
- 普通扫描不连接 MCP 服务。用户显式点「诊断」且会启动 stdio 时，动作文案必须说明，并按**单个目标**执行。

### 6.3 Codex 原生 vs Codex ACP / WeCode（闭环）

#### Skills：物理共用 → UI 合并联动

`prepareCodexHome` 默认把 `codex-home/skills` **符号链接**到源 `~/.codex/skills`（`wecode_codex` 同类）。此时：

- `physicalKey(skills)` 相同 → **一个逻辑 Skills 目标**，不是两个可独立开关的目标。
- UI：显示为「Codex（原生与 ACP 共用 skills）」或两个 chip **强制同开同关**，tooltip 写明改动会影响两侧。
- **禁止**在 UI 上假装关掉 ACP 而保留原生（或相反）——底层同一目录，做不到。
- 若将来某安装把 ACP skills 改成独立目录（非链接），`physicalKey` 不同后再拆成两个可独立开关的目标。

#### MCP：配置文件独立 → UI 分列

- 原生：`~/.codex/config.toml`（或 `CODEX_HOME` 覆盖）。
- ACP：`dataRoot/acp/<actor>/codex-home/config.toml`（首次引导后的**副本**，与原生不是同一文件）。
- 两个目标、两个 chip，状态与分配互不同步；不宣称“改原生会自动出现在 ACP”。

#### 未初始化 ACP home

| 阶段 | 行为 |
| --- | --- |
| 只读扫描 | **不创建** `codex-home`。列表可显示占位目标「Codex ACP（尚未初始化）」，标记为不可写入，说明“尚未创建 Buddy ACP home”。 |
| 首次向该目标分配 MCP / 需要写入时 | 调用专用的 **`ensureCodexAcpHome`（配置引导子集）**：`mkdir`、仅补齐缺失的 bootstrap 文件（`config.toml` / `AGENTS.md` 等）、对缺失的 `skills`/`rules` 建链接。**禁止**导入 session、禁止碰 SQLite 会话索引、禁止借配置页触发 ACP 握手。 |
| 与 `prepareCodexHome` 关系 | 可复用其无 `sessionId` 的文件系统部分，但配置页不得走“带 session 导入”分支。若复用时附带既有 `shareAuthFile` 行为，须在操作结果里对用户可见地记一笔（与任务侧一致的 auth 文件共享链接），不得暗含扩大到 MCP OAuth。 |
| Skills | 不因 MCP 引导再迁一次；已是共用 `realpath` 则只记账。 |

WeCode 其它入口按 [agent-catalog.ts](../../src/main/buddy/acp/agent-catalog.ts) 解析，不得假设与原生 Claude/OpenCode 共用同一 MCP 文件。任何变化都不合并会话目录或把模型账号认证共享扩展到 MCP。

## 7. 写入、归属和恢复

继承 Magpie 的关键规则：**只移除或覆盖仍能确认属于本次管理、且内容未被用户另行修改的条目**。

- 记录每次导入、写入、链接/复制、Eject 的目标、来源、原值和内容指纹。
- 变更前备份；解析失败的原生配置不写入。
- 库元数据 JSON 使用 `.tmp → rename`；Zod schema 放入 Buddy 现有 `schemas.ts`，读取时验证。
- 同一 `physicalKey` 的变更串行执行；写回前检查读取基线，遇到外部并发修改重新读取或报告冲突。
- 目录迁移和多目标写入有操作记录及恢复步骤；失败时不能留下已删除源目录却没有可用链接的状态。
- 已卸载 Agent 的遗留管理记录可清理，不再向它添加资源。

### 7.1 原生配置无损编辑（选型写死，禁止“实施时再定”）

Magpie `internal/edit` 已证明：Codex 的 `config.toml` 与各类 JSON/JSONC 必须走**局部编辑**，不能 parse → 全量 stringify。

| 格式 | 定死策略 | 禁止 |
| --- | --- | --- |
| JSONC / JSON（Cursor `mcp.json`、Claude 等） | 依赖 **`jsonc-parser`**：用 `modify` + `applyEdits` 按路径改键；保留注释、顺序与无关字段 | `JSON.parse` + `JSON.stringify` 整文件写回 |
| TOML（Codex `config.toml` 等） | 在 `src/main/buddy/library/edit/` **移植 Magpie `internal/edit` 的 TOML 局部编辑语义**（MIT 出处）；按表/键路径增删改 MCP 条目，保留注释、空行、未知键与非 MCP 段 | `@iarna/toml` / 其它“parse 再 dump”库作为写回路径；整文件模板重建 |
| 其它格式 | 适配器声明是否可写；不可无损写则只读发现，分配按钮禁用并说明原因 | 假装可写 |

验收：带注释与未知字段的夹具文件，写入一个 MCP 条目后，注释与无关键仍在；单元测试覆盖 JSONC 与 TOML。

## 8. 实现落点

```text
src/shared/library.ts                         资源、来源、目标、physicalKey、状态和操作结果
src/main/buddy/library/
  service.ts                                  用例、扫描、操作串行化
  store.ts                                    库元数据、归属、备份和恢复记录
  targets.ts                                  复用 Agent 库存，解析实际配置上下文
  discovery.ts                                发现与去重、快照
  skills.ts                                   导入、链接、复制、Eject、变更检测
  mcp.ts                                      原生配置导入、分配、字段转换
  native-auth.ts                              静态凭据探测 + 打开终端/指引（无托管登录）
  ensure-codex-acp-home.ts                    配置页用的 ACP home 引导子集
  edit/                                       移植 Magpie 编辑语义；TOML 局部写；JSONC 走 jsonc-parser
  adapters/                                   按 Agent/格式定义能力与读写
src/renderer/components/library/
  SkillsPage.tsx / McpPage.tsx                 两个独立页面
  ResourceRow.tsx / AgentChips.tsx             Magpie 对应交互；共用 physicalKey 联动
  ImportDialog.tsx / McpEditor.tsx             导入与编辑
src/renderer/hooks/useLibrary.ts               查询、刷新、变更状态
```

配套改动（不另起父菜单）：

- `SettingsTab`、侧栏设置项、`SettingsContent` 分支、i18n（zh-CN / zh-TW / en）。
- preload `window.buddy` 与 `buddy:library*` IPC（列表/刷新/导入/分配/编辑/移除/Eject/备份/打开指引/诊断）；推送事件走现有 `buddy:event`。
- 磁盘：`dataRoot/library/`（技能目录、元数据、备份）；元数据 JSON 一律 `.tmp → rename`。
- 依赖：实现任务中新增 `jsonc-parser`；TOML 以移植 Magpie edit 语义为主，不引入会丢注释的 stringify 库。

内部可以共用 library 模块，但用户界面没有资源库父菜单。由 `BuddyCoreService` 组合新服务，通过现有 `buddy:*` IPC、preload 和事件机制交互；不耦合到协作任务状态机。

## 9. 实施顺序与验收

以下是同一首期的交付步骤，不以只完成发现页面作为最终完成。

1. **目标识别与只读发现**：`targetId` + `physicalKey`；CLI/ACP/WeCode；Codex Skills 合并 / MCP 分列；未初始化 ACP 占位不建目录。
2. **无损编辑层**：`jsonc-parser` + `library/edit` TOML；夹具证明注释与未知字段保留。
3. **Skills 完整流程**：导入兜底（git/符号链接）、链接/复制、联动 chip、Eject 写回、冲突和备份恢复。
4. **MCP 完整流程**：发现导入、按目标写回、静态登录探测与打开指引（无托管登录）、ACP `ensureCodexAcpHome`。
5. **整体验收**：批量操作、缓存/后台刷新、外部改动、失败恢复、主题和窄窗口、中文/繁中/英文。

优先打通当前实际安装、配置路径可核验的 Agent；对其余已发现 Agent 按适配器逐个补齐。不能因为 Buddy 能执行某个 Agent，就自动宣称能完整管理它的 Skills/MCP。

验收需要证明：

- Skills、MCP 与 Agent 同级，界面没有资源库父级、Hooks、市场或网关入口。
- 导入前后原 Agent 的可用资源保持一致；分配后所选原生入口和 Buddy 任务实际可用。
- 原生共享、插件来源、同名不同内容、启用/禁用、项目作用域均可区分。
- Codex Skills 共用目录时 UI 联动；MCP 原生与 ACP 配置独立、互不同步。
- 未初始化 ACP home 在扫描期不落盘；首次 MCP 分配才走配置引导子集，且不导入 session。
- MCP 无“后台登录进度/取消”；静态探测不把 token 写入 Buddy；另一目标不被误标为已登录。
- git 根技能不能被 `mv` 迁走；Eject 能把物理目录写回并解开托管链接。
- 原生配置中的注释、无关字段和用户改动不丢失；失败操作可恢复。
- 自动化写入、删除、Eject 和恢复测试使用临时 Agent 目录；真实登录只做指引类手工验收，不能只凭界面出现按钮宣称通过。
- 执行相应单元测试、目标 E2E、`pnpm typecheck` 和 `pnpm build`；发布不属于本方案执行阶段。

### 本任务交付物

- 仅本方案文档：`docs/plans/2026-11-02-skills-mcp-magpie-port-proposal.md`。
- 不修改 `src/`、不新增依赖、不改菜单、不提交功能实现。
- 功能开发需另开实现任务，按第 9 节步骤交付并对照验收清单。
