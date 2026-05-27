# Buddy UI 主题方案（最终版）

> 基于 Codex App 主题体系，仅覆盖 UI Theme，不含 Code Theme

## 一、设计理念

**核心原则：少量核心值 + 运行时派生 + 用户可调**

Codex App 的主题引擎不是存储大量固定色值，而是用 5 个核心 token（surface、ink、accent、diffAdded、diffRemoved）+ 1 个对比度参数（contrast），运行时派生出全部 CSS 变量。这种设计带来三个关键优势：

1. **一致性**：所有派生色遵循同一数学关系，不会出现"层级色跳跃"
2. **可调性**：用户调整 1 个 contrast 值就能改变整体层级强度，无需逐色微调
3. **可扩展**：新增 UI 元素只需引用已有 token，自动适配所有主题

Buddy 直接采用这套思路，去掉 Codex 的 Code Theme 部分（我们不是代码编辑器），专注 UI 主题。

---

## 二、主题数据模型

### 2.1 主题定义（用户可调的最小集合）

```typescript
interface BuddyTheme {
  id: string           // 'buddy-dark', 'dracula', 'catppuccin-mocha'
  name: string         // 显示名
  type: 'dark' | 'light'

  // 5 个核心色值 —— 每个都允许用户单独调整
  surface: string      // 主背景色
  ink: string          // 主文字色
  accent: string       // 彩色强调色（链接、选中态、品牌高亮）
  success: string      // 成功/新增色
  danger: string       // 危险/删除色

  // 对比度 —— 允许用户调整（0-100）
  contrast: number     // dark 推荐 50-65, light 推荐 40-55

  // 逃生舱 —— 派生不满意时，允许用户覆盖特定 token
  overrides?: Record<string, string>
}
```

### 2.2 与现有 token 的语义对照

| 现有 Buddy token | 现有语义 | 新方案来源 | 变化说明 |
|-----------------|---------|-----------|---------|
| `--bg` | 主背景 | `surface` | 直接映射 |
| `--bg-elevated` | 提升层背景 | 派生自 surface/ink | contrast 控制 |
| `--bg-subtle` | 次级背景 | 派生自 surface/ink | contrast 控制 |
| `--bg-muted` | 控件背景 | 派生自 surface/ink | contrast 控制 |
| `--fg` | 主文字 | `ink` | 直接映射 |
| `--fg-secondary` | 次要文字 | 派生自 ink | contrast 控制透明度 |
| `--fg-muted` | 弱化文字 | 派生自 ink | contrast 控制透明度 |
| `--fg-inverse` | 反色文字 | `surface` | 直接映射 |
| `--border` | 边框 | 派生自 ink | contrast 控制不透明度 |
| `--border-subtle` | 弱边框 | 派生自 ink | contrast 控制不透明度 |
| `--accent` | **反转色**（黑/白） | **彩色强调色** | 语义变更！现改名 `--accent-primary` |
| `--accent-hover` | 反转色 hover | 派生自 accent | 现在是彩色 hover |
| `--accent-soft` | 软强调 | 派生自 accent/surface | contrast 控制 |
| `--accent-soft-hover` | 软强调 hover | 派生自 accent/surface | contrast 控制 |
| `--success-bg` | 成功背景 | 派生自 success | 低透明度 |
| `--success-fg` | 成功文字 | `success` | 直接映射 |
| `--danger` | 危险色 | `danger` | 直接映射 |
| `--danger-hover` | 危险色 hover | 派生自 danger | 亮度微调 |

### 2.3 新增 token

| Token | 来源 | 用途 |
|-------|------|------|
| `--accent-primary` | 派生自 ink/surface | 主操作按钮背景（原 `--accent` 的语义） |
| `--accent-primary-hover` | 派生自 ink/surface | 主按钮 hover |
| `--status-running` | 派生自 success | 运行状态色 |
| `--status-paused` | 派生自 ink | 暂停状态色 |
| `--scrollbar-thumb` | 派生自 ink | 滚动条 |
| `--scrollbar-thumb-hover` | 派生自 ink | 滚动条 hover |
| `--actor-claude` | 固定值 #8b6dba | Claude 品牌色 |
| `--actor-codex` | 固定值 #4a9bb5 | Codex 品牌色 |
| `--actor-opencode` | 固定值 #d97706 | OpenCode 品牌色 |
| `--actor-kimi` | 固定值 #2e7d32 | Kimi 品牌色 |

**token 总数：20（原有） + 10（新增） = 30 个**

---

## 三、派生算法

### 3.1 核心工具函数

```typescript
// src/renderer/themes/color.ts

function parseHex(hex: string): RGB
function toHex(rgb: RGB): string
function toRgba(rgb: RGB, alpha: number): string
function lerpColor(a: RGB, b: RGB, ratio: number): RGB
function mixHex(a: string, b: string, ratio: number): string  // lerp + toHex
function withAlpha(color: string, alpha: number): string       // mix + toRgba
function lighten(hex: string, amount: number): string          // 向白方向偏移
function darken(hex: string, amount: number): string           // 向黑方向偏移
```

### 3.2 contrast 的作用机制

`contrast`（0-100）是乘数，影响所有中间色的混合比例。核心公式模式：

```
混合比例 = 基础值 + contrast × 增量系数
```

| 派生目标 | 公式（暗色） | 公式（亮色） |
|---------|------------|------------|
| border 不透明度 | `0.06 + contrast × 0.04` | `0.06 + contrast × 0.04` |
| border-subtle 不透明度 | `0.04 + contrast × 0.02` | `0.04 + contrast × 0.02` |
| bg-elevated 混合 | `mix(surface, ink, 0.08 + contrast × 0.08)` | `mix(surface, ink, 0.16 + contrast × 0.12)` |
| bg-subtle 混合 | `ink @ 0.02 + contrast × 0.02` | `mix(surface, ink, 0.08 + contrast × 0.08)` |
| bg-muted 混合 | `ink @ 0.04 + contrast × 0.03` | `mix(surface, ink, 0.12 + contrast × 0.10)` |
| fg-secondary 不透明 | `0.65 + contrast × 0.10` | `0.65 + contrast × 0.10` |
| fg-muted 不透明 | `0.42 + contrast × 0.13` | `0.45 + contrast × 0.10` |
| accent-soft 混合 | `mix(#000, accent, 0.20 + contrast × 0.08)` | `mix(surface, accent, 0.11 + contrast × 0.04)` |
| accent-soft-hover | accent-soft 亮度微调 | accent-soft 亮度微调 |

### 3.3 完整派生函数

```typescript
// src/renderer/themes/derive.ts

function deriveTokens(theme: BuddyTheme): Record<string, string> {
  const { surface, ink, accent, success, danger, contrast, type, overrides } = theme
  const c = contrast / 100  // 归一化到 0-1

  const isDark = type === 'dark'

  // ---- 背景 ----
  const bgElevated = isDark
    ? mixHex(surface, ink, 0.08 + c * 0.08)
    : mixHex(surface, ink, 0.16 + c * 0.12)

  const bgSubtle = isDark
    ? withAlpha(ink, 0.02 + c * 0.02)
    : mixHex(surface, ink, 0.08 + c * 0.08)

  const bgMuted = isDark
    ? withAlpha(ink, 0.04 + c * 0.03)
    : mixHex(surface, ink, 0.12 + c * 0.10)

  // ---- 文字 ----
  const fgSecondary = withAlpha(ink, 0.65 + c * 0.10)
  const fgMuted = isDark
    ? withAlpha(ink, 0.42 + c * 0.13)
    : withAlpha(ink, 0.45 + c * 0.10)
  const fgInverse = surface

  // ---- 边框 ----
  const border = withAlpha(ink, 0.06 + c * 0.04)
  const borderSubtle = withAlpha(ink, 0.04 + c * 0.02)

  // ---- 主操作按钮（原 accent 语义） ----
  const accentPrimary = ink           // light=黑, dark=白
  const accentPrimaryHover = isDark ? lighten(ink, 0.08) : darken(ink, 0.08)

  // ---- 彩色强调 ----
  const accentHover = isDark ? lighten(accent, 0.12) : darken(accent, 0.08)
  const accentSoft = isDark
    ? mixHex('#000000', accent, 0.20 + c * 0.08)
    : mixHex(surface, accent, 0.11 + c * 0.04)
  const accentSoftHover = isDark
    ? lighten(accentSoft, 0.06)
    : darken(accentSoft, 0.04)

  // ---- 语义色 ----
  const successBg = withAlpha(success, isDark ? 0.15 : 0.12)
  const dangerHover = isDark ? lighten(danger, 0.08) : darken(danger, 0.08)

  // ---- 状态色 ----
  const statusRunning = success
  const statusPaused = withAlpha(ink, 0.5 + c * 0.1)

  // ---- 滚动条 ----
  const scrollbarThumb = withAlpha(ink, isDark ? 0.06 + c * 0.03 : 0.06 + c * 0.04)
  const scrollbarThumbHover = withAlpha(ink, isDark ? 0.10 + c * 0.04 : 0.10 + c * 0.05)

  // ---- 组装 ----
  const tokens: Record<string, string> = {
    '--bg': surface,
    '--bg-elevated': bgElevated,
    '--bg-subtle': bgSubtle,
    '--bg-muted': bgMuted,
    '--fg': ink,
    '--fg-secondary': fgSecondary,
    '--fg-muted': fgMuted,
    '--fg-inverse': fgInverse,
    '--border': border,
    '--border-subtle': borderSubtle,
    '--accent': accent,                // 新语义：彩色强调！
    '--accent-hover': accentHover,
    '--accent-soft': accentSoft,
    '--accent-soft-hover': accentSoftHover,
    '--accent-primary': accentPrimary,  // 新增：原 accent 语义
    '--accent-primary-hover': accentPrimaryHover,
    '--success-bg': successBg,
    '--success-fg': success,
    '--danger': danger,
    '--danger-hover': dangerHover,
    '--status-running': statusRunning,
    '--status-paused': statusPaused,
    '--scrollbar-thumb': scrollbarThumb,
    '--scrollbar-thumb-hover': scrollbarThumbHover,
    '--actor-claude': '#8b6dba',
    '--actor-codex': '#4a9bb5',
    '--actor-opencode': '#d97706',
    '--actor-kimi': '#2e7d32',
  }

  // 应用用户覆盖
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (tokens[key] !== undefined) {
        tokens[key] = value
      }
    }
  }

  return tokens
}
```

---

## 四、用户可调设置（学习 Codex App）

Codex App 的外观设置允许用户精细控制每个主题参数。Buddy 采用同样的思路：

### 4.1 设置项清单

| 设置项 | 类型 | 默认值 | 说明 |
|-------|------|-------|------|
| **主题模式** | `light / dark / system` | system | 控制亮暗模式 |
| **配色方案** | 从预设列表选择 | buddy-dark / buddy-light | 选择主题风格 |
| **Surface（主背景色）** | 颜色选择器 | 跟随主题 | 主背景色 |
| **Ink（主文字色）** | 颜色选择器 | 跟随主题 | 主文字色 |
| **Accent（强调色）** | 颜色选择器 | 跟随主题 | 彩色强调色 |
| **Success（成功色）** | 颜色选择器 | 跟随主题 | 成功/运行状态色 |
| **Danger（危险色）** | 颜色选择器 | 跟随主题 | 危险/删除色 |
| **Contrast（对比度）** | 滑块 0-100 | 60(dark) / 45(light) | 层级区分强度 |

### 4.2 设置界面设计

参考 Codex App 的外观设置布局：

```
┌─────────────────────────────────────────────────────────┐
│  外观 Appearance                                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  主题模式 Theme Mode                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐               │
│  │  ☀ Light │ │  🌙 Dark │ │  💻 Auto │               │
│  └──────────┘ └──────────┘ └──────────┘               │
│                                                         │
│  配色方案 Color Scheme                                   │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐     │
│  │ Buddy   │ │ Dracula │ │Catppuccin│ │  Nord   │     │
│  │█████████│ │█████████│ │█████████│ │█████████│     │
│  │   ●     │ │   ●     │ │   ●     │ │   ●     │     │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘     │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐     │
│  │Tokyo Ngt│ │ Gruvbox │ │Rose Pine│ │ GitHub  │     │
│  │█████████│ │█████████│ │█████████│ │█████████│     │
│  │   ●     │ │   ●     │ │   ●     │ │   ●     │     │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘     │
│  ... 更多主题 ...                                        │
│                                                         │
│  自定义颜色 Custom Colors                                │
│  ┌───────────────────────────────────────────────────┐ │
│  │ Surface (主背景)  [■ #18181a]          [重置]     │ │
│  │ Ink (主文字)      [■ #e8e8e3]          [重置]     │ │
│  │ Accent (强调色)   [■ #339cff]          [重置]     │ │
│  │ Success (成功色)  [■ #40c977]          [重置]     │ │
│  │ Danger (危险色)   [■ #fa423e]          [重置]     │ │
│  └───────────────────────────────────────────────────┘ │
│                                                         │
│  对比度 Contrast                                         │
│  ○────────────●────────────────────○  60               │
│  低                                              高     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 4.3 交互逻辑

1. **选择配色方案** → 所有核心色值恢复为该主题的默认值，contrast 恢复默认
2. **调整核心色** → 该色值变为用户自定义，保留其他核心色的当前值
3. **调整 contrast** → 所有派生色实时更新
4. **重置单个颜色** → 恢复为当前主题的默认值
5. **切换主题模式** → 配色方案列表自动过滤为匹配模式的主题（dark 模式只显示暗色主题），如果当前主题没有对应模式的变体，自动回退到默认主题

### 4.4 持久化策略

```typescript
// localStorage 键
{
  "theme-mode": "dark",                        // light/dark/system
  "theme-id": "dracula",                       // 主题 ID
  "theme-custom": {                            // 用户自定义覆盖（仅存差异）
    "surface": "#1e1e2e",                      // 用户修改了 surface
    "contrast": 55                              // 用户调整了 contrast
  }
}
```

**关键：`theme-custom` 只保存用户实际修改过的字段**，未修改的字段不存储。切换主题时清空 custom。这样既保证了用户自定义的持久化，又避免了主题升级后旧 custom 值的冲突。

---

## 五、预设主题清单

### 5.1 暗色主题（15 个）

| ID | 名称 | surface | ink | accent | success | danger | contrast |
|----|------|---------|-----|--------|---------|--------|----------|
| buddy-dark | Buddy Dark | #18181a | #e8e8e3 | #339cff | #40c977 | #fa423e | 60 |
| codex-dark | Codex Dark | #111111 | #ffffff | #0169cc | #40c977 | #fa423e | 60 |
| dracula | Dracula | #282a36 | #f8f8f2 | #ff79c6 | #50fa7b | #ff5555 | 60 |
| catppuccin-mocha | Catppuccin Mocha | #1e1e2e | #cdd6f4 | #cba6f7 | #a6e3a1 | #f38ba8 | 58 |
| catppuccin-macchiato | Catppuccin Macchiato | #181825 | #cad3f8 | #c7a4f5 | #a6da95 | #ed8796 | 58 |
| nord | Nord | #2e3440 | #d8dee9 | #88c0d0 | #a3be8c | #bf616a | 55 |
| one-dark-pro | One Dark Pro | #282c34 | #abb2bf | #4d78cc | #98c379 | #e06c75 | 60 |
| tokyo-night | Tokyo Night | #1a1b26 | #a9b1d6 | #7aa2f7 | #9ece6a | #f7768e | 58 |
| gruvbox-dark | Gruvbox Dark | #282828 | #ebdbb2 | #fe8019 | #b8bb26 | #fb4934 | 55 |
| kanagawa | Kanagawa Wave | #1f1f28 | #dcd7ba | #658594 | #76956a | #c34043 | 55 |
| rose-pine | Rose Pine | #191724 | #e0def4 | #ebbcba | #31748f | #eb6f92 | 58 |
| github-dark | GitHub Dark | #0d1117 | #e6edf3 | #1f6feb | #3fb950 | #f85149 | 50 |
| material-palenight | Material Palenight | #292d3e | #eeffff | #80cbc4 | #c3e88d | #ff5370 | 58 |
| ayu-dark | Ayu Dark | #0b0e14 | #bfbdb6 | #e6b450 | #c2d94c | #f07178 | 55 |
| vitesse-dark | Vitesse Dark | #121212 | #dbd7ca | #4d9375 | #80a665 | #cb7676 | 55 |

### 5.2 亮色主题（8 个）

| ID | 名称 | surface | ink | accent | success | danger | contrast |
|----|------|---------|-----|--------|---------|--------|----------|
| buddy-light | Buddy Light | #f3f3f1 | #1c1c1a | #339cff | #00a240 | #ba2623 | 45 |
| codex-light | Codex Light | #ffffff | #1a1c1f | #0169cc | #00a240 | #ba2623 | 45 |
| catppuccin-latte | Catppuccin Latte | #eff1f5 | #4c4f69 | #8839ef | #40a02b | #d20f39 | 45 |
| github-light | GitHub Light | #ffffff | #1f2328 | #0969da | #1a7f37 | #cf222e | 42 |
| gruvbox-light | Gruvbox Light | #fbf1c7 | #3c3836 | #af3a03 | #79740e | #9d0006 | 45 |
| kanagawa-lotus | Kanagawa Lotus | #f2ecbc | #5c5144 | #c47247 | #6f894e | #c34043 | 45 |
| one-light | One Light | #fafafa | #383a42 | #526fff | #50a14f | #e45649 | 45 |
| rose-pine-dawn | Rose Pine Dawn | #faf4ed | #575279 | #d7827e | #286983 | #b4637a | 42 |

### 5.3 Buddy Dark / Buddy Light 说明

`buddy-dark` 和 `buddy-light` 是默认主题，其核心色值与当前硬编码值对齐：

| 核心色 | Buddy Dark | Buddy Light | 对应现有值 |
|-------|-----------|-------------|-----------|
| surface | #18181a | #f3f3f1 | = `--bg` |
| ink | #e8e8e3 | #1c1c1a | = `--fg` |
| accent | #339cff | #339cff | **新增彩色强调**（原无） |
| success | #40c977 | #00a240 | ≈ `--success-fg` |
| danger | #fa423e | #ba2623 | ≈ `--danger` |

新增 accent 彩色强调后，Buddy 默认主题不再是纯中性灰，而是带有蓝色强调色（与 Codex App 一致），但整体视觉风格保持不变。

---

## 六、accent 语义变更处理

这是改造中最大的破坏性变更，需要重点处理。

### 6.1 变更内容

| | 旧语义 | 新语义 |
|--|-------|-------|
| `--accent` | 反转色（light=黑, dark=白）用于按钮背景 | **彩色强调色**（如 #339cff）用于链接、选中态、高亮 |
| 按钮/操作背景 | `--accent` | `--accent-primary`（保持反转色语义） |

### 6.2 受影响的组件

| 组件 | 当前用法 | 改造后 |
|------|---------|-------|
| AppearanceSettings 选中态 | `border-accent ring-accent` | `border-accent-primary ring-accent-primary` |
| 各种按钮 bg-bg | `bg-accent` | `bg-accent-primary` |
| 链接 hover | `color: var(--accent)` | `color: var(--accent)`（现在真的是彩色了！） |
| 选中项高亮 | 无彩色 | `bg-accent-soft text-accent` |

### 6.3 Tailwind 配置更新

```javascript
// tailwind.config.js 新增映射
colors: {
  // ... 原有 20 个 ...
  'accent-primary': 'var(--accent-primary)',
  'accent-primary-hover': 'var(--accent-primary-hover)',
  'status-running': 'var(--status-running)',
  'status-paused': 'var(--status-paused)',
  'scrollbar-thumb': 'var(--scrollbar-thumb)',
  'scrollbar-thumb-hover': 'var(--scrollbar-thumb-hover)',
  'actor-claude': 'var(--actor-claude)',
  'actor-codex': 'var(--actor-codex)',
  'actor-opencode': 'var(--actor-opencode)',
  'actor-kimi': 'var(--actor-kimi)',
}
```

---

## 七、硬编码清理清单

### 7.1 globals.css 清理

| 当前代码 | 问题 | 改造方案 |
|---------|------|---------|
| `.msg-claude { border-left-color: #8b6dba }` (4处) | 品牌色硬编码 | → `var(--actor-claude)` |
| `.msg-claude { background: color-mix(..., #8b6dba 5%, ...) }` | 品牌色硬编码 | → `color-mix(in srgb, var(--actor-claude) 5%, var(--bg-elevated))` |
| `.msg-claude .role { color: #8b6dba }` (4处) | 品牌色硬编码 | → `var(--actor-claude)` |
| `.status-dot-running { background: #1e3932 }` + `.dark` | 暗亮双份 | → `var(--status-running)` |
| `.status-dot-paused { background: #6d5014 }` + `.dark` | 暗亮双份 | → `var(--status-paused)` |
| `.status-text-running/paused` + `.dark` | 暗亮双份 | → `var(--status-running)` / `var(--status-paused)` |
| `.task-brief-card` 全部 15 色硬编码 | 不响应暗色 | → 全部替换为 `var(--bg-elevated)` 等 token |
| `@keyframes buddy-breathe` + `buddy-breathe-dark` | 两套 keyframe | → 合并为一套，用 `var(--success-fg)` |
| `::-webkit-scrollbar-thumb` + `.dark` | 两套值 | → `var(--scrollbar-thumb)` |

### 7.2 组件清理

| 文件 | 问题 | 改造方案 |
|------|------|---------|
| `SettingsContent.tsx` ActorBadge | 内联 `style={{ backgroundColor: color }}` 硬编码 4 色 | → `var(--actor-*)` |
| 所有使用 `accent` 做"按钮背景"的组件 | accent 语义变更 | → 改用 `accent-primary` |

---

## 八、运行时集成

### 8.1 主题应用函数

```typescript
// src/renderer/themes/apply.ts

export function applyTheme(theme: BuddyTheme): void {
  const root = document.documentElement
  const tokens = deriveTokens(theme)

  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(key, value)
  }

  // 维护 .dark class（兼容期）
  root.classList.toggle('dark', theme.type === 'dark')
}
```

### 8.2 useTheme 改造

```typescript
// src/renderer/hooks/useTheme.ts

export type ThemeMode = 'light' | 'dark' | 'system'

interface ThemeState {
  mode: ThemeMode
  themeId: string
  custom: Partial<Pick<BuddyTheme, 'surface' | 'ink' | 'accent' | 'success' | 'danger' | 'contrast'>>
  resolvedMode: 'light' | 'dark'
  setMode: (mode: ThemeMode) => void
  setThemeId: (id: string) => void
  setCustom: (custom: ThemeState['custom']) => void
  resetCustom: () => void
}
```

### 8.3 数据流

```
用户操作
  ├─ 切换模式 → setMode() → 持久化 theme-mode
  ├─ 选择主题 → setThemeId() → 持久化 theme-id → 清空 custom
  ├─ 调整颜色 → setCustom() → 持久化 theme-custom → 实时 applyTheme
  └─ 调整对比度 → setCustom({contrast}) → 持久化 → 实时 applyTheme

useTheme()
  │
  ├─ 读取 mode → resolveMode() → resolvedMode
  ├─ 读取 themeId → getThemeDef(themeId) → BuddyTheme
  ├─ 读取 custom → 合并覆盖 → 最终 BuddyTheme
  └─ applyTheme(最终主题)
       ├─ deriveTokens() → 30 个 CSS 变量
       └─ setProperty() on :root
            └─ Tailwind utilities 自动响应
```

---

## 九、文件结构

```
src/renderer/themes/
  ├── color.ts          # 颜色工具函数（parseHex, mixHex, withAlpha 等）
  ├── derive.ts         # 派生算法（deriveTokens）
  ├── apply.ts          # 主题应用函数（applyTheme）
  ├── definitions.ts    # 预设主题定义（23 个 BuddyTheme）
  └── index.ts          # 统一导出

src/renderer/hooks/
  └── useTheme.ts       # 改造：支持 themeId + custom

src/renderer/components/
  └── SettingsContent.tsx  # 改造：新增配色方案选择器 + 自定义颜色 + contrast 滑块
```

---

## 十、实施步骤

| 阶段 | 内容 | 涉及文件 |
|------|------|---------|
| **Phase 1：主题引擎** | color.ts + derive.ts + apply.ts + definitions.ts | 新建 5 个文件 |
| **Phase 2：Hook 改造** | useTheme 支持 themeId + custom | useTheme.ts |
| **Phase 3：Tailwind 更新** | 新增 10 个 token 映射 | tailwind.config.js |
| **Phase 4：accent 迁移** | 全局搜索 `accent` 用法，语义变更 + 新增 `accent-primary` | globals.css + 多个组件 |
| **Phase 5：硬编码清理** | 品牌色 token 化 + 状态色 token 化 + task-brief-card + scrollbar + breathe 动画 | globals.css + SettingsContent.tsx |
| **Phase 6：设置界面** | 配色方案选择器 + 自定义颜色面板 + contrast 滑块 | SettingsContent.tsx |
| **Phase 7：i18n** | 新增翻译键 | i18n.ts |
| **Phase 8：测试验证** | 每个预设主题的视觉效果 + 自定义颜色 + contrast 调整 + 持久化 | - |

---

## 十一、关键设计决策

| 决策点 | 方案 | 理由 |
|-------|------|------|
| 派生引擎 | Codex contrast-aware 算法 | 已在线上验证，比手工维护固定值更成熟 |
| contrast 参数 | 纳入，用户可调 | 不同主题需要不同的层级区分强度 |
| overrides 逃生舱 | 不单独设，通过 custom 实现 | custom 本身就是"覆盖默认派生结果" |
| accent 语义 | 变更为彩色强调 | 与 Codex 对齐，现有"反转色"改用 accent-primary |
| 品牌色是否主题化 | 跨主题不变，但 token 化 | 品牌识别 > 主题统一；token 化消除硬编码重复 |
| 主题数量 | 23 个（15 暗 + 8 亮） | 覆盖主流风格，避免选择过载 |
| mode 与 themeId 的关系 | 独立，切换 mode 时自动过滤主题列表 | 用户可精确控制，有合理回退 |
| `.dark` class | 保留作为过渡期兼容 | 部分 CSS 选择器依赖 `.dark` |
| 主题数据体积 | 23 个主题定义约 5KB | 全部内联，无需按需加载 |
| custom 持久化 | 仅存差异字段 | 避免主题升级后旧值冲突 |
