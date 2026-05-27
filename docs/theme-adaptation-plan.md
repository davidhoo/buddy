# Buddy 主题方案：Codex App 主题体系深度分析与适配

> 基于 `codex-app-themes-2026-05-26-235145` 导出数据的完整分析

## 一、Codex App 主题体系分析

### 1.1 双层架构

Codex App 的主题系统分为两层：

| 层级 | 作用 | 数据量 | 格式 |
|------|------|--------|------|
| **Chrome Theme** | App 外壳 UI（非编辑器区域） | 极简：5 核心值 + contrast + 3 语义色 | `{ dark: {...}, light: {...} }` |
| **Code Theme** | 代码编辑器区域 | 丰富：24~564 个颜色 + 8~276 个语法 token | VS Code 兼容格式 |

**关键洞察：** Chrome Theme 是 Codex 主题体系的核心引擎。Code Theme 仅用于编辑器区域，Buddy 不需要。

### 1.2 Chrome Theme 核心数据结构

```json
{
  "dark": {
    "accent": "#339cff",        // 强调色
    "contrast": 60,             // 对比度（0-100），控制 UI 层级视觉区分强度
    "ink": "#ffffff",           // 主文字色
    "surface": "#181818",       // 主背景色
    "opaqueWindows": false,     // 窗口不透明（macOS 专属）
    "fonts": { "code": null, "ui": null },
    "semanticColors": {
      "diffAdded": "#40c977",   // diff 新增
      "diffRemoved": "#fa423e", // diff 删除
      "skill": "#ad7bf9"        // 技能/标签
    }
  },
  "light": {
    "accent": "#339cff",
    "contrast": 45,
    "ink": "#1a1c1f",
    "surface": "#ffffff",
    "opaqueWindows": false,
    "fonts": { "code": null, "ui": null },
    "semanticColors": {
      "diffAdded": "#00a240",
      "diffRemoved": "#ba2623",
      "skill": "#924ff7"
    }
  }
}
```

### 1.3 Chrome Theme 运行时派生算法（核心发现）

Codex **不是**存储全部 CSS 变量值，而是仅存储 5 个核心色值 + contrast，运行时通过算法派生约 50 个 CSS 变量。这是整个主题体系最精妙的部分。

#### 1.3.1 核心工具函数

```typescript
// 颜色线性插值（lerp）
function lerpColor(a: RGB, b: RGB, ratio: number): RGB {
  return {
    red:   Math.round(a.red   + (b.red   - a.red)   * ratio),
    green: Math.round(a.green + (b.green - a.green) * ratio),
    blue:  Math.round(a.blue  + (b.blue  - a.blue)  * ratio),
  }
}

// 混合后输出 hex
function mix(a: HexColor, b: HexColor, ratio: number): HexColor

// 混合后输出 rgba
function withAlpha(rgb: RGB, alpha: number): string
  // => `rgba(r, g, b, alpha)`
```

#### 1.3.2 contrast 的作用机制

`contrast`（0-100）是一个乘数，影响几乎所有派生色的混合比例：

- 暗色默认 `contrast=60`，亮色默认 `contrast=45`
- contrast 越高 → 层级差异越明显（border 更深、elevated 更亮、hover 更突出）
- contrast 越低 → 更扁平、更统一

**contrast 在派生公式中的典型用法：**

```
border 不透明度     = 0.06 + contrast * 0.04      (light/dark 通用)
elevated 混合比例    = 0.09 + contrast * 0.04      (light)
accentBg 混合比例    = 0.11 + contrast * 0.04      (light)
hover 增量          = contrast * 0.01 ~ 0.06       (各控件)
textSecondary 不透明 = 0.65 + contrast * 0.1        (light/dark)
textTertiary 不透明  = 0.45 + contrast * 0.1        (light/dark)
```

#### 1.3.3 亮色模式派生逻辑（简化）

```
输入：surface(白), ink(黑), accent(蓝), contrast(45)

border:          ink @ 0.06 + contrast*0.04      → ~24% 黑
borderLight:     ink @ 0.04 + contrast*0.02      → ~13% 黑
borderHeavy:     ink @ 0.09 + contrast*0.06      → ~36% 黑

elevatedPrimary:  mix(surface, ink, 0.16 + contrast*0.12)  → 深灰白
elevatedSecondary: mix(surface, ink, 0.08 + contrast*0.08)  → 浅灰白

accentBg:        mix(surface, accent, 0.11 + contrast*0.04) → 淡蓝

buttonPrimary:   ink (黑底)
buttonSecondary: ink @ 0.04 + contrast*0.02      → ~6% 黑底

textFg:          ink
textSecondary:   ink @ 0.65 + contrast*0.1       → ~55% 黑
textTertiary:    ink @ 0.45 + contrast*0.1       → ~35% 黑
```

#### 1.3.4 暗色模式派生逻辑（简化）

```
输入：surface(深灰), ink(白), accent(蓝), contrast(60)

border:          ink @ 0.06 + contrast*0.04      → ~30% 白
elevatedPrimary: mix(surface, ink, 0.08 + contrast*0.08)  → 更深的灰
elevatedSecondary: ink @ 0.02 + contrast*0.02    → ~5% 白

accentBg:        mix(#000, accent, 0.2 + contrast*0.08)   → 深蓝

buttonPrimary:   mix(surface, #000, 0.38 + contrast*0.12) → 非常深的底
buttonSecondary: ink @ 0.04 + contrast*0.02      → ~8% 白

textFg:          ink (白)
textSecondary:   ink @ 0.65 + contrast*0.1       → ~75% 白
textTertiary:    ink @ 0.42 + contrast*0.13      → ~50% 白
```

#### 1.3.5 完整的 CSS 变量输出

Codex 最终输出约 50 个 CSS 变量：

| 分类 | 变量 | 数量 |
|------|------|------|
| 基础 | `--codex-base-accent/contrast/ink/surface` | 4 |
| 背景-表面 | `--color-background-surface/under/panel` | 3 |
| 背景-提升 | `--color-background-elevated-primary/secondary` (+ opaque) | 4 |
| 背景-控件 | `--color-background-control` (+ opaque) | 2 |
| 背景-编辑器 | `--color-background-editor-opaque` | 1 |
| 背景-强调 | `--color-background-accent/active/hover` | 3 |
| 背景-按钮 | `--color-background-button-primary/secondary/tertiary` (+ active/hover/inactive) | 12 |
| 边框 | `--color-border/focus/heavy/light` | 4 |
| 文字 | `--color-text-foreground/secondary/tertiary/accent/button-*` | 6 |
| 图标 | `--color-icon-primary/secondary/tertiary/accent` | 4 |
| 装饰 | `--color-decoration-added/deleted`, `--color-editor-added/deleted` | 4 |
| 其他 | `--color-accent-blue/purple`, `--color-simple-scrim` | 3 |

### 1.4 Code Theme 数据概览

69 个主题，47 暗 + 22 亮：

| 代表主题 | 类型 | UI colors | 语法 tokens | 特色 |
|----------|------|-----------|-------------|------|
| Codex Dark | dark | 24 | 245 | 极简 UI，丰富语法 |
| Dracula | dark | 195 | 85 | 经典暗色 |
| Catppuccin Mocha | dark | 564 | 179 | 最丰富的 UI 定义 |
| GitHub Dark Default | dark | 241 | 49 | GitHub 风格 |
| Nord | dark | 303 | 140 | 冰冷北欧风 |
| Tokyo Night | dark | 353 | 114 | 日系暗色 |
| Gruvbox Dark Medium | dark | 258 | 127 | 复古暖调 |
| Rose Pine | dark | 464 | 33 | 优雅玫瑰紫 |
| Catppuccin Latte | light | 564 | 179 | 温暖亮色 |
| GitHub Light Default | light | 237 | 49 | GitHub 亮色 |

**Code Theme 对 Buddy 的价值：** 仅用于提取 `colors` 字段中的关键 UI 颜色（editor.background, sideBar.background, button.background 等），映射为 Buddy 主题的核心色值。

---

## 二、Codex 主题 vs Buddy 现有体系对比

### 2.1 架构对比

| 维度 | Codex | Buddy 现状 |
|------|-------|-----------|
| 核心色数量 | 5 (surface, ink, accent, diffAdded, diffRemoved) + contrast | 0（硬编码 20 个值） |
| 派生变量数量 | ~50 | 0 |
| CSS 变量总数 | ~54 | 20 |
| 主题切换 | 任意主题，运行时派生全部变量 | 仅 light/dark，固定色值 |
| contrast 机制 | 有，控制层级区分度 | 无 |
| 按钮/控件层级 | 三级（primary/secondary/tertiary） | 无区分 |

### 2.2 Buddy 现有 20 个 token 的映射分析

| Buddy token | 现有 light | 现有 dark | Codex 对应 | 映射方式 |
|-------------|-----------|----------|------------|---------|
| `--bg` | #f3f3f1 | #18181a | `surface` | 直接 |
| `--bg-elevated` | #ffffff | #1f1f22 | `elevatedPrimary` | 派生 |
| `--bg-subtle` | #ececea | #27272a | `elevatedSecondary` | 派生 |
| `--bg-muted` | #e0e0dc | #2e2e32 | `controlBackground` | 派生 |
| `--fg` | #1c1c1a | #e8e8e3 | `ink` / `textForeground` | 直接/派生 |
| `--fg-secondary` | #6b6b66 | #a1a1a0 | `textForegroundSecondary` | 派生 |
| `--fg-muted` | #9a9a93 | #6b6b68 | `textForegroundTertiary` | 派生 |
| `--fg-inverse` | #ffffff | #18181a | `surface` | 直接 |
| `--border` | #e5e5e2 | #2a2a2e | `border` | 派生 |
| `--border-subtle` | #ededea | #232326 | `borderLight` | 派生 |
| `--accent` | #1c1c1a | #f5f5f3 | ⚠️ **无对应** | 需重新定义 |
| `--accent-hover` | #000000 | #ffffff | ⚠️ **无对应** | 需重新定义 |
| `--accent-soft` | #d8d8d4 | #3a3a3e | `accentBackground` | 派生 |
| `--accent-soft-hover` | #c8c8c4 | #44444a | `accentBackgroundHover` | 派生 |
| `--success-bg` | #e8f0e8 | rgba(...) | `diffAdded` + alpha | 派生 |
| `--success-fg` | #2e7d32 | #66bb6a | `diffAdded` | 直接/语义色 |
| `--danger` | #c82014 | #ef4444 | `diffRemoved` | 直接/语义色 |
| `--danger-hover` | #a01a10 | #dc2626 | `diffRemoved` 微调 | 派生 |

### 2.3 关键问题：accent 的定义

**Buddy 现有的 `--accent` 实质是"反转主色"（light 下黑、dark 下白），不是真正的彩色强调色。** 这与 Codex 的 `accent`（真正的品牌强调色，如 #339cff 蓝色）语义完全不同。

**解决方案：** 引入 Codex 语义的 `--accent`（彩色强调色），现有 accent 改名为 `--fg-action` 或直接用 `buttonPrimaryBackground` 语义。

### 2.4 现有硬编码颜色清单

| 位置 | 硬编码色 | 问题 |
|------|---------|------|
| `globals.css:83-96` | Actor 品牌色（#8b6dba 等 ×4） | 不参与主题 |
| `globals.css:277-280` | status-dot-running/paused | 走 `.dark` 选择器而非 token |
| `globals.css:302-305` | status-text-running/paused | 同上 |
| `globals.css:111-144` | task-brief-card 全部 15 色 | 强制白底，不响应暗色 |
| `globals.css:328-338` | breathe 动画 | 两套硬编码 keyframe |
| `globals.css:353-367` | scrollbar | 两套硬编码值 |

---

## 三、Buddy 适配方案

### 3.1 核心思路

**采用 Codex 的 Chrome Theme 派生引擎，而非简单的色值映射。**

理由：
1. Codex 的 `surface + ink + accent + contrast` 四值驱动 + 运行时派生，比手工维护 20 个固定值更优雅
2. `contrast` 参数让不同主题可以微调层级强度，而非一刀切
3. 约 50 个 CSS 变量比 20 个更丰富，覆盖按钮/图标/控件等细分层级
4. 从 Code Theme 的 colors 字段提取核心色值，可复用 69 个现成主题

### 3.2 Buddy 主题定义格式

```typescript
interface BuddyTheme {
  id: string;           // 'dracula', 'catppuccin-mocha'
  name: string;         // 'Dracula', 'Catppuccin Mocha'
  type: 'dark' | 'light';

  // 核心色（5 个，从 Code Theme colors 提取）
  surface: string;      // 主背景 → editor.background
  ink: string;          // 主文字 → editor.foreground
  accent: string;       // 强调色 → focusBorder / button.background
  successFg: string;    // 成功色 → gitDecoration.addedResourceForeground
  danger: string;       // 危险色 → gitDecoration.deletedResourceForeground

  // 对比度（0-100）
  contrast: number;     // 暗色推荐 50-65，亮色推荐 40-55

  // 可选覆盖（大多数主题不需要）
  overrides?: Partial<DerivedTokens>;  // 手工微调特定 token
}
```

**与现有 proposal 的关键区别：**
- 新增 `contrast` 参数（核心差异化特性）
- 新增 `overrides` 逃生舱（解决派生算法无法覆盖的边缘情况）
- `accent` 含义变更：从"反转色"变为"彩色强调色"

### 3.3 派生算法

直接移植 Codex 的 `light/dark` 两条派生路径，输出 Buddy 的全部 CSS 变量：

```typescript
interface DerivedTokens {
  // === 背景 ===
  '--bg': string;                    // surface
  '--bg-elevated': string;           // elevatedPrimary
  '--bg-subtle': string;             // elevatedSecondary
  '--bg-muted': string;              // controlBackground

  // === 文字 ===
  '--fg': string;                    // ink / textForeground
  '--fg-secondary': string;          // textForegroundSecondary
  '--fg-muted': string;              // textForegroundTertiary
  '--fg-inverse': string;            // surface（反色=背景色）

  // === 边框 ===
  '--border': string;                // border
  '--border-subtle': string;         // borderLight

  // === 强调 ===
  '--accent': string;                // accent（彩色！）
  '--accent-hover': string;          // accent 微调亮/暗
  '--accent-soft': string;           // accentBackground
  '--accent-soft-hover': string;     // accentBackgroundHover

  // === 语义 ===
  '--success-bg': string;            // diffAdded @ low alpha
  '--success-fg': string;            // diffAdded
  '--danger': string;                // diffRemoved
  '--danger-hover': string;          // diffRemoved 微调

  // === 新增（Buddy 扩展，Codex 无） ===
  '--status-running': string;        // 运行中状态色
  '--status-paused': string;         // 暂停状态色
  '--actor-claude': string;          // 品牌色
  '--actor-codex': string;
  '--actor-opencode': string;
  '--actor-kimi': string;
  '--scrollbar-thumb': string;       // 滚动条
  '--scrollbar-thumb-hover': string;
}
```

### 3.4 从 Code Theme 提取核心色的映射规则

| Buddy 核心色 | Code Theme colors 来源 | 优先级（从高到低） |
|-------------|----------------------|-------------------|
| `surface` | `editor.background` | 唯一来源 |
| `ink` | `editor.foreground` → `foreground` | 优先 editor.foreground |
| `accent` | `focusBorder`（去透明度）→ `button.background`（去透明度）→ `activityBarBadge.background` | 按可用性递补，去透明度后取色 |
| `successFg` | `gitDecoration.addedResourceForeground` → `diffEditor.insertedTextBackground` 去透明度 | 递补 |
| `danger` | `gitDecoration.deletedResourceForeground` → `diffEditor.removedTextBackground` 去透明度 | 递补 |
| `contrast` | 根据 type 设置默认值（dark=60, light=45），可手工调整 | 默认值 |

### 3.5 推荐主题清单

从 69 个 Code Theme 中，按以下标准筛选：
- 至少包含 `editor.background` + `editor.foreground` + `focusBorder`（3 个必需核心色）
- 辨识度高，有鲜明的视觉个性
- 无极端对比度问题

#### 暗色主题（15 个）

| 主题 ID | 名称 | surface | accent | contrast | 特点 |
|---------|------|---------|--------|----------|------|
| `codex-dark` | Codex Dark | #111111 | #0169cc | 60 | 原生蓝调 |
| `dracula` | Dracula | #282A36 | #FF79C6 | 60 | 粉紫经典 |
| `catppuccin-mocha` | Catppuccin Mocha | #1e1e2e | #cba6f7 | 58 | 薰衣草紫 |
| `catppuccin-macchiato` | Catppuccin Macchiato | #181825 | #c7a4f5 | 58 | 更深的紫 |
| `nord` | Nord | #2e3440 | #88c0d0 | 55 | 冰蓝绿 |
| `one-dark-pro` | One Dark Pro | #282c34 | #4d78cc | 60 | Atom 蓝 |
| `tokyo-night` | Tokyo Night | #1a1b26 | #7aa2f7 | 58 | 日系蓝紫 |
| `gruvbox-dark-medium` | Gruvbox Dark Medium | #282828 | #fe8019 | 55 | 复古橙 |
| `kanagawa-wave` | Kanagawa Wave | #1F1F28 | #658594 | 55 | 浮世绘柔蓝 |
| `rose-pine` | Rose Pine | #191724 | #ebbcba | 58 | 玫瑰紫 |
| `github-dark-default` | GitHub Dark Default | #0d1117 | #1f6feb | 50 | GitHub 蓝 |
| `material-theme-palenight` | Material Palenight | #292D3E | #80CBC4 | 58 | Material 紫 |
| `ayu-dark` | Ayu Dark | #0b0e14 | #e6b450 | 55 | 温暖橙粉 |
| `vitesse-dark` | Vitesse Dark | #121212 | #4d9375 | 55 | Vim 绿 |
| `synthwave-84` | Synthwave 84 | #262335 | #f97e72 | 60 | 赛博霓虹 |

#### 亮色主题（8 个）

| 主题 ID | 名称 | surface | accent | contrast | 特点 |
|---------|------|---------|--------|----------|------|
| `codex-light` | Codex Light | #ffffff | #0169cc | 45 | 原生蓝调 |
| `catppuccin-latte` | Catppuccin Latte | #eff1f5 | #8839ef | 45 | 温暖紫 |
| `github-light-default` | GitHub Light Default | #ffffff | #0969da | 42 | GitHub 蓝 |
| `gruvbox-light-medium` | Gruvbox Light Medium | #fbf1c7 | #458588 | 45 | 暖橙 |
| `kanagawa-lotus` | Kanagawa Lotus | #F2ECBC | #5A7785 | 45 | 日式暖橙 |
| `one-light` | One Light | #FAFAFA | #526FFF | 45 | Atom 蓝 |
| `rose-pine-dawn` | Rose Pine Dawn | #faf4ed | #d7827e | 42 | 柔紫清晨 |
| `vitesse-light` | Vitesse Light | #ffffff | #1c6b48 | 45 | 自然绿 |

---

## 四、改造方案

### 4.1 改造步骤总览

```
Phase 1: 主题引擎（数据层 + 派生算法）
   ↓
Phase 2: 运行时集成（Hook 改造 + 主题应用）
   ↓
Phase 3: UI 适配（硬编码清理 + 新 token 接入）
   ↓
Phase 4: 设置界面（主题选择器）
   ↓
Phase 5: 代码主题（可选，低优先级）
```

### Phase 1：主题引擎

**1.1 颜色工具函数** `src/renderer/themes/color.ts`

从 Codex 的原始 JS 移植核心颜色操作函数：
- `parseHex(hex)` → RGB
- `toHex(rgb)` → HexColor
- `toRgba(rgb, alpha)` → string
- `lerpColor(a, b, ratio)` → RGB
- `mixHex(a, b, ratio)` → HexColor（lerp + toHex）

**1.2 派生算法** `src/renderer/themes/derive.ts`

移植 Codex 的 `light/dark` 两条派生路径，输出 Buddy 的全部 CSS 变量：
- `deriveLightTokens(theme)` — 亮色派生
- `deriveDarkTokens(theme)` — 暗色派生
- `deriveTokens(theme)` — 根据 `theme.type` 自动选择路径
- 支持 `overrides` 逃生舱：派生后用 overrides 覆盖特定 token

**1.3 主题定义数据** `src/renderer/themes/definitions.ts`

从 69 个 Codex Code Theme JSON 中提取核心色值，转换为 `BuddyTheme[]`。

**1.4 自动化提取脚本** `scripts/codex-to-buddy-theme.ts`

批量将 Codex theme JSON → Buddy 主题格式的脚本，处理核心色映射和递补逻辑。

### Phase 2：运行时集成

**2.1 主题应用函数** `src/renderer/themes/apply.ts`

```typescript
function applyTheme(theme: BuddyTheme): void {
  const root = document.documentElement;
  const tokens = deriveTokens(theme);

  // 1. 设置全部 CSS 变量
  Object.entries(tokens).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });

  // 2. 维护 .dark class（兼容现有选择器过渡期）
  root.classList.toggle('dark', theme.type === 'dark');

  // 3. 过渡动画
  // root.style.transition = 'background-color 0.2s, color 0.2s';
}
```

**2.2 主题 Hook 改造** `src/renderer/hooks/useTheme.ts`

```typescript
// 现有：Theme = 'light' | 'dark' | 'system'
// 改造后：
type ThemeMode = 'light' | 'dark' | 'system';
type ThemeId = string; // 'codex-dark' | 'dracula' | ...

interface ThemeState {
  mode: ThemeMode;              // light/dark/system
  themeId: ThemeId;             // 主题 ID
  resolvedMode: 'light' | 'dark'; // 实际解析后的模式
  setMode: (mode: ThemeMode) => void;
  setTheme: (id: ThemeId) => void;
}
```

**关键逻辑：**
- `mode` 控制暗/亮，`themeId` 控制配色风格
- 切换 mode 时，自动切换到同系列对应变体（如 Dracula dark → 无对应亮色，回退到默认亮色）
- 推荐做法：主题列表按 mode 过滤，只显示匹配的主题

**持久化：**
- `localStorage('theme-mode')` — light/dark/system
- `localStorage('theme-id')` — 主题 ID

### Phase 3：UI 适配

**3.1 globals.css 清理**

| 改动 | 说明 |
|------|------|
| 移除 `:root` 和 `.dark` 下的固定色值 | 由 `applyTheme()` 动态设置 |
| 新增 `--status-running` / `--status-paused` token | 替代硬编码状态色 |
| 新增 `--actor-claude/codex/opencode/kimi` token | 品牌色 token 化 |
| 新增 `--scrollbar-thumb` / `--scrollbar-thumb-hover` token | 替代硬编码滚动条 |
| `.status-dot-running/paused` → `var(--status-*)` | 消除 `.dark` 分支 |
| `.task-brief-card` → `var(--bg-elevated)` 等 | 响应主题切换 |
| `breathe` 动画 → 单一 keyframe + `var(--success-fg)` | 消除两套 keyframe |
| scrollbar → `var(--scrollbar-*)` | 消除 `.dark` 分支 |

**3.2 品牌色处理**

```css
/* 默认品牌色（跨主题不变） */
:root {
  --actor-claude: #8b6dba;
  --actor-codex: #4a9bb5;
  --actor-opencode: #d97706;
  --actor-kimi: #2e7d32;
}
```

品牌色保持跨主题不变（品牌识别 > 主题统一），但通过 CSS 变量统一管理后：
- 消除代码中的硬编码重复（目前 3 处引用同一色值）
- 未来可支持主题自定义品牌色（通过 overrides）

**3.3 accent 语义变更处理**

现有组件中 `--accent` 的使用场景需要逐一审查：

| 使用场景 | 现有行为 | 改造后 |
|---------|---------|--------|
| 主操作按钮背景 | bg=黑/白（实为反转色） | 改用 `--button-primary-bg` |
| 选中态/hover 强调 | 软强调色 | 改用 `--accent-soft` |
| 文字链接 | 当前为 `--fg` | 改为 `--accent`（真正的彩色） |
| Activity Bar 选中 | 无 | 用 `--accent` |

### Phase 4：设置界面

**4.1 主题选择器 UI**

在 `AppearanceSettings` 中增加主题选择区域：
- 按 light/dark 分组展示（仅显示与当前 mode 匹配的主题）
- 每个主题显示为色卡预览（surface + accent + ink 三色条）
- 选中后立即预览（`applyTheme` 实时生效）
- 增加搜索/筛选功能（主题多时有用）

**4.2 预览色卡设计**

```
┌──────────────────────────┐
│ ████████████████████████ │  ← surface (背景色)
│ ████████████████████████ │
│         Dracula          │  ← ink (文字色)
│     ● FF79C6             │  ← accent (强调色圆点)
└──────────────────────────┘
```

### Phase 5：代码主题（可选）

如果 Buddy 未来支持代码块语法高亮：
- 直接复用 Codex 的 `tokenColors` + `semanticTokenColors` 数据
- 配合 highlight.js 或 Prism.js 的 VS Code 主题格式使用
- 每个 UI 主题可关联一个代码主题（默认用同名主题的 tokenColors）

---

## 五、数据流

```
┌─────────────────────────────────────────────────────┐
│ definitions.ts                                      │
│ BuddyTheme[] = [{ id, name, type, surface, ink,    │
│                  accent, successFg, danger,          │
│                  contrast, overrides? }]             │
└──────────────────────┬──────────────────────────────┘
                       │ 选取主题
                       ▼
┌─────────────────────────────────────────────────────┐
│ useTheme()                                          │
│ mode + themeId → resolvedTheme                      │
│ persist: localStorage('theme-mode', 'theme-id')     │
└──────────────────────┬──────────────────────────────┘
                       │ 调用 applyTheme()
                       ▼
┌─────────────────────────────────────────────────────┐
│ deriveTokens(theme)                                 │
│   ├─ parseHex(surface/ink/accent/...)               │
│   ├─ 根据 type 选择 deriveLight/deriveDark           │
│   ├─ 用 contrast 参数调整各混合比例                    │
│   ├─ 输出 ~30 个 CSS 变量                            │
│   └─ 应用 overrides（如有）                           │
└──────────────────────┬──────────────────────────────┘
                       │ setProperty on :root
                       ▼
┌─────────────────────────────────────────────────────┐
│ DOM                                                 │
│ :root { --bg, --fg, --accent, --border, ... }       │
│ .dark class 维护（过渡期兼容）                        │
│ Tailwind utilities 自动响应 CSS 变量变更              │
└─────────────────────────────────────────────────────┘
```

---

## 六、关键设计决策

| 决策点 | 方案 | 理由 |
|--------|------|------|
| 派生引擎 | 移植 Codex 的 contrast-aware 算法 | 比"7 核心色 + 简单 mix"更成熟，已在线上验证 |
| contrast 参数 | 纳入，每个主题可自定义 | 不同主题配色需要不同的层级区分强度 |
| overrides 逃生舱 | 纳入 | 某些主题的派生结果可能不理想，允许手工微调 |
| accent 语义 | 变更为彩色强调色 | 与 Codex 语义对齐，现有"反转色"改用 button-primary |
| 品牌色是否主题化 | 跨主题不变，但 token 化 | 品牌识别 > 主题统一；token 化消除重复 |
| 主题数量 | 先实现 23 个（15 暗 + 8 亮） | 覆盖主流风格，避免选择过载 |
| mode 与 themeId 的关系 | 两者独立，mode 切换时自动匹配同系列 | 用户可精确控制，也有合理回退 |
| `.dark` class | 保留作为过渡期兼容 | 部分第三方组件/选择器依赖 `.dark` |

---

## 七、风险与注意事项

1. **派生算法调优**：Codex 的算法是为自己的 UI 布局调优的，Buddy 的 UI 层级可能不同，需要微调混合比例参数
2. **极简主题映射**：Oscurange 仅 3 个 color、Xcode 仅 18 个，映射质量差，建议排除或标记为"实验性"
3. **硬编码清理量大**：globals.css + 组件中约 30+ 处硬编码色值需要迁移到 token
4. **accent 语义变更影响范围**：需要逐一审查所有使用 `--accent` 的组件，确保改造后语义正确
5. **过渡期兼容**：现有 `.dark` 选择器不能一次性全部移除，需要渐进式替换
6. **主题切换性能**：50+ CSS 变量 setProperty 是微秒级操作，无需担忧
7. **主题数据体积**：23 个主题定义约 5KB（仅核心色值），69 个全量约 15KB，可按需加载

---

## 八、实施优先级建议

| 优先级 | 内容 | 预估工时 |
|--------|------|---------|
| P0 | color.ts + derive.ts（颜色工具 + 派生引擎） | 1 天 |
| P0 | apply.ts（主题应用函数） | 0.5 天 |
| P0 | definitions.ts（至少 5 个主题，含 Codex Dark/Light + Dracula + Catppuccin Mocha + GitHub Dark） | 0.5 天 |
| P0 | useTheme 改造 | 0.5 天 |
| P1 | globals.css 硬编码清理 | 1 天 |
| P1 | accent 语义变更 + 组件审查 | 0.5 天 |
| P1 | 设置页主题选择器 | 1 天 |
| P2 | 全部 23 个主题定义 | 0.5 天（脚本自动化） |
| P2 | 主题预览色卡 | 0.5 天 |
| P3 | Code Theme 支持（语法高亮） | 后续 |
