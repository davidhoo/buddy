# 新建任务执行方式底部开关 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将“新建任务”弹窗中的执行方式选择收敛为底部操作栏左侧的单一开关，复用设置页“自动生成 commit message”开关的视觉与交互，并保持立即执行/项目内 FIFO 排队的现有业务语义不变。

**Architecture:** 把 `SettingsContent.tsx` 内部的开关抽为 Renderer 共享展示组件；新建任务弹窗仍维护既有 `executionMode` 状态，只将它映射为 `checked`（`immediate` 为开，`queued` 为关）。任务创建请求、主进程队列协调器和持久化字段均不改动。

**Tech Stack:** Electron、React 18、TypeScript、Tailwind CSS、Vitest、Testing Library。

---

## 任务说明

### 背景与已确认现状

- 新建任务弹窗位于 `src/renderer/App.tsx` 的 `CreateTaskModal`。它已用 `executionMode: 'immediate' | 'queued'` 保存选择，并原样传给 `onCreate(...)`。
- 上层创建任务时已将该值写入 `execution_mode`；仅当值为 `immediate` 时才直接调用 `startTask`。`queued` 任务继续由主进程的队列协调器启动。
- 当前 UI 在表单末尾以两个等宽按钮及一行提示文本呈现“立即执行 / 排队执行”，占用额外高度。
- 设置页 `src/renderer/components/SettingsContent.tsx` 已有 `role="switch"` 的开关实现，用于“自动生成 commit message”。该实现目前是私有组件，若直接复制会产生视觉和无障碍行为漂移风险。

### 固定交互与布局决策

- 移除表单内容区现有的“执行方式”标题、两个模式按钮和状态提示文字。
- 底部操作栏改为左右两组：左侧为执行方式开关；右侧保持“取消”“创建任务”和 `⌘↩` 提示，按钮顺序及快捷键不变。
- 左侧文案随状态变化：开关开启显示“立即执行”，关闭显示“排队执行”。文案是该开关的可访问名称；不再额外显示说明段落。
- 开启代表 `executionMode === 'immediate'`；关闭代表 `executionMode === 'queued'`。默认仍为开启，即保持当前默认立即执行行为。
- 开关的尺寸、圆角、配色、过渡、键盘焦点环和 `role="switch"`/`aria-checked` 必须与设置页现有开关完全一致。
- 仅在创建弹窗打开期间保留该状态；关闭并重新打开弹窗后恢复默认立即执行。不得将本次选择写入全局设置或 `localStorage`。

### 业务边界

- `immediate` 与 `queued` 的含义、`execution_mode` 请求字段、每项目 FIFO 队列、立即任务的启动路径和排队任务的恢复/启动路径均保持现状。
- 本次仅改变 Renderer 布局和组件复用，不新增执行方式，不修改默认值，也不改变创建任务的校验条件。
- 不新增 i18n key：状态文本继续复用既有 `modal.create.executionMode.immediate` 与 `modal.create.executionMode.queued` 翻译；必须确认中英繁三种资源均已存在。

### 无障碍与窄窗口要求

- 共享组件接受可访问名称，并将其写入按钮的 `aria-label`；设置页调用方也补齐对应设置项名称，避免无名称的 `switch`。
- 新建任务底部操作栏使用 `justify-between`；右侧操作按钮保留独立的 `flex` 分组，不能因左侧开关存在而被拉散或反序。
- 宽度不足时，左侧开关和右侧按钮组均不可重叠；继续沿用弹窗当前固定的最小可用宽度和按钮尺寸，不为此任务改变弹窗整体尺寸策略。

### 不包含

- 不修改 `src/main/`、共享 `ExecutionMode` 类型、队列协调器、任务状态机、`execution_mode` 持久化或启动逻辑。
- 不增加“记住上次执行方式”、全局默认执行方式或项目级默认执行方式。
- 不改变 `立即执行` 对排队任务的人工插队语义，也不修改已创建任务的“立即执行”入口。
- 不调整任务说明、工作目录、Actor、会话 ID、附件或分支选择的 UI。
- 不进行发布、tag、push、生成安装包或替换已安装的 Buddy.app。

---

### Task 1: 抽取唯一的共享 Switch 组件并锁定其行为

**Files:**
- Create: `src/renderer/components/Switch.tsx`
- Create: `tests/unit/renderer/switch.test.tsx`
- Modify: `src/renderer/components/SettingsContent.tsx:1-31,357-365,1182-1196`

**Step 1: 写失败测试——共享开关的可访问状态和反转回调**

创建 `tests/unit/renderer/switch.test.tsx`，覆盖：

```tsx
it('reports switch state and sends the inverse value when clicked', () => {
  const onChange = vi.fn()
  render(<Switch checked ariaLabel="立即执行" onChange={onChange} />)

  const control = screen.getByRole('switch', { name: '立即执行' })
  expect(control).toHaveAttribute('aria-checked', 'true')

  fireEvent.click(control)
  expect(onChange).toHaveBeenCalledWith(false)
})
```

再覆盖 `checked={false}` 时 `aria-checked="false"` 与点击回调 `true`。测试不应断言 Tailwind 完整 class 字符串，只断言 `role`、名称、状态和回调契约。

**Step 2: 运行测试确认失败**

Run:

```bash
pnpm vitest run tests/unit/renderer/switch.test.tsx
```

Expected: FAIL，因为共享组件尚不存在。

**Step 3: 实现共享组件并迁移设置页调用方**

新增 `Switch.tsx`，导出如下最小 API：

```tsx
export function Switch({
  checked,
  onChange,
  ariaLabel
}: {
  checked: boolean
  onChange: (value: boolean) => void
  ariaLabel: string
}) {
  // 使用当前 SettingsContent 内 Switch 的 button/span 结构和 Tailwind class
}
```

要求：

- 按钮保留 `type="button"`、`role="switch"`、`aria-checked={checked}` 和既有 `focus-visible:ring-*` 样式。
- 加入 `aria-label={ariaLabel}`；点击只调用 `onChange(!checked)`，不持有内部状态。
- 将原 `SettingsContent.tsx` 私有 `Switch` 删除，改为导入共享组件。
- “自动生成 commit message”“系统通知”两个设置项传入各自对应的本地化标题作为 `ariaLabel`；它们的保存行为和默认值不能改变。

**Step 4: 运行聚焦测试与类型检查**

Run:

```bash
pnpm vitest run tests/unit/renderer/switch.test.tsx
pnpm typecheck
```

Expected: PASS，且 `SettingsContent` 不再声明私有 `Switch`。

**Step 5: 提交**

```bash
git add src/renderer/components/Switch.tsx src/renderer/components/SettingsContent.tsx tests/unit/renderer/switch.test.tsx
git commit -m "refactor(renderer): share accessible switch control"
```

---

### Task 2: 为创建任务弹窗补充执行方式的回归测试

**Files:**
- Modify: `src/renderer/App.tsx:781-980`
- Create: `tests/unit/renderer/create-task-modal.test.tsx`

**Step 1: 让弹窗可被最小化单元测试渲染**

将 `CreateTaskModal` 改为具名导出；保留 App 默认导出和现有调用方式。该导出仅服务于 Renderer 单测，不改变传入 props 或应用运行时结构。

在测试中 mock `useGitStatus`、`BranchModal` 和所需的 `window.api` 方法，并提供返回翻译 key 的 `t` 函数。创建 `renderModal()` helper，传入确定性的 `defaultRepoRoot`、`globalSettings={null}` 和 `onCreate` mock。

**Step 2: 写失败测试——默认立即执行且开关位于底部操作栏**

增加测试以确认：

```tsx
const toggle = screen.getByRole('switch', {
  name: 'modal.create.executionMode.immediate'
})
expect(toggle).toHaveAttribute('aria-checked', 'true')

const footer = screen.getByText('common.cancel').parentElement!
expect(footer).toContainElement(toggle)
expect(screen.queryByText('modal.create.executionMode.immediateHint')).not.toBeInTheDocument()
expect(screen.queryByText('modal.create.executionMode.queuedHint')).not.toBeInTheDocument()
```

测试不以 CSS className 判断“左侧”，而是验证开关与取消/创建按钮同属底部操作栏，布局类由实现审查和手工验收确认。

**Step 3: 写失败测试——关闭开关后创建请求仍使用 queued**

在填入合法任务名称后，点击开关并验证：

```tsx
expect(screen.getByRole('switch', {
  name: 'modal.create.executionMode.queued'
})).toHaveAttribute('aria-checked', 'false')

fireEvent.click(screen.getByRole('button', { name: /modal.create.submit/ }))
expect(onCreate).toHaveBeenCalledWith(
  'ui-layout',
  expect.any(String),
  '/tmp/repo',
  expect.any(Object),
  undefined,
  'queued'
)
```

另增加默认状态提交断言，最后一项必须为 `'immediate'`。不要 mock 或重新测试主进程队列；该测试只证明 UI 映射没有改变现有 `onCreate` 契约。

**Step 4: 运行测试确认失败**

Run:

```bash
pnpm vitest run tests/unit/renderer/create-task-modal.test.tsx
```

Expected: FAIL，因为组件尚未导出，且当前 UI 没有可访问的执行方式开关。

**Step 5: 提交测试基线**

```bash
git add src/renderer/App.tsx tests/unit/renderer/create-task-modal.test.tsx
git commit -m "test(renderer): cover create-task execution mode"
```

仅在实际工作流允许独立 RED 提交时执行；若仓库提交策略要求每个提交可通过，则保留测试与 Task 3 的实现一同提交，且不得把失败提交推送到远端。

---

### Task 3: 在底部操作栏接入共享 Switch 并删除旧选择区

**Files:**
- Modify: `src/renderer/App.tsx:1-25,806,1225-1268`
- Modify: `tests/unit/renderer/create-task-modal.test.tsx`

**Step 1: 用布尔映射连接现有状态**

在 `App.tsx` 导入共享组件。底部操作栏使用以下状态映射，禁止引入第二份布尔 state：

```tsx
<Switch
  checked={executionMode === 'immediate'}
  onChange={(checked) => setExecutionMode(checked ? 'immediate' : 'queued')}
  ariaLabel={
    executionMode === 'immediate'
      ? t('modal.create.executionMode.immediate')
      : t('modal.create.executionMode.queued')
  }
/>
```

开关左侧或右侧同时显示相同的状态文本；文本必须使用上述既有本地化 key，不能硬编码中文。

**Step 2: 重组底部操作栏**

将现有底部容器从仅右对齐改为两个明确分组：

```tsx
<div className="px-6 py-4 border-t border-border flex items-center justify-between gap-3">
  <div className="flex items-center gap-2">
    {/* 状态文本 + Switch */}
  </div>
  <div className="flex items-center gap-3">
    {/* 原取消与创建任务按钮，内容和 handler 均不变 */}
  </div>
</div>
```

删除内容区 `/* 执行方式 */` 整块 JSX，包括两个模式按钮及 `immediateHint`/`queuedHint` 文本。不得移动、重写或删改 `handleSubmit`、`executionMode` 初始值、`onCreate` 参数和 `⌘↩` 处理逻辑。

**Step 3: 运行聚焦测试确认通过**

Run:

```bash
pnpm vitest run tests/unit/renderer/switch.test.tsx tests/unit/renderer/create-task-modal.test.tsx
```

Expected: PASS。默认开关为开，关闭后可提交 `queued`，开启后可提交 `immediate`。

**Step 4: 手工验收三个主题和窄窗口**

Run:

```bash
pnpm dev
```

在浅色、深色和一套高对比主题下打开“新建任务”，并缩窄窗口至应用仍可使用的最小宽度。确认：

1. 左侧开关与右侧“取消 / 创建任务”同一行，且两组不重叠。
2. 开/关具有与设置页开关一致的轨道、滑块和焦点环；Tab 聚焦后可用 Space/Enter 切换。
3. 状态文本随开关在“立即执行”和“排队执行”间切换。
4. `⌘↩`、取消、Escape、Actor 选择、附件和分支操作均维持原行为。

**Step 5: 提交实现**

```bash
git add src/renderer/App.tsx tests/unit/renderer/create-task-modal.test.tsx
git commit -m "refactor(create-task): move execution mode to footer switch"
```

---

### Task 4: 执行完整验证并审查变更边界

**Files:**
- Verify only: `src/renderer/components/Switch.tsx`
- Verify only: `src/renderer/components/SettingsContent.tsx`
- Verify only: `src/renderer/App.tsx`
- Verify only: `tests/unit/renderer/switch.test.tsx`
- Verify only: `tests/unit/renderer/create-task-modal.test.tsx`

**Step 1: 运行全量单元测试与类型检查**

Run:

```bash
pnpm test
pnpm typecheck
```

Expected: 两条命令退出码均为 0。

**Step 2: 审查最终差异**

Run:

```bash
git diff --check HEAD~2..HEAD
git diff --stat HEAD~2..HEAD
git show --check --stat HEAD
```

Expected: 无空白错误；变更仅涉及共享开关、设置页调用、新建任务弹窗和对应 Renderer 测试。若实际提交数不是两笔，以本任务产生的最早提交为基准调整审查范围，不得把用户现有工作树变更纳入结论。

**Step 3: 提交验证结果**

不新增无内容提交。报告实际运行的命令、通过结果和手工验收范围；不执行 `git push`。
