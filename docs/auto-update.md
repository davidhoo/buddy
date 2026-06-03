# Buddy 自动升级方案

## 一、方案概述

采用 **electron-updater + GitHub provider** 实现自动更新。electron-builder 打包时自动生成 `latest-mac.yml`，发布到 GitHub Release 后，客户端自动检测并下载更新。

---

## 二、整体架构

```
开发者打 tag
    ↓
本地执行 scripts/release.sh
    ↓
pnpm build → pnpm dist（产出 DMG + ZIP）
    ↓
gh release upload 上传到 GitHub Releases
    ↓
客户端启动 → electron-updater 检查 GitHub Releases
    ↓
版本对比 → 下载 ZIP → 提示重启 → quitAndInstall()
```

---

## 三、GitHub Releases 配置

### 3.1 electron-builder.yml

```yaml
publish:
  provider: github
  owner: davidhoo
  repo: buddy
```

### 3.2 发布流程

1. 执行 `scripts/release.sh v1.2.0`
2. 脚本自动：构建 → 打包 → 上传 DMG/ZIP/latest-mac.yml 到 GitHub Release
3. 客户端通过 electron-updater 自动检测更新

### 3.3 Release 资产

每次发布包含以下文件：

| 文件 | 说明 |
|------|------|
| `Buddy-X.Y.Z-arm64.dmg` | Apple Silicon 安装包 |
| `Buddy-X.Y.Z.dmg` | Intel 安装包 |
| `Buddy-X.Y.Z-arm64-mac.zip` | Apple Silicon 更新包 |
| `Buddy-X.Y.Z-mac.zip` | Intel 更新包 |
| `latest-mac.yml` | 版本元数据（electron-updater 使用） |
| `buddy-vX.Y.Z-source.tar.gz` | 源码包 |
| `buddy-vX.Y.Z-source.zip` | 源码包 |

---

## 四、客户端配置

### 4.1 electron-builder.yml publish 配置

已在 `electron-builder.yml` 中配置 `provider: github`。

### 4.2 主进程入口文件

**必须在所有 import 之前**设置环境变量（`src/main/index.ts`）：

```typescript
// Must be set before electron-updater is imported (via updater.ts)
process.env.ELECTRON_UPDATER_ALLOW_PRERELEASE = '0'

import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from 'electron'
// ...
```

> 注意：使用 GitHub provider 时无需 `ELECTRON_UPDATER_ALLOW_HTTP=1`，GitHub Releases 走 HTTPS。

### 4.3 更新模块（`src/main/updater.ts`）

核心逻辑：

- 使用 `electron-updater` 的 `autoUpdater`
- 启动后延迟 5s 检查更新（避免影响启动速度）
- 发现新版本自动后台下载
- 通过 `updater:event` 通道通知 renderer
- 支持强制更新（`mandatory` 字段透传）

```typescript
import { autoUpdater } from 'electron-updater'

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.setFeedURL({
  provider: 'github',
  owner: 'davidhoo',
  repo: 'buddy'
})

autoUpdater.on('update-available', (info) => { /* 通知 renderer */ })
autoUpdater.on('download-progress', (progress) => { /* 通知进度 */ })
autoUpdater.on('update-downloaded', (info) => { /* 提示重启 */ })

// 启动后延迟检查
setTimeout(() => {
  autoUpdater.checkForUpdates()
}, 5000)
```

### 4.4 Preload API

```typescript
checkForUpdates: (): void => { ipcRenderer.invoke('updater:check') },
installUpdate: (): void => { ipcRenderer.invoke('updater:install') },
onUpdaterEvent: (callback): (() => void) => { /* 监听 updater:event */ }
```

### 4.5 Renderer 更新 UI

- `useUpdater` hook 跟踪更新状态（idle / checking / available / downloading / downloaded / error）
- `UpdateNotification` 组件显示更新提示、下载进度、重启按钮
- 支持 i18n（中/繁/英）

### 4.6 更新策略

| 版本类型 | 策略 |
|---------|------|
| patch (1.0.1) | 可选更新，提示用户 |
| minor (1.1.0) | 可选更新，changelog 更醒目 |
| major (2.0.0) | 强制更新，弹窗不可关闭 |
| 安全修复 | 强制更新，不给跳过选项 |

可在 `latest-mac.yml` 中扩展自定义字段（如 `mandatory: true`）控制策略。

---

## 五、CI/CD 配置（可选）

如需自动化发布，可配置 GitHub Actions：

### 5.1 `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install
      - run: pnpm build
      - run: pnpm dist
        env:
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
      - name: Upload to GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            release/*.dmg
            release/*.zip
            release/latest-mac.yml
```

### 5.2 GitHub Secrets 配置

在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加：

| 变量名 | 说明 |
|-------|------|
| `CSC_LINK` | Apple 开发者证书（base64 编码 .p12） |
| `CSC_KEY_PASSWORD` | 证书密码 |
| `APPLE_ID` | Apple ID 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | App 专用密码 |
| `APPLE_TEAM_ID` | Apple Team ID |

---

## 六、关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 传输协议 | HTTPS | GitHub Releases 默认 HTTPS，安全可靠 |
| 签名公证 | 按 `release:signed` 脚本执行 | macOS 需签名和公证才能正常分发 |
| 产物格式 | DMG + ZIP | DMG 用于首次安装，ZIP 用于自动更新 |
| 发布触发 | GitHub tag | 语义化版本控制，防止误发布 |
| Provider | github | electron-updater 原生支持，无需自建服务 |

---

## 七、首次安装指引

用户首次安装需手动下载 DMG：

1. 访问 [GitHub Releases](../../releases) 页面
2. 下载对应架构的 DMG（arm64 或 x64）
3. 双击 DMG，拖入 Applications
4. 首次打开如遇 Gatekeeper 提示，右键点击 → 「打开」
5. 后续更新由 electron-updater 自动处理

---

## 八、技术要点备忘

| 要点 | 说明 |
|------|------|
| GitHub provider | electron-updater 原生支持，自动解析 latest-mac.yml |
| `latest-mac.yml` 自动生成 | electron-builder 打包时自动生成，无需手写 |
| electron-updater 自动选架构 | `latest-mac.yml` 列出多架构文件，客户端自动下载对应架构 |
| 更新不触发 Gatekeeper | 已有 app 内部替换，不走 quarantine（仅签名版本适用） |
| 私有仓库需 GH_TOKEN | 如果仓库是私有的，需要设置 `GH_TOKEN` 环境变量 |

---

## 九、后续扩展（可选）

| 扩展项 | 时机 | 改动范围 |
|--------|------|---------|
| 强制更新策略 | 需要时 | `latest-mac.yml` 扩展字段 + renderer UI |
| 灰度发布 | 用户量大时 | `latest-mac.yml` 扩展 `rollout` 字段 |
| 健康检查 + 回滚 | 稳定性要求高时 | 客户端启动时检查上次更新是否成功 |
| 增量更新 | 带宽受限时 | electron-updater 支持 blockmap 差异更新 |
| CI 自动发布 | 团队协作时 | GitHub Actions workflow |

---

## 十、实现文件清单

| 文件 | 说明 |
|------|------|
| `electron-builder.yml` | publish: github provider 配置 |
| `src/main/index.ts` | 导入 updater，注册 IPC |
| `src/main/updater.ts` | autoUpdater 集成、事件转发到 renderer |
| `src/preload/index.ts` | 暴露 checkForUpdates / installUpdate / onUpdaterEvent |
| `src/renderer/hooks/useUpdater.ts` | React hook 跟踪更新状态 |
| `src/renderer/components/UpdateNotification.tsx` | 更新通知 UI 组件 |
| `src/renderer/App.tsx` | 挂载 UpdateNotification |
| `src/renderer/lib/i18n.ts` | updater.* 翻译（中/繁/英） |
| `package.json` | electron-updater 依赖 |
| `scripts/release.sh` | 本地发布脚本（构建 + 上传 GitHub Release） |
