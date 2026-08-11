# Buddy 正式发布远端验签门禁设计

**日期：** 2026-08-11  
**状态：** 已批准  
**适用范围：** GitHub Release 正式发布流程

## 背景

v1.2.15 发布任务绕过 `scripts/release.sh`，执行了仅供本地使用的 `pnpm dist`。electron-builder 已在日志中提示 ARM64 回退到 adhoc 签名、x64 跳过签名，但任务仍把产物上传到 GitHub，Reviewer 也只检查了文件名和大小。结果是已安装的 Apple Development 签名版本无法通过 Squirrel.Mac 对 v1.2.15 的签名连续性校验。

## 目标

- 正式 Release 只能发布 Apple Development 签名、Team ID 为 `XLDSS978CT`、bundle ID 为 `com.buddy.app` 的产物。
- Release 在远端资产完整回下载并通过验签前保持 Draft。
- ARM64/x64 App、ZIP、DMG 与 `latest-mac.yml` 任一验证失败时，发布立即失败且不得公开。
- 明确区分本地 adhoc 构建与正式发布，消除 Actor 记忆、仓库说明和实际脚本之间的冲突。

## 非目标

- 不引入 Developer ID Application、notarization、Mac App Store 或新的更新服务。
- 不修改 updater 检查、下载或安装逻辑。
- 不把本地 `pnpm dist` 删除；它继续用于不上传的本地 adhoc 构建。

## 设计

### 1. 单一正式发布入口

`scripts/release.sh vX.Y.Z` 是唯一正式发布入口。调用方必须显式提供 `CSC_NAME=Apple Development: ...`。`pnpm dist` 和 `pnpm package` 只允许生成本地 adhoc 产物，文档与 Actor 指令必须明确禁止把这些产物上传到 GitHub Release。

### 2. Draft 发布状态机

正式发布按以下状态推进：

```text
本地签名构建
  -> 本地 App/ZIP/DMG/latest-mac.yml 验证
  -> 创建或转为 Draft
  -> 上传 DMG/ZIP/source
  -> 最后上传 latest-mac.yml
  -> 从 GitHub 按 tag 回下载全部正式资产
  -> 对回下载资产重复完整验证
  -> 发布并标记 Latest
  -> 校验 releases/latest 与 latest-mac.yml
```

任何命令失败都由 `set -euo pipefail` 阻断。失败发生在 Draft 创建之后时，Release 保持 Draft，不能向 updater 暴露半套或未验证资产。

### 3. 可复用验证器

`scripts/verify-release-signing.sh` 增加可选产物目录参数，默认仍验证本地 `release/`。本地构建和远端回下载使用同一套验证逻辑，避免两套规则漂移。

验证项包括：

- `codesign --verify --deep --strict`；
- 禁止 `Signature=adhoc`；
- `Authority` 必须精确匹配当前 `CSC_NAME`；
- Team ID、bundle ID、版本号必须匹配；
- ZIP 解包后的 App 重复验签；
- DMG 完整性、挂载后 App 重复验签；
- `latest-mac.yml` 同时列出 ARM64/x64 ZIP，且 size、SHA-512 与实际文件一致。

新增远端验证脚本负责下载指定 tag 的 5 个正式资产到临时目录，然后调用同一个签名验证器。临时目录通过 trap 清理。

### 4. 发布器与职责边界

新增独立发布器脚本，负责 Draft 创建/转换、按安全顺序上传、调用远端验证器以及最终公开 Release。`scripts/release.sh` 继续负责编译、签名、本地验证、版本提交和 tag，然后把发布阶段委托给发布器。

该拆分允许在单元测试中使用假的 `gh` 和远端验证器验证状态转换，不需要真的构建或写 GitHub。

### 5. Actor 与 Reviewer 门禁

更新 `AGENTS.md`、`docs/RELEASE.md` 和本机 `release-autonomous.md`：

- 正式发布不得调用 `pnpm dist`；
- 日志出现 `adhoc`、`TeamIdentifier=not set` 或 `skipped macOS application code signing` 即为失败；
- 仅看到 Release 资产名称、数量或大小不能确认完成；
- Reviewer 必须以远端回下载验签结果作为完成证据。

## 错误处理与恢复

- 本地验证失败：不创建 Release，不上传资产。
- 上传失败：Release 保持 Draft，可修复网络或资产后重跑。
- 远端验签失败：Release 保持 Draft，禁止发布；不得用仅检查哈希的方式绕过。
- 发布后 Latest/feed 校验失败：脚本报错并把 Release 恢复为 Draft，避免 updater 使用异常 feed。
- 重跑同一 tag：先转 Draft，使用 `--clobber` 覆盖资产，再完整回下载验签。

## 测试与验收

自动化测试至少覆盖：

1. 远端验证失败时不会调用公开 Release，且 Release 保持 Draft。
2. 只有远端验证成功后才公开并标记 Latest。
3. `latest-mac.yml` 总是最后上传。
4. 已存在的同 tag Release 会先转 Draft再覆盖。
5. 可选产物目录仍执行与本地 `release/` 相同的签名和元数据检查。

最终验收还必须运行 `pnpm test`、`pnpm typecheck`、shell 语法检查，并对一次真实发布执行 GitHub 回下载验签。
