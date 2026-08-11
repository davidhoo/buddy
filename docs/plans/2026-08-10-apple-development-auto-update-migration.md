# Apple Development 内部自动更新迁移 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 使用现有 Apple Development 证书建立 Buddy 内部发行签名基线，让现有 adhoc 安装通过一次手动迁移进入 v1.2.12，并从 v1.2.12 起恢复可靠、可观测的自动更新。

**Architecture:** 发布链必须显式选择 Apple Development 身份、强制签名并在上传前验证最终 ZIP/DMG 内的 App；任何 adhoc、无 Team ID、签名不一致或资源缺失都必须阻断发布。Updater 主进程向 Renderer 传递结构化安装状态和真实错误，界面不能再把下载后安装失败伪装成“重启并更新”无响应。现有 adhoc 版本不能跨签名链自动迁移，因此 v1.2.12 是一次性手动安装基线，v1.2.13 用于验证同一签名链上的自动升级。

**Tech Stack:** Electron 33、electron-updater 6.8.3 / Squirrel.Mac、electron-builder 26.8.1、TypeScript、React 18、Vitest、macOS `codesign` / `security` / `hdiutil` / `ditto`、GitHub Releases。

---

## 任务说明

### 背景与已确认根因

- 当前 `/Applications/Buddy.app` 是 v1.2.9，签名为 `Signature=adhoc`、`TeamIdentifier=not set`。
- GitHub Release v1.2.11 的 ARM64 ZIP 已成功下载且 SHA-512 与 `latest-mac.yml` 一致，故障不在下载链路。
- v1.2.11 发布包同样是 adhoc 签名。adhoc 的 designated requirement 绑定构建产物 cdhash，不同版本 cdhash 不同；用 v1.2.9 requirement 校验 v1.2.11 明确失败。
- `scripts/release.sh` 当前设置 `CSC_IDENTITY_AUTO_DISCOVERY=false` 并关闭 notarization，却没有提供真实签名身份或强制签名，导致发布产物退化为 adhoc。
- `src/main/updater.ts` 丢弃 updater 原始错误；`src/renderer/hooks/useUpdater.ts` 在 `downloaded` 后忽略 `not-available`，所以安装失败时用户只看到按钮无响应。

### 固定决策

- 内部发行使用钥匙串中的 `Apple Development: coolbor@gmail.com (LL5Q233Q8L)`；证书 Team ID 预期为 `XLDSS978CT`。
- 不启用 notarization，不把 Gatekeeper 公网无提示通过作为本任务验收条件。
- 不覆盖或替换已经公开、已被缓存的 v1.2.11 资产。
- v1.2.12 作为第一个 Apple Development 正确签名版本；现有 adhoc 用户必须手动安装一次。
- v1.2.13 继续使用同一签名身份，作为 v1.2.12 → v1.2.13 自动更新验收版本。
- 实现、测试与本地构建不授权 push、tag、GitHub Release 创建/修改或 `/Applications/Buddy.app` 替换；所有远程发布和本机安装动作必须在代码审查通过后获得用户明确批准。

### 不包含

- 不申请、安装或改用 Developer ID Application 证书。
- 不接入 Apple notarization、Mac App Store、企业 MDM 或新的更新服务。
- 不删除或重写 v1.2.11 GitHub Release、tag、现有资产或客户端缓存。
- 不迁移、不清理 `~/Library/Application Support/Buddy`、`~/Library/Application Support/buddy` 中的任务、设置或会话数据。
- 不修改 Buddy 双 Actor 状态机、队列、模型检测或其他无关功能。

---

### Task 1: 为发布链建立 Apple Development 强制签名入口

**Files:**
- Modify: `scripts/release.sh:59-97`
- Modify: `package.json:12-20`
- Modify: `electron-builder.yml:7-22`（仅在需要显式声明本任务的签名配置时修改；不得写入私钥或密码）
- Create: `scripts/verify-release-signing.sh`

**Step 1: 写发布前置检查**

在 `scripts/release.sh` 构建前要求调用方显式提供 `CSC_NAME`，不得回退为 adhoc 或自动选择其他证书。前置检查至少验证：

```bash
: "${CSC_NAME:?Set CSC_NAME to the Apple Development signing identity}"
case "$CSC_NAME" in
  Apple\ Development:*) ;;
  *) echo "CSC_NAME must be an Apple Development identity" >&2; exit 1 ;;
esac

security find-identity -v -p codesigning \
  | grep -F -- "\"${CSC_NAME}\"" >/dev/null \
  || { echo "Signing identity not found or invalid: ${CSC_NAME}" >&2; exit 1; }
```

不得把证书、私钥、P12 内容或密码写入仓库、日志或 Release 资产。

**Step 2: 将构建改为强制签名、非公证模式**

保留 `CSC_IDENTITY_AUTO_DISCOVERY=false` 以避免误选证书，但必须同时传入显式 `CSC_NAME`，并启用：

```bash
-c.mac.forceCodeSigning=true
-c.mac.notarize=false
```

`package.json` 的 `release:signed` 不得再默认回退到字符串 `Developer ID Application`；未设置 `CSC_NAME` 时应立即失败。`pnpm dist` 可以继续用于本地 adhoc 构建，但不得被正式 `release.sh` 调用。

**Step 3: 创建最终产物签名验证脚本**

`scripts/verify-release-signing.sh` 必须：

1. 验证 `release/mac/Buddy.app` 与 `release/mac-arm64/Buddy.app` 均存在。
2. 对两个 App 执行 `codesign --verify --deep --strict --verbose=2`。
3. 读取 `codesign -dv --verbose=4`，要求：
   - `Signature` 不是 `adhoc`；
   - `Authority` 包含 `Apple Development`；
   - `TeamIdentifier=XLDSS978CT`；
   - `Identifier=com.buddy.app`。
4. 使用 `mktemp -d` 解压 `Buddy-<version>-arm64-mac.zip` 和 `Buddy-<version>-mac.zip`，对 ZIP 内的两个 App 重复同样验证；使用 `trap` 清理临时目录。
5. 对两个 DMG 执行 `hdiutil verify`，再以只读方式挂载，验证 DMG 内 App 的签名与版本，最后可靠卸载。
6. 验证 ZIP/DMG 内的 `CFBundleShortVersionString`、`CFBundleVersion` 均等于目标版本。
7. 验证 `latest-mac.yml` 同时列出 ARM64/x64 ZIP，文件名、size、sha512 与本地最终文件一致。
8. 任意一步失败立即非零退出，不得继续创建或上传 Release。

**Step 4: 将验证接入 release.sh**

调用顺序固定为：

```text
证书前置检查 → build → verify-release-signing.sh → 源码归档 → tag/push → GitHub Release → 上传资产 → 远端复核
```

不得保留“签名验证失败仍继续”或“必需资产上传失败只 WARNING”的逻辑。`gh release upload` 任一必需资产失败时整次发布失败并停止。

**Step 5: 本地负向验证**

Run:

```bash
env -u CSC_NAME scripts/release.sh v0.0.0-test
```

Expected: 在修改版本、构建、tag 或访问远程前失败，提示缺少 `CSC_NAME`。

Run:

```bash
CSC_NAME='invalid identity' scripts/release.sh v0.0.0-test
```

Expected: 在任何副作用前失败，提示身份类型或钥匙串身份不合法。

不得使用真实版本号执行这两个负向测试。

**Step 6: 提交**

```bash
git add scripts/release.sh scripts/verify-release-signing.sh package.json electron-builder.yml
git commit -m "fix(release): 强制内部版本使用 Apple Development 签名"
```

仅提交实际修改的文件；若 `electron-builder.yml` 无需修改，不得为了凑文件而改动。

---

### Task 2: 让 updater 暴露安装状态和真实错误

**Files:**
- Modify: `src/main/updater.ts:5-116`
- Modify: `src/main/index.ts:51-61`
- Modify: `src/preload/index.ts:32-45`
- Modify: `src/renderer/hooks/useUpdater.ts:3-68`
- Modify: `src/shared/types.ts`（若 preload API 类型位于此处）
- Test: `tests/unit/main/updater.test.ts`
- Test: `tests/unit/preload/index.test.ts`
- Test: `tests/unit/renderer/use-updater.test.tsx`

**Step 1: 写失败测试——错误不得丢失**

覆盖以下状态转换：

```text
downloaded → 用户点击安装 → installing
installing/downloaded → autoUpdater error → error
error → 再次检查/重新下载 → checking/available/downloading
```

主进程测试必须断言 `autoUpdater` 的错误信息被归一化并发送到 Renderer，例如：

```ts
{
  type: 'error',
  phase: 'install',
  message: 'Code signature at URL ... did not pass validation'
}
```

不得把错误降级成 `not-available`；“没有新版本”和“更新失败”必须是两个独立事件。

**Step 2: 运行测试确认失败**

Run:

```bash
pnpm vitest run tests/unit/main/updater.test.ts tests/unit/preload/index.test.ts tests/unit/renderer/use-updater.test.tsx
```

Expected: 因缺少 `installing` / `error` 状态和错误载荷而失败。

**Step 3: 实现结构化 updater 状态**

扩展 `UpdaterEvent`：

```ts
type UpdaterPhase = 'check' | 'download' | 'install'

type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; info: UpdateInfo }
  | { type: 'not-available' }
  | { type: 'progress'; progress: DownloadProgress }
  | { type: 'downloaded'; info: UpdateInfo }
  | { type: 'installing'; version: string }
  | { type: 'error'; phase: UpdaterPhase; message: string }
```

要求：

- `autoUpdater.on('error')` 保留真实错误消息并发送 `error`。
- `quitAndInstall()` 调用前发送 `installing`；同步异常立即发送 `error`。
- IPC handler 返回结构化结果或让 Promise rejection 可被 preload/renderer 捕获，禁止 fire-and-forget 丢弃失败。
- 日志不得包含 token、cookie、私钥、P12 或 GitHub 凭证。

**Step 4: 修复 Renderer 状态机**

`UpdateStatus` 扩展为：

```ts
'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'
```

`useUpdater` 返回 `errorMessage` 与 `retryUpdate`。下载后发生错误时必须从 `downloaded/installing` 进入 `error`，不得因 `downloaded.current` 而忽略。重新收到 `available/progress/downloaded` 时清空旧错误。

**Step 5: 运行聚焦测试**

Run:

```bash
pnpm vitest run tests/unit/main/updater.test.ts tests/unit/preload/index.test.ts tests/unit/renderer/use-updater.test.tsx
```

Expected: PASS。

**Step 6: 提交**

```bash
git add src/main/updater.ts src/main/index.ts src/preload/index.ts src/renderer/hooks/useUpdater.ts src/shared/types.ts tests/unit/main/updater.test.ts tests/unit/preload/index.test.ts tests/unit/renderer/use-updater.test.tsx
git commit -m "fix(updater): 保留安装状态并上报真实错误"
```

仅添加实际存在且发生修改的文件。

---

### Task 3: 在更新通知和侧边栏展示安装中、失败与重试

**Files:**
- Modify: `src/renderer/components/UpdateNotification.tsx:1-68`
- Modify: `src/renderer/components/Sidebar.tsx:368-389`
- Modify: `src/renderer/App.tsx:619-622,747-755`
- Modify: `src/renderer/lib/i18n.ts:455-467,863-875,1273-1285`
- Test: `tests/unit/renderer/update-notification.test.tsx`
- Modify: `tests/unit/renderer/sidebar.test.tsx`

**Step 1: 写失败测试**

至少覆盖：

- `installing` 时两个入口均禁用，文案为“正在重启并安装…”，不能重复调用安装。
- `error` 时通知展示真实、经过长度限制的错误摘要和“重试”按钮。
- `error` 状态下侧边栏不能继续显示“重启并更新 vX”；应显示“更新失败”并允许进入重试。
- 点击重试只调用一次 `retryUpdate`。
- zh-CN、zh-TW、en 三套 key 完整，不能出现原始 key。

**Step 2: 运行测试确认失败**

Run:

```bash
pnpm vitest run tests/unit/renderer/update-notification.test.tsx tests/unit/renderer/sidebar.test.tsx
```

Expected: 因组件不支持 `installing` / `error` 而失败。

**Step 3: 实现最小 UI**

使用现有 lucide-react 图标，不新增图标库或自定义 SVG。错误消息必须可读但避免撑破布局；建议显示最多 2-3 行，并保留完整内容到 `title` 或可复制区域。不得自动关闭错误通知。

新增 i18n key 至少包括：

```text
updater.installing
updater.installingHint
updater.failed
updater.retry
updater.sidebarInstalling
updater.sidebarFailed
```

**Step 4: 运行聚焦测试**

Run:

```bash
pnpm vitest run tests/unit/renderer/update-notification.test.tsx tests/unit/renderer/sidebar.test.tsx
```

Expected: PASS。

**Step 5: 提交**

```bash
git add src/renderer/components/UpdateNotification.tsx src/renderer/components/Sidebar.tsx src/renderer/App.tsx src/renderer/lib/i18n.ts tests/unit/renderer/update-notification.test.tsx tests/unit/renderer/sidebar.test.tsx
git commit -m "fix(ui): 展示自动更新安装失败并支持重试"
```

---

### Task 4: 完成代码级回归验证，不执行发布

**Files:**
- Review: `scripts/release.sh`
- Review: `scripts/verify-release-signing.sh`
- Review: `src/main/updater.ts`
- Review: `src/renderer/hooks/useUpdater.ts`
- Review: `src/renderer/components/UpdateNotification.tsx`
- Review: `src/renderer/components/Sidebar.tsx`

**Step 1: 运行聚焦测试**

```bash
pnpm vitest run \
  tests/unit/main/updater.test.ts \
  tests/unit/preload/index.test.ts \
  tests/unit/renderer/use-updater.test.tsx \
  tests/unit/renderer/update-notification.test.tsx \
  tests/unit/renderer/sidebar.test.tsx
```

Expected: 全部 PASS。

**Step 2: 运行完整验证**

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Expected: 全部成功；不得以“聚焦测试通过”代替完整回归。

**Step 3: 本地签名构建演练**

仅在证书机器上执行，不 push、不 tag、不创建 Release：

```bash
CSC_NAME='Apple Development: coolbor@gmail.com (LL5Q233Q8L)' pnpm release:signed
scripts/verify-release-signing.sh 1.2.12
```

实现时应提供一种明确的 dry-run/local-build 模式，确保上面命令不会修改远程。若 `release:signed` 仍不能保证这一点，应拆分为单独的 `build:release:signed` 命令。

Expected:

- ARM64/x64 App、ZIP、DMG 全部通过验证；
- `Signature` 不是 adhoc；
- `Authority` 为 Apple Development；
- `TeamIdentifier=XLDSS978CT`；
- 没有执行 `git push`、`git tag`、`gh release create/upload`。

**Step 4: 请求代码审查**

在任何远程发布前审查：

- 是否还有正式发布路径调用 `pnpm dist` 或禁用真实签名；
- 所有上传前 gate 是否 fail-closed；
- updater 错误是否从 native/main/preload/renderer 全链路保留；
- 日志是否泄露签名或 GitHub 凭证；
- v1.2.11 是否保持不变。

---

### Task 5: 经明确批准后发布 v1.2.12 手动迁移基线

**Approval gate:** 未获得用户明确的“可以发布 v1.2.12”前，本任务保持待办，禁止执行。

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`
- Generated: `release/*`

**Step 1: 准备版本与发布说明**

- 版本升级到 `1.2.12`。
- CHANGELOG 说明：内部发行改为 Apple Development 签名、自动更新错误可见、现有 adhoc 用户必须手动安装一次。
- 明确写出“不覆盖 v1.2.11”。

**Step 2: 构建并验证**

```bash
CSC_NAME='Apple Development: coolbor@gmail.com (LL5Q233Q8L)' scripts/release.sh v1.2.12
```

Expected: 所有签名和资产验证先通过，才允许执行 tag/push/Release/upload。

**Step 3: 远端复核**

发布脚本完成后验证：

- GitHub tag 和 Release 均为 v1.2.12；
- `latest-mac.yml` 可下载且 version 为 1.2.12；
- ARM64/x64 ZIP、DMG 均存在；
- 重新下载 ZIP 后 sha512 与 yml 一致；
- 重新解压并执行签名验证，结果仍为 Apple Development / `XLDSS978CT`；
- v1.2.11 资产、tag、Release 未被修改。

**Step 4: 一台机器手动迁移**

1. 完全退出 Buddy，确认无 Buddy 主进程和 Helper 进程。
2. 将原 v1.2.9 App 备份到 `/Applications` 之外的可恢复位置。
3. 从 v1.2.12 Release 下载对应架构 DMG。
4. 手动替换 `/Applications/Buddy.app`；如 Gatekeeper 提示，按内部发行约定进行一次人工允许。
5. 启动 Buddy，确认版本为 1.2.12、签名为 Apple Development、Team ID 为 `XLDSS978CT`。
6. 确认任务、项目、设置、会话数据仍在；不得清理 Application Support 数据。

**Step 5: 扩大手动迁移范围**

仅在单机迁移通过后，才通知其余内部用户手动安装 v1.2.12。记录已迁移机器数量和失败原因，不能把“DMG 能打开”当成迁移完成。

---

### Task 6: 经明确批准后用 v1.2.13 验证自动更新闭环

**Approval gate:** v1.2.12 单机和小范围手动迁移完成，且用户明确批准发布 v1.2.13 后才能执行。

**Step 1: 使用同一身份构建 v1.2.13**

不得更换证书、Team ID、bundle ID、productName 或 updater cache 名称。签名验证结果必须与 v1.2.12 同源：

```text
Identifier=com.buddy.app
Authority=Apple Development: ...
TeamIdentifier=XLDSS978CT
```

**Step 2: 发布到受控验证范围**

发布 v1.2.13 后，先只在一台已经手动安装 v1.2.12 的机器上操作：

1. 启动 v1.2.12。
2. 检查更新，观察 available → downloading → downloaded。
3. 点击“重启并更新”。
4. 确认界面先进入 installing，应用真正退出、替换并重新启动。
5. 确认启动后的版本为 v1.2.13，签名和 Team ID 保持一致。
6. 确认任务数据、设置、Git 仓库状态和运行中的工作未损坏。

**Step 3: 验证失败反馈**

在测试环境注入一次可控 updater error，确认：

- UI 展示真实错误摘要；
- 不再停留在“重启并更新”假成功状态；
- 重试按钮可用且不会重复发起安装；
- 错误日志不包含敏感数据。

**Step 4: 放量判定**

只有 v1.2.12 → v1.2.13 完整自动升级成功，才能宣布自动更新恢复。仅检测到新版本、仅下载成功、仅生成缓存文件都不算通过。

---

## 验收标准

- 正式 release 构建无法在缺少 `CSC_NAME`、证书无效或签名为 adhoc 时继续。
- ARM64/x64 的 App、ZIP、DMG 都经过最终产物签名验证，不能只验证 `release/mac*` 临时目录。
- 所有正式资产的 bundle ID 为 `com.buddy.app`，Team ID 为 `XLDSS978CT`，Authority 为 Apple Development。
- v1.2.11 保持原样；v1.2.12 是明确标注的手动迁移基线。
- 现有 adhoc 用户完成一次 v1.2.12 手动安装后，任务与设置数据完整。
- v1.2.12 能通过 UI 自动下载、退出、安装、重启到 v1.2.13。
- 下载、签名或安装失败时，UI 展示真实错误并允许重试，不再无响应。
- `pnpm typecheck`、`pnpm test`、`pnpm build`、`git diff --check` 全部通过。
- 未经批准不产生 tag、push、GitHub Release/资产变更或 `/Applications/Buddy.app` 替换。

## 回滚

- 代码回滚：按 Task 1-3 的独立提交逆序 revert，不修改历史 tag。
- 发布前失败：保留本地日志和产物用于诊断，不创建 Release，不上传部分资产。
- v1.2.12 手动迁移失败：退出 Buddy，恢复保存在 `/Applications` 之外的旧 App；保留 Application Support 数据，不自动删除 updater cache。
- v1.2.13 自动更新失败：停止放量，保留 v1.2.12 已签名安装作为基线；修复后发布更高 patch 版本，不覆盖已经发布的资产。
- 签名证书无效、过期或变更：立即停止发布；不得回退 adhoc。恢复同一内部签名策略并重新完成 N-1 → N 验收后再放量。

## 完成定义

本任务只有在“代码和发布 gate 完成 + v1.2.12 手动迁移成功 + v1.2.12 → v1.2.13 自动升级成功 + 错误可见性验证成功”四项全部满足后才能关闭。完成本地构建、检测到更新或下载 ZIP 均不能单独宣称完成。
