# Buddy 主题方案：基于 Codex App 主题体系

## 一、Codex App 主题体系分析

### 1.1 双层架构：Chrome Theme + Code Theme

Codex App 的主题系统分为两层：

| 层级 | 作用 | 数据量 | 格式 |
|------|------|--------|------|
| **Chrome Theme** | App 外壳 UI（非编辑器区域） | 极简：每模式 5 个核心 token + 3 个语义色 | `{ dark: {...}, light: {...} }` |
| **Code Theme** | 代码编辑器区域 | 丰富：24~564 个颜色 + 8~276 个语法高亮 token | VS Code 兼容格式 |

### 1.2 Chrome Theme（App 外壳主题）

Codex 的 chrome theme 是最关键的部分——它定义了 app 非-editor 区域的全部外观：

```json
{
  "dark": {
    "accent": "#339cff",        // 强调色（按钮、链接、选中态）
    "contrast": 60,             // 对比度数值（影响 UI 层级区分）
    "ink": "#ffffff",           // 主文字色
    "surface": "#181818",       // 主背景色
    "opaqueWindows": false,     // 是否不透明窗口
    "fonts": { "code": null, "ui": null },
    "semanticColors": {
      "diffAdded": "#40c977",   // diff 新增色
      "diffRemoved": "#fa423e", // diff 删除色
      "skill": "#ad7bf9"        // 技能/特殊标签色
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

**核心设计理念：** 用极少数 token（accent + ink + surface + contrast）驱动整个 UI，其余颜色通过算法从这 4 个值派生。

### 1.3 Code Theme（代码编辑器主题）

共 69 个主题，覆盖主流编辑器配色方案：

| 主题 | 类型 | UI colors | 语法 tokens | 语义色 |
|------|------|-----------|-------------|--------|
| Codex Dark | dark | 24 | 245 | yes |
| Codex Light | light | 24 | 245 | yes |
| Dracula | dark | 195 | 85 | no |
| Catppuccin Mocha | dark | 564 | 179 | yes |
| GitHub Dark Default | dark | 241 | 49 | no |
| Nord | dark | 303 | 140 | no |
| One Dark Pro | dark | 143 | 275 | yes |
| Tokyo Night | dark | 353 | 114 | yes |
| Gruvbox Dark Medium | dark | 258 | 127 | yes |

Code Theme 完全兼容 VS Code 主题格式，包含三部分：
- `colors`: UI 界面颜色（editor.background, sideBar.background 等）
- `tokenColors`: TextMate 语法定义的颜色映射
- `semanticTokenColors`: 语义级别的颜色映射

### 1.4 Codex 主题的设计模式

**模式 1：Codex 品牌主题（极简 UI + 丰富语法）**
- Codex Dark/Light 仅定义 24 个 UI color，但语法 token 高达 245 个
- 包含 `semanticTokenColors`（comment, string, number, keyword, variable, function 等 15 种语义类型）

**模式 2：社区主题（丰富 UI + 适中语法）**
- 如 Catppuccin 定义 564 个 UI color，Nord 定义 303 个
- 大多数社区主题不含 `semanticTokenColors`

**模式 3：派生关系**
- 同系列主题共享结构骨架，仅颜色值不同（如 Catppuccin 4 变体、Gruvbox 6 变体、GitHub 7 变体）

---

## 二、Buddy 当前主题体系分析

### 2.1 现状

Buddy 已有完善的 CSS 变量 token 系统（20 个 token）：

| 分类 | Token | Light | Dark |
|------|-------|-------|------|
| 背景 | `--bg` | #f3f3f1 | #18181a |
| | `--bg-elevated` | #ffffff | #1f1f22 |
| | `--bg-subtle` | #ececea | #27272a |
| | `--bg-muted` | #e0e0dc | #2e2e32 |
| 文字 | `--fg` | #1c1c1a | #e8e8e3 |
| | `--fg-secondary` | #6b6b66 | #a1a1a0 |
| | `--fg-muted` | #9a9a93 | #6b6b68 |
| | `--fg-inverse` | #ffffff | #18181a |
| 边框 | `--border` | #e5e5e2 | #2a2a2e |
| | `--border-subtle` | #ededea | #232326 |
| 强调 | `--accent` | #1c1c1a | #f5f5f3 |
| | `--accent-hover` | #000000 | #ffffff |
| | `--accent-soft` | #d8d8d4 | #3a3a3e |
| | `--accent-soft-hover` | #c8c8c4 | #44444a |
| 语义 | `--success-bg` | #e8f0e8 | rgba(46,125,50,0.2) |
| | `--success-fg` | #2e7d32 | #66bb6a |
| | `--danger` | #c82014 | #ef4444 |
| | `--danger-hover` | #a01a10 | #dc2626 |

**架构特点：**
- Tailwind CSS + CSS 变量，`darkMode: 'class'`
- `useTheme` hook 支持 light/dark/system 三模式
- Actor 品牌色（Claude 紫、Codex 青、OpenCode 琥珀、Kimi 绿）硬编码，不参与主题切换

### 2.2 现有问题

1. **只有一套配色**（中性灰），无法切换风格
2. **accent 实质上是反色**（light 下黑、dark 下白），缺少真正的彩色强调
3. **部分暗色样式走 `.dark` 选择器而非 token**（status-dot、scrollbar、breathe 动画），不利于主题切换
4. **Actor 品牌色硬编码**，不能跟随主题调整
5. **task-brief-card 强制白底**，不响应暗色模式

---

## 三、适配方案

### 3.1 核心思路：以 Chrome Theme 为骨架，扩展 Buddy Token

Buddy 不是代码编辑器，不需要 Code Theme 的 `tokenColors`/`semanticTokenColors`。我们只需要 **Chrome Theme 的设计思路**：用少量核心 token 驱动整个 UI。

**方案：将 69 个 Codex Code Theme 的 `colors` 字段映射为 Buddy 的 CSS 变量 token。**

每个 Codex theme 的 `colors` 中都包含以下可映射的键：

| Codex colors 键 | 映射到 Buddy token | 说明 |
|------------------|---------------------|------|
| `editor.background` | `--bg` | 主背景 |
| `sideBar.background` / `panel.background` | `--bg-elevated` | 提升层背景 |
| `editor.foreground` | `--fg` | 主文字 |
| `sideBar.foreground` | `--fg-secondary` | 次要文字 |
| （需派生） | `--fg-muted` | 从 fg-secondary 降低不透明度 |
| （需派生） | `--fg-inverse` | editor.background |
| `editor.selectionBackground` | `--accent-soft` | 软强调 |
| `focusBorder`（去透明度）→ `button.background`（去透明度）→ `activityBarBadge.background` | `--accent` | 强调色，递补优先级 |
| （需派生） | `--accent-hover` | accent 微调亮/暗 |
| （需派生） | `--bg-subtle` | bg 和 bg-elevated 之间 |
| （需派生） | `--bg-muted` | bg-subtle 更深一点 |
| （需派生） | `--border` | 基于 surface/ink 派生 |
| （需派生） | `--border-subtle` | border 更淡 |
| `gitDecoration.addedResourceForeground` | `--success-fg` | 成功色 |
| （需派生） | `--success-bg` | success-fg 低不透明度 |
| `gitDecoration.deletedResourceForeground` | `--danger` | 危险色 |

### 3.2 主题定义格式

建议为 Buddy 定义以下主题格式（TypeScript）：

```typescript
interface BuddyTheme {
  id: string;           // 唯一标识，如 "dracula", "catppuccin-mocha"
  name: string;         // 显示名称，如 "Dracula", "Catppuccin Mocha"
  type: 'dark' | 'light';
  tokens: {
    // 核心色（从 Codex theme 直接映射）
    bg: string;              // 主背景
    bgElevated: string;      // 提升层
    fg: string;              // 主文字
    fgSecondary: string;     // 次要文字
    accent: string;          // 强调色（递补：focusBorder → button.background → activityBarBadge.background，去透明度）

    // 语义色（从 Codex theme 直接映射）
    successFg: string;       // 来自 gitDecoration.addedResourceForeground
    danger: string;          // 来自 gitDecoration.deletedResourceForeground
  };
}

// 运行时通过算法从核心 token 派生其余变量
function deriveTokens(core: BuddyTheme['tokens']): FullTokenSet {
  return {
    ...core,
    bgSubtle: mixColors(core.bg, core.bgElevated, 0.5),
    bgMuted: mixColors(core.bgElevated, core.fg, 0.08),
    fgMuted: withAlpha(core.fgSecondary, 0.6),
    fgInverse: core.bg,
    border: withAlpha(core.fg, 0.12),
    borderSubtle: withAlpha(core.fg, 0.06),
    accentHover: lighten(core.accent, 0.1),
    accentSoft: withAlpha(core.accent, 0.12),
    accentSoftHover: withAlpha(core.accent, 0.18),
    successBg: withAlpha(core.successFg, 0.12),
    dangerHover: lighten(core.danger, 0.1),
  };
}
```

**关键设计决策：** 存储 7 个核心色，派生 13 个辅助色。这比存储全部 20 个色值更利于主题的一致性，也大大降低手工调色的负担。

### 3.3 可直接使用的主题清单

从 69 个 Codex 主题中，以下主题质量高、辨识度强，适合直接映射到 Buddy：

#### 暗色主题（推荐 15 个）

| 主题 | accent | 特点 |
|------|--------|------|
| Codex Dark | #0169cc | 蓝色强调，原生 Codex 风格 |
| Dracula | #FF79C6 | 粉紫强调，经典暗色 |
| Catppuccin Mocha | #cba6f7 | 柔和薰衣草紫，温暖暗色 |
| Catppuccin Macchiato | #c7a4f5 | 同系列，更深 |
| Nord | #88c0d0 | 冰蓝绿，冷色调 |
| One Dark Pro | #4d78cc | 蓝色强调，Atom 风格 |
| Tokyo Night | #7aa2f7 | 蓝紫，日系暗色 |
| Gruvbox Dark Medium | #fe8019 | 橙色暖调，复古风 |
| Kanagawa Wave | #658594 | 柔蓝，日式浮世绘配色 |
| Rose Pine | #c4a7e7 | 玫瑰紫，优雅暗色 |
| GitHub Dark Default | #58a6ff | GitHub 风，蓝色 |
| Material Palenight | #80CBC4 | 紫色强调，Material 风 |
| Ayu Dark | #f29e74 | 橙粉，温暖 |
| Vitesse Dark | #4d9375 | 绿色，Vim 风格 |
| Synthwave 84 | #f97e72 | 赛博朋克霓虹橙粉 |

#### 亮色主题（推荐 8 个）

| 主题 | accent | 特点 |
|------|--------|------|
| Codex Light | #0169cc | 蓝色强调，原生 Codex 风格 |
| Catppuccin Latte | #8839ef | 紫色，温暖亮色 |
| GitHub Light Default | #0969da | GitHub 风，蓝色 |
| Gruvbox Light Medium | #af3a03 | 橙红暖调 |
| Kanagawa Lotus | #c47247 | 暖橙，日式 |
| One Light | #4078f2 | 蓝色，Atom 亮色风 |
| Rose Pine Dawn | #907aa9 | 柔紫，清晨感 |
| Vitesse Light | #59873a | 绿色，自然风 |

### 3.4 Codex Chrome Theme 的对比度机制

Codex Chrome Theme 的 `contrast` 字段（dark=60, light=45）是一个关键设计：它控制 UI 层级的视觉对比度。这意味着：

- 暗色模式下，背景层级差异更明显（contrast 更高）
- 亮色模式下，层级差异更柔和（contrast 更低）

**Buddy 适配建议：** 将 `contrast` 值纳入派生算法，影响 `bg-subtle`、`bg-muted`、`border` 等介于 bg 和 fg 之间的中间色的混合比例。

---

## 四、改造方案

### 4.1 改造步骤总览

```
Phase 1: 主题数据层 → Phase 2: 主题运行时 → Phase 3: UI 适配 → Phase 4: 代码主题（可选）
```

### Phase 1：主题数据层

**1.1 创建主题数据文件** `src/renderer/themes/definitions.ts`

从 Codex 导出的 69 个 JSON 中提取核心色值，转换为 `BuddyTheme[]` 格式。建议先实现 23 个推荐主题（15 暗 + 8 亮）。

**1.2 自动化映射脚本** `scripts/codex-to-buddy-theme.ts`

编写转换脚本，自动将 Codex theme JSON 转为 Buddy 主题格式：
- `editor.background` → `bg`
- `sideBar.background` → `bgElevated`
- `editor.foreground` → `fg`
- `sideBar.foreground` → `fgSecondary`
- `focusBorder`（去透明度）→ `button.background`（去透明度）→ `activityBarBadge.background` → `accent`
- `gitDecoration.addedResourceForeground` → `successFg`
- `gitDecoration.deletedResourceForeground` → `danger`

### Phase 2：主题运行时

**2.1 主题 Hook 改造** `src/renderer/hooks/useTheme.ts`

```typescript
// 现有：Theme = 'light' | 'dark' | 'system'
// 改造后：
type ThemeMode = 'light' | 'dark' | 'system';
type ThemeId = string; // 'default' | 'dracula' | 'catppuccin-mocha' | ...

// useTheme 返回
interface ThemeState {
  mode: ThemeMode;           // light/dark/system
  themeId: ThemeId;          // 主题 ID
  resolvedMode: 'light' | 'dark'; // 实际解析后的模式
  setMode: (mode: ThemeMode) => void;
  setTheme: (id: ThemeId) => void;
}
```

**2.2 主题应用函数** `src/renderer/themes/apply.ts`

```typescript
function applyTheme(theme: BuddyTheme): void {
  const root = document.documentElement;
  const tokens = deriveTokens(theme.tokens);

  // 设置 CSS 变量
  Object.entries(tokens).forEach(([key, value]) => {
    const cssVar = '--' + key.replace(/([A-Z])/g, '-$1').toLowerCase();
    root.style.setProperty(cssVar, value);
  });

  // 维护 .dark / .light class（供现有选择器兼容）
  root.classList.toggle('dark', theme.type === 'dark');
}
```

**2.3 派生算法** `src/renderer/themes/derive.ts`

核心：从 7 个核心色派生出 13 个辅助色。关键函数：
- `mixColors(a, b, ratio)` — 颜色混合
- `withAlpha(color, alpha)` — 设置透明度
- `lighten(color, amount)` — 亮度调整
- `deriveTokens(core)` — 一键派生全部 token

### Phase 3：UI 适配

**3.1 globals.css 清理**

将所有硬编码的 `.dark` 选择器替换为 CSS 变量引用：

```css
/* 替换前 */
.status-dot-running { background: #1e3932; }
.dark .status-dot-running { background: #4ade80; }

/* 替换后 */
.status-dot-running { background: var(--status-running-bg); }
```

需要在 token 中新增：
- `--status-running-bg` / `--status-running-fg`
- `--status-paused-bg` / `--status-paused-fg`

**3.2 Actor 品牌色 token 化**

```css
:root {
  --actor-claude: #8b6dba;
  --actor-codex: #4a9bb5;
  --actor-opencode: #d97706;
  --actor-kimi: #2e7d32;
}
```

这些颜色保持跨主题不变（品牌色），但通过 CSS 变量统一管理后，未来可支持主题自定义 actor 色。

**3.3 task-brief-card 适配暗色模式**

移除硬编码的白色背景，改用 token：

```css
.task-brief-card {
  background: var(--bg-elevated);
  border-color: var(--border);
  color: var(--fg);
}
```

**3.4 设置页面增加主题选择器**

在 `AppearanceSettings` 中增加主题选择区域：
- 按 light/dark 分组展示主题
- 每个主题显示为色卡预览（surface + accent + ink 三色条）
- 选中后立即预览（`applyTheme` 实时生效）

### Phase 4：代码主题（可选，低优先级）

如果 Buddy 未来支持代码块语法高亮，可直接复用 Codex 的 `tokenColors` + `semanticTokenColors` 数据，配合 highlight.js 或 Prism.js 的 VS Code 主题格式使用。

---

## 五、数据流与存储

```
┌─────────────────────────────────────────────────┐
│ definitions.ts                                  │
│ BuddyTheme[] = [{ id, name, type, tokens }]    │
└───────────────┬─────────────────────────────────┘
                │ 选取主题
                ▼
┌─────────────────────────────────────────────────┐
│ useTheme()                                      │
│ mode + themeId → resolvedTheme                  │
│ persist: localStorage('theme-mode', 'theme-id') │
└───────────────┬─────────────────────────────────┘
                │ 调用 applyTheme()
                ▼
┌─────────────────────────────────────────────────┐
│ deriveTokens() → 全部 20 个 CSS 变量            │
│ document.documentElement.style.setProperty(...)  │
└─────────────────────────────────────────────────┘
```

**持久化：**
- `localStorage('theme-mode')` — light/dark/system
- `localStorage('theme-id')` — 主题 ID（如 'dracula'）
- 系统模式监听 `matchMedia('prefers-color-scheme: dark')`

**回退逻辑：**
- 如果当前 mode=dark 但选了 light 主题，自动切换到该主题的 dark 变体（如果有）或默认暗色
- 推荐做法：主题选择器按当前 mode 过滤，只显示匹配的主题

---

## 六、关键设计决策

| 决策点 | 方案 | 理由 |
|--------|------|------|
| 主题存储格式 | 7 核心色 + 算法派生 | 减少手工调色，保证一致性 |
| 是否复用 Codex Code Theme colors | 是，映射核心键 | 69 个现成主题，无需从零设计 |
| 是否需要 Codex Chrome Theme 的 contrast 机制 | 建议纳入 | 控制中间色混合比例，提升主题品质 |
| Actor 品牌色是否纳入主题 | 保持跨主题不变，但 token 化 | 品牌识别 > 主题统一 |
| 主题数量 | 先实现 23 个推荐主题 | 覆盖主流风格，避免选择过载 |
| 暗亮模式与主题 ID 的关系 | 两者独立：mode 控制暗亮，themeId 控制配色 | 用户可以选 "Dracula（暗色）" 或 "Catppuccin Latte（亮色）"，切换 mode 时自动切换到同系列对应变体 |

---

## 七、风险与注意事项

1. **派生算法需要调优**：从 7 核心色派生 13 个辅助色，混合比例需要针对不同主题微调，可能需要引入 contrast 参数
2. **Codex 最简主题只有 3 个 color**（Oscurange）：这类主题缺失太多字段，映射后效果差，建议排除
3. **现有 `.dark` 选择器散落各处**：需要全面审计 globals.css 和组件中的硬编码颜色，迁移到 CSS 变量
4. **主题切换时动画过渡**：建议给 `:root` 加 `transition: background-color 0.2s, color 0.2s` 使主题切换有平滑感
5. **性能**：69 个主题定义约 200KB JSON，按需加载即可（只加载当前主题 + 列表元数据）
