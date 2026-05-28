# Buddy macOS 自动升级方案

## 一、方案概述

内网环境 + GitLab 私有仓库 + macOS CI Runner，采用 **electron-updater + generic provider + HTTP 静态文件服务** 实现自动更新。

---

## 二、整体架构

```
开发者打 tag
    ↓
GitLab CI/CD（macOS Runner）触发
    ↓
pnpm build → pnpm dist（产出 DMG + ZIP）
    ↓
rsync ZIP 文件 → buddyweb@10.185.10.105::buddyweb-releases/
    ↓
rsync latest-mac.yml（最后上传，作为发布原子点）
    ↓
客户端启动 → 请求 http://buddy.intra.weibo.cn/releases/latest-mac.yml
    ↓
版本对比 → 下载 ZIP → 提示重启 → quitAndInstall()
```

---

## 三、服务端配置

### 3.1 Rsync Daemon（已就绪）

| 配置项 | 值 |
|--------|-----|
| 模块名 | `buddyweb-releases` |
| 服务端路径 | `/data1/www/buddyWeb/releases/` |
| 服务端 IP | `10.185.10.105` |
| 端口 | `873` |
| 认证用户 | `buddyweb` |

上传命令：

```bash
# 推送单个文件
rsync -avz --password-file=~/.rsyncd.pass ./App.zip buddyweb@10.185.10.105::buddyweb-releases/

# 查看服务端文件列表
rsync --list-only buddyweb@10.185.10.105::buddyweb-releases/
```

### 3.2 Nginx 静态文件服务（已就绪）

- 域名：`buddy.intra.weibo.cn`
- HTTP 路径：`/releases/`
- 映射到 rsync 上传目录 `/data1/www/buddyWeb/releases/`
- 协议：HTTP（内网，无需 HTTPS）

### 3.3 服务器目录结构

```
/data1/www/buddyWeb/releases/
  latest-mac.yml              ← 最后上传，决定当前最新版本
  Buddy-2.0.0-arm64-mac.zip
  Buddy-2.0.0-x64-mac.zip
  Buddy-1.9.0-arm64-mac.zip   ← 旧版本保留，便于回滚
  Buddy-1.9.0-x64-mac.zip
  ...
```

平铺结构，文件名自带版本号区分。回滚时只需替换 `latest-mac.yml` 指向旧版本文件。

---

## 四、客户端改造

### 4.1 安装依赖

```bash
pnpm add electron-updater
```

### 4.2 electron-builder.yml 添加 publish 配置

```yaml
publish:
  provider: generic
  url: http://buddy.intra.weibo.cn/releases
```

### 4.3 主进程入口文件

**必须在所有 import 之前**设置环境变量（`src/main/index.ts`）：

```typescript
// Must be set before electron-updater is imported (via updater.ts)
process.env.ELECTRON_UPDATER_ALLOW_HTTP = '1'

import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from 'electron'
// ...
```

### 4.4 更新模块（`src/main/updater.ts`）

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

autoUpdater.on('update-available', (info) => { /* 通知 renderer */ })
autoUpdater.on('download-progress', (progress) => { /* 通知进度 */ })
autoUpdater.on('update-downloaded', (info) => { /* 提示重启 */ })

// 启动后延迟检查
setTimeout(() => {
  autoUpdater.checkForUpdates()
}, 5000)
```

### 4.5 Preload API

```typescript
checkForUpdates: (): void => { ipcRenderer.invoke('updater:check') },
installUpdate: (): void => { ipcRenderer.invoke('updater:install') },
onUpdaterEvent: (callback): (() => void) => { /* 监听 updater:event */ }
```

### 4.6 Renderer 更新 UI

- `useUpdater` hook 跟踪更新状态（idle / checking / available / downloading / downloaded / error）
- `UpdateNotification` 组件显示更新提示、下载进度、重启按钮
- 支持 i18n（中/繁/英）

### 4.7 更新策略

| 版本类型 | 策略 |
|---------|------|
| patch (1.0.1) | 可选更新，提示用户 |
| minor (1.1.0) | 可选更新，changelog 更醒目 |
| major (2.0.0) | 强制更新，弹窗不可关闭 |
| 安全修复 | 强制更新，不给跳过选项 |

可在 `latest-mac.yml` 中扩展自定义字段（如 `mandatory: true`）控制策略。

---

## 五、CI/CD 配置

### 5.1 `.gitlab-ci.yml` deploy 阶段

```yaml
stages:
  - test
  - build
  - package
  - release
  - deploy

deploy:updates:
  stage: deploy
  tags: [macos]
  rules:
    - if: $CI_COMMIT_TAG =~ /^v\d+\.\d+\.\d+/
  needs:
    - job: package:macos
      artifacts: true
  before_script:
    - echo "$RSYNC_PASS" > /tmp/rsyncd.pass && chmod 600 /tmp/rsyncd.pass
  script:
    # Upload ZIPs first (arm64 + x64)
    - find release -maxdepth 1 -name '*.zip' -exec rsync -avz --password-file=/tmp/rsyncd.pass {} buddyweb@10.185.10.105::buddyweb-releases/ \;
    # Upload latest-mac.yml last (atomic commit point)
    - find release -maxdepth 1 -name 'latest-mac.yml' -exec rsync -avz --password-file=/tmp/rsyncd.pass {} buddyweb@10.185.10.105::buddyweb-releases/ \;
  after_script:
    - rm -f /tmp/rsyncd.pass
```

### 5.2 GitLab CI/CD Variables 配置

在 GitLab 项目设置 → CI/CD → Variables 中添加：

| 变量名 | 保护 | 掩码 |
|-------|------|------|
| `RSYNC_PASS` | ✓ | ✓ |

### 5.3 关键设计

- **上传顺序**：ZIP 先传，`latest-mac.yml` 最后传。避免客户端读到 yml 但 ZIP 还没传完的中间状态
- **触发条件**：只在打 tag 时触发（如 `git tag v1.2.0 && git push origin v1.2.0`）
- **产物格式**：DMG + ZIP，electron-updater 使用 ZIP 进行自动更新
- **密码文件**：CI 中创建临时文件，after_script 中清理

---

## 六、关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 传输协议 | HTTP | 内网环境，无需证书管理；electron-updater 通过 `ELECTRON_UPDATER_ALLOW_HTTP=1` 支持 |
| 签名公证 | 按 `release:signed` 脚本执行 | macOS Runner 支持签名和公证 |
| 产物格式 | DMG + ZIP | DMG 用于首次安装，ZIP 用于自动更新 |
| 发布触发 | GitLab tag | 语义化版本控制，防止误发布 |
| 上传顺序 | ZIP 先，yml 后 | 保证原子性，避免客户端看到不完整发布 |
| 目录结构 | 平铺 | 简单可靠，回滚时替换 `latest-mac.yml` 即可 |

---

## 七、首次安装指引

用户首次安装需手动下载 DMG：

1. 访问 `http://buddy.intra.weibo.cn/releases/`
2. 下载对应架构的 DMG（arm64 或 x64）
3. 双击 DMG，拖入 Applications
4. 首次打开如遇 Gatekeeper 提示，右键点击 → 「打开」
5. 后续更新由 electron-updater 自动处理

---

## 八、技术要点备忘

| 要点 | 说明 |
|------|------|
| HTTP 可行 | macOS ATS 只限制 WebKit，不限制 Node.js 主进程网络请求 |
| `ELECTRON_UPDATER_ALLOW_HTTP` | 必须在 `import electron-updater` 之前设置 |
| electron-updater 自动选架构 | `latest-mac.yml` 列出多架构文件，客户端自动下载对应架构 |
| 更新不触发 Gatekeeper | 已有 app 内部替换，不走 quarantine（仅签名版本适用） |
| 无需 HTTPS | 内网无中间人风险，省去证书管理 |
| `latest-mac.yml` 自动生成 | electron-builder 打包时自动生成，无需手写 |
| 旧版本保留 | 不用 rsync `--delete`，旧文件自然保留，支持回滚 |

---

## 九、后续扩展（可选）

| 扩展项 | 时机 | 改动范围 |
|--------|------|---------|
| 强制更新策略 | 需要时 | `latest-mac.yml` 扩展字段 + renderer UI |
| 灰度发布 | 用户量大时 | `latest-mac.yml` 扩展 `rollout` 字段 |
| 健康检查 + 回滚 | 稳定性要求高时 | 客户端启动时检查上次更新是否成功 |
| 增量更新 | 带金受限时 | electron-updater 支持 blockmap 差异更新 |

---

## 十、实现文件清单

| 文件 | 说明 |
|------|------|
| `electron-builder.yml` | 添加 publish: generic 配置 |
| `src/main/index.ts` | 设置 ELECTRON_UPDATER_ALLOW_HTTP，导入 updater，注册 IPC |
| `src/main/updater.ts` | autoUpdater 集成、事件转发到 renderer |
| `src/preload/index.ts` | 暴露 checkForUpdates / installUpdate / onUpdaterEvent |
| `src/renderer/hooks/useUpdater.ts` | React hook 跟踪更新状态 |
| `src/renderer/components/UpdateNotification.tsx` | 更新通知 UI 组件 |
| `src/renderer/App.tsx` | 挂载 UpdateNotification |
| `src/renderer/lib/i18n.ts` | updater.* 翻译（中/繁/英） |
| `.gitlab-ci.yml` | deploy:updates 阶段（rsync 上传） |
| `package.json` | 添加 electron-updater 依赖 |
