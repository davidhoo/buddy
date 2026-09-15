# agy 设置页测试超时与代理继承修复任务

## 目标与状态

- 日期：2026-09-15。
- 仓库：`/Users/david/SynologyDrive/Projects/github/buddy`。
- 诊断基线：HEAD `0ccb414`，存在 Antigravity 尚未提交的修改；实施前重新核对差异。
- 状态：任务方案，尚未完成修复和 GUI 验收。
- 目标：从 Finder/Dock 启动 Buddy 后，agy 能使用用户配置的 shell 代理完成设置页测试；超时和信号终止时不再显示 `Process exited with code null`。

本任务按以下范围实施，不要求安装额外技能。保留工作区其他修改，不使用整文件还原或清理命令覆盖已有工作。

## 一、已确认的根因和证据

### 1. 安装包与工作区不是同一实现

诊断时 `/Applications/Buddy.app` 版本为 `1.2.27`。直接检查 `Contents/Resources/app.asar` 确认：

- 安装包的 `fixShellPath()` 只提取 PATH，没有提取代理变量。
- 安装包的 `testLauncher()` 在非零退出且输出为空时，仍拼接 `Process exited with code ${result.exitCode}`，未先处理测试超时。
- 当前运行的 Buddy 初始环境中，六个 HTTP/HTTPS/ALL_PROXY 大小写变量均不存在。
- 工作区已经存在部分修复，但尚不能据此宣称本地安装包已生效。

### 2. 代理对照实验

采用 Buddy 的 `buildLauncherCommand()`、`buildPingPrompt()`、`runLauncher()`，使用相同 agy 可执行文件、协议参数和 120 秒超时，在临时目录中运行。两组只改变代理变量，并使用独立日志文件。

| 场景 | 结果 |
| --- | --- |
| 清除所有代理变量 | 121523 ms 后退出；`timedOut=true`、`exitCode=null`、`signal=SIGKILL`；stdout/stderr 均为空 |
| 设置本机代理 `127.0.0.1:7893` | 8207 ms 正常退出，退出码 0 |
| 有代理，再验证输出解析 | 9169 ms 正常退出；`extractActorOutput` 提取 83 字符回复；`parseBuddyMessage` 返回有效 message |

第三次实验才验证了最终回复解析；第一组有代理实验的 `summary.json` 中 `hasResult=false` 来自诊断脚本错误地检查 `type` 字段。agy 实际使用 `event: 'result'`，不能将该字段误读为 CLI 执行失败。以后使用正式解析器判断成功。

本机证据目录（临时目录可能被系统清理，交付前应保存脱敏摘要）：

```text
/var/folders/br/pqc1xkm517j65dhk2j3w_q540000gn/T/buddy-agy-proxy-diagnosis-0a1dul/
  without_proxy/summary.json
  without_proxy/agy.log
  with_proxy/summary.json
  with_proxy/agy.log
  with_proxy/parse-verification.json
  with_proxy/parse-verification.log
```

无代理组读取到了钥匙串凭据，但未完成静默登录；有代理组完成静默登录、发送消息并结束一轮。日志开头的“未登录”不能单独作为账号失效证据，`play.googleapis.com/log` 的遥测超时也不能单独作为任务阻塞原因；本结论来自上述对照实验。

### 3. 故障链路

```text
GUI 启动环境缺少代理，Buddy 仅恢复 PATH
→ agy 登录相关网络步骤未完成
→ Buddy 的 120 秒期限到达
→ SIGTERM，必要时按现有逻辑升级为 SIGKILL
→ exitCode=null，stdout/stderr 为空
→ 旧 testLauncher 拼接出 Process exited with code null
```

该实验复现了相同错误条件，但没有历史 GUI 测试的 run ID 对应记录，不能声称其最终终止信号也一定是 SIGKILL。

## 二、范围

### 包含

1. 修正 macOS 登录 shell 的 PATH 和代理环境提取。
2. 明确代理变量大小写与来源优先级，保留用户显式设置。
3. 保留设置页向测试接口传递 `launcher.env` 的修复。
4. 修复测试超时、外部信号终止及未知退出的错误描述。
5. 增加不依赖真实 AI CLI 的回归测试，并做构建后 GUI 验收。

### 不包含

- 不在本次自动导入 `scutil --proxy`。当前机器的 shell 已配置代理，正确继承即可解决；系统代理例外列表、PAC 和通配符转换另行设计。
- 不把 `127.0.0.1:7893` 写死到产品代码、默认设置或通用单元测试中。
- 不修改系统代理、shell 启动文件、钥匙串、用户账号或全局认证配置。
- 不增加测试超时时长，不把 agy 改为 PTY，不修改流式协议、恢复会话或正常任务状态机。
- 不重做进程树终止、自动重试或日志基础设施。
- 不自动提交、推送、发布或覆盖 `/Applications/Buddy.app`。构建后 GUI 验收使用可识别的本地测试构建；正式发布遵守仓库 AGENTS.md 的签名与远端验证要求。

## 三、已有修改的处置

| 文件 | 处理要求 |
| --- | --- |
| `src/main/buddy/service.ts` | 保留 timedOut 优先处理和信号描述；检查输出收集/解析异常是否掩盖已知超时 |
| `src/main/buddy/shell-path.ts` | 重做 shell 执行方式和变量对合并；移除本次新增的系统代理自动回退及无用辅助函数 |
| `src/renderer/components/SettingsContent.tsx` | 保留传递 `launcher.env` 的修改 |
| `tests/unit/main/buddy-shell-path.test.ts` | 将测试重点改为真实 shell 提取、PATH 回归和代理优先级 |
| `tests/unit/main/buddy-launcher-timeout.test.ts` | 去掉新增单测对本机 `agy` 安装的依赖 |
| `tests/unit/main/buddy-agy-testlauncher.test.ts` | 保留信号终止回归；将默认单测中的真实 agy 调用替换为假 CLI |

可按需要修改 `src/main/buddy/launchers.ts` 及其单测，但仅限统一最终子进程代理环境的合并，不改变命令参数、信号策略或状态机。只有新增可见界面文案时才扩展 i18n 文件。

## 四、实施要求

### Task 1：先建立失败回归

先补充第五节测试，确认它们在当前错误实现上失败，再修改实现。测试不能只把预制字符串交给解析函数，必须覆盖实际登录 shell 命令执行。

### Task 2：可靠提取 shell 环境

在 `shell-path.ts` 中：

1. 使用 `execFileSync(shell, ['-il', '-c', script], options)` 或等价的无外层 shell 调用，避免 `execSync` 双引号导致 `$PATH`、`$https_proxy` 被父 shell 提前展开。
2. 使用固定格式的 `printf` 与正确引用的变量输出 PATH，以及 HTTP/HTTPS/ALL_PROXY/NO_PROXY 的大小写形式。
3. 仅接受白名单键，忽略 shell 启动提示和无关输出；不得把任意输出导入 `process.env`。
4. 不把变量值拼进可执行命令；正确处理路径中的空格、代理 URL 中的特殊字符。解析器不得随意 trim 有效值。
5. 保留有限执行超时、失败回退和常用工具 PATH 合并；shell 提取失败不能清空已有环境。
6. 不在产品日志中输出完整 shell 输出、完整环境或含认证信息的代理 URL。
7. 保留非 macOS 的既有行为。若测试入口跳过 `NODE_ENV=test`，应拆出可独立测试的提取函数，不能因此跳过真实 shell 回归。

### Task 3：定义代理合并语义

按变量对处理：`http_proxy/HTTP_PROXY`、`https_proxy/HTTPS_PROXY`、`all_proxy/ALL_PROXY`、`no_proxy/NO_PROXY`。

- 来源优先级：launcher 显式覆盖 > Buddy 已有环境 > 登录 shell 补充。
- 高优先级来源只提供一种大小写时，同一对的另一种形式应使用该值，不能从低优先级来源填入不同值。
- 同一来源明确提供两种大小写且值不同：保留该来源的显式值，不擅自替用户选择；测试明确记录这一例外。
- 显式空字符串视为该来源的清空意图，不得因 truthy 判断被低优先级来源重新补回。shell 输出需区分未设置和显式设置为空。
- 环境合并只影响已知代理变量，其他 launcher 环境变量保持既有合并行为。
- 若需在 pipe/PTY 的最终环境构建处应用变量对合并，两条路径必须一致，避免全局镜像出的另一种大小写压过 launcher 显式设置。

### Task 4：完善测试结果和诊断

在 `service.ts` 中：

1. 拿到 launcher 结果后优先识别 `timedOut`，不要依赖退出码推断超时，也不要让不必要的输出解析覆盖超时结果。
2. 超时返回 `success=false`、`phase='ping'`，明确给出 120 秒超时；可复用 `LauncherTimeoutError`。
3. 非超时：有非零退出码则显示退出码；只有 signal 则显示信号；两者均无则显示未知异常退出。
4. 保留有价值的 stdout/stderr 错误信息，做脱敏和长度限制；错误描述不能包含 `code null`。
5. 记录或提供可关联的最小诊断信息：测试标识、actor、阶段、耗时、timedOut、exitCode、signal、脱敏摘要。优先复用现有机制，不另建日志系统；持久化 JSON 仍遵守原子写规范。
6. 超时默认只解释为超时；没有网络或登录证据时，不把代理缺失或认证失败写成确定根因。
7. `SettingsContent.tsx` 继续传递 `launcher.env`，核对 hook → preload → IPC → service → child env 链路。

## 五、自动化测试要求

| 类别 | 必须覆盖 |
| --- | --- |
| 登录 shell | 临时 HOME/ZDOTDIR 和 `.zshrc` 设置专用 PATH、代理；父环境没有这些值，提取结果仍必须包含它们 |
| PATH | 空格路径、常用工具目录保留、不重复合并、shell 失败后保留原 PATH |
| 输出解析 | shell 启动噪声、非白名单标记、未设置变量、显式空值、特殊字符 |
| 来源优先级 | 仅大写/仅小写；已有环境与 shell 冲突；显式清空；同源双值冲突保持 |
| launcher 覆盖 | 全局已有镜像值时，单侧显式覆盖仍生效；pipe/PTY 最终环境一致 |
| 超时 | mock 返回 timedOut + null/SIGTERM 或 null/SIGKILL，错误明确包含期限 |
| 其他退出 | 假 CLI 自行 SIGTERM；非零退出且 stderr 非空；null 且无信号；正常回复 |
| 设置页 | 确认测试 mutation 将配置的 env 传给接口，可扩展现有 renderer 测试 |
| 环境独立性 | PATH 不含 agy、未安装 agy 时，默认单元测试仍通过 |

所有假 CLI、临时 shell 文件和数据目录在测试结束后清理。默认 `pnpm test` 不得实际请求 AI 服务；真实 CLI 联调作为显式手工验收执行。不要在单测中真的等待 120 秒。

建议执行：

```bash
pnpm vitest run tests/unit/main/buddy-shell-path.test.ts tests/unit/main/buddy-launcher-timeout.test.ts tests/unit/main/buddy-agy-testlauncher.test.ts tests/unit/main/buddy-launchers.test.ts
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

再以不包含 agy 的受控 PATH 运行相关单测。注意保留 Node/Vitest 启动所需的绝对路径，避免把测试运行器未找到误判为产品失败。

当前基线的 71 文件/684 测试、类型检查和构建均通过，但不覆盖上述缺陷；这些数字只作为历史基线，交付必须报告修改后的实际结果。

## 六、构建后 GUI 验收

1. 生成可识别的本地测试构建，使用独立测试数据目录，核对实际运行的可执行文件及构建来源。不要用源码或版本号代替运行产物证据。
2. 从 Finder/Dock 启动测试构建，保留当前 shell 中的代理配置；确认父启动环境不含代理时，应用仍能提取代理。
3. 设置页测试 agy，必须返回成功和非空有效回复。记录耗时、结果和脱敏证据。网络速度有波动，8–9 秒是本次观察值，不是强制性能门槛。
4. 使用临时 shell 配置和假 CLI 验证自定义 PATH 可用，不修改真实用户 shell 配置。
5. 用受控无代理环境或挂起假 CLI 验证超时提示。明确区分实际网络失败与模拟挂起测试；不能把“没有 code null”当作连通成功。
6. 用假 CLI 验证非超时信号终止提示正确。
7. 确认其他 actor 的启动环境未被意外覆盖，测试生成的进程和临时资源完成清理。

若本地无法执行 GUI 验收，应明确标注“自动化检查通过，GUI 验收未完成”并说明实际阻碍；不得宣称本地 Buddy 已修复。

## 七、交付与回滚

交付说明必须包含：

- 最终修改文件、各自解决的问题，以及对 Antigravity 已有修改的保留/替换情况。
- 失败回归与修复后通过的命令、退出码和测试数。
- GUI 测试使用的产物路径、构建来源、运行结果与证据位置。
- 剩余限制：本次依赖 shell 或 launcher 显式代理；仅配置系统代理而未配置 shell 代理的场景不在此次修复范围。
- 区分代码完成、构建完成、GUI 验收、替换本地安装包和正式发布，逐项说明状态。

回滚时仅撤销本任务修改；若实施时已有他人未提交改动，先保留差异，不能 `reset --hard` 或整文件恢复。GUI 测试关闭测试构建即可恢复使用原安装包；本任务不修改系统网络或账号配置，因此不需要对应迁移回滚。

如后续另行授权替换本地安装包，应先保存原产物用于恢复。正式发布仅使用 AGENTS.md 指定的签名发布入口，禁止上传 adhoc 构建。
