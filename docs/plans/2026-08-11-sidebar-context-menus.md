# Sidebar 项目与任务复用操作菜单 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 Buddy 左侧 Sidebar 的项目行和任务行增加右键菜单，并让右键入口与现有 `...` 入口复用同一套菜单、动作和状态；同时增加复制项目目录、复制任务名称以及打开任务数据目录功能。

**Architecture:** 由主进程的 `BuddyStore` 在任务列表中返回真实 `task_dir`，Renderer 不拼接 Buddy 内部存储路径。Renderer 抽取一个通过 `createPortal` 渲染的共享菜单容器，使用单一判别联合状态记录项目/任务目标及按钮/鼠标锚点；`...` 与右键只负责提供不同定位信息，实际菜单项与回调完全共用。

**Tech Stack:** Electron 33、React 18、TypeScript、Tailwind CSS、lucide-react、Vitest、Testing Library。

---

## 任务说明

### 背景

当前 [Sidebar.tsx](../../src/renderer/components/Sidebar.tsx) 中：

- 项目 `...` 菜单以内联 JSX 实现，包含重命名、在访达中打开和移除。
- 任务 `...` 菜单在“置顶任务”和“项目任务”两个渲染分支中重复实现，包含重命名、置顶/取消置顶和删除。
- 项目行和任务行没有 `onContextMenu`，无法通过右键执行同样操作。
- `Task` 列表只包含 `repo_root`，没有任务数据目录；Renderer 若自行根据 `data_root/workspace_key/task_id` 拼接路径，会反向依赖主进程的内部存储结构。
- 现有 `window.api.openInFinder(path)` 可以继续作为统一 Finder 入口。

### 固定交互决策

项目菜单顺序固定为：

1. 重命名项目
2. 复制项目目录
3. 在访达中打开
4. 分隔线
5. 移除

任务菜单顺序固定为：

1. 重命名
2. 复制任务名称
3. 在访达中打开
4. 置顶 / 取消置顶
5. 分隔线
6. 删除

入口和行为固定为：

- 点击 `...` 时，菜单显示在按钮下方并按按钮右边缘对齐。
- 右键项目行或任务行时，调用 `preventDefault()` 和 `stopPropagation()`，菜单显示在鼠标位置。
- 右键项目不得改变项目展开/折叠状态。
- 右键任务不得选择任务、标记已读或改变当前主视图。
- `...` 与右键必须渲染同一个项目菜单组件或任务菜单组件，不得维护两套菜单项。
- 任意时刻最多显示一个 Sidebar 操作菜单；打开新菜单时关闭旧菜单。
- 点击菜单外部、按 `Escape`、窗口失焦、滚动或调整窗口尺寸时关闭菜单。
- 菜单必须限制在当前视口内；靠近右侧或底部打开时向左或向上修正位置。
- 菜单使用 `createPortal(..., document.body)` 和 `position: fixed`，不得被 Sidebar 滚动容器裁剪。

### 复制和路径语义

- “复制项目目录”复制任务中保存的完整 `repo_root`，不复制项目显示名称。
- “复制任务名称”复制 `displayNameForTask(task, taskNames)` 的结果；存在自定义名称时复制自定义名称，否则复制原始 `task_id`。
- 复制统一调用 `navigator.clipboard.writeText()`。
- 项目“在访达中打开”继续打开 `repo_root`。
- 任务“在访达中打开”打开该任务的整个数据目录，不打开项目目录，也不只选中 `task.md`。
- 任务目录由 `BuddyStore.taskDirectory(taskId, workspaceKey)` 生成，并随 `getTasks()` 返回为 `task_dir`；Renderer 不允许自行拼接路径。
- 任务目录包含 `task.md`、`context.md`、`state.json`、`events.jsonl`、`transcript.jsonl`（存在时）、`artifacts/`、`rounds/` 等任务详情和产物。

### 错误处理

- 剪贴板写入失败时关闭菜单、记录错误，并使用本地化错误文案提醒用户；不得显示“复制成功”。
- `shell.openPath()` 返回非空错误字符串时，主进程必须把它转为 rejected Promise，Renderer 使用本地化错误文案提醒用户。
- Finder 打开失败不得改变项目折叠状态、任务选择、置顶状态或删除状态。
- 菜单动作触发重命名或删除确认框时，先关闭操作菜单，再打开既有对话框。

### 不包含

- 不使用 Electron 原生 `Menu` 重写 Sidebar 菜单。
- 不改变现有项目重命名、任务重命名、置顶、删除和移除的数据持久化语义。
- 不重命名、迁移或清理现有任务数据目录。
- 不让右键任务自动成为当前任务。
- 不为 Sidebar 空白区域、设置页、消息区或状态栏增加右键菜单。
- 不增加新的全局快捷键、菜单栏命令、成功 Toast 或剪贴板历史。
- 不修改 Buddy 双 Actor 状态机、队列调度、Git 操作、Updater 或发布流程。
- 本任务不包含 push、tag、GitHub Release、安装包生成或替换 `/Applications/Buddy.app`。

---

### Task 1: 在任务列表契约中暴露真实任务目录

**Files:**
- Modify: `src/shared/types.ts:1-12`
- Modify: `src/main/buddy/store.ts:48-77`
- Modify: `tests/unit/main/buddy-store.test.ts:75-83,296-304`
- Modify: `tests/unit/renderer/sidebar.test.tsx:30-41,79-137`
- Modify: `tests/unit/renderer/task-list.test.ts:5-17`

**Step 1: 写失败测试——任务列表返回真实目录**

在 `tests/unit/main/buddy-store.test.ts` 的 `getTasks()` 断言中增加：

```ts
const expectedTaskDir = join(root, 'workspaces', 'abc123def456', 'tasks', 'demo')

await expect(store.getTasks()).resolves.toEqual([
  expect.objectContaining({
    task_id: 'demo',
    workspace_key: 'abc123def456',
    task_dir: expectedTaskDir
  })
])
```

同时为中文任务 ID 的兼容测试断言完整 Unicode 路径，证明路径来自真实目录，而不是由 Renderer 编码或拼接。

**Step 2: 运行测试确认失败**

Run:

```bash
pnpm vitest run tests/unit/main/buddy-store.test.ts
```

Expected: FAIL，`getTasks()` 结果缺少 `task_dir`。

**Step 3: 扩展共享类型和 Store 输出**

在 `Task` 中增加：

```ts
export interface Task {
  task_id: string
  workspace_key: string
  task_dir: string
  status: TaskStatus
  updated_at: string
  repo_root: string
  // 保留其余现有字段
}
```

在 `BuddyStore.getTasks()` 的任务对象中增加：

```ts
task_dir: this.taskDirectory(taskId, workspaceKey),
```

不得使用字符串模板重新实现目录规则。

**Step 4: 更新测试 Task fixture**

`sidebar.test.tsx` 和 `task-list.test.ts` 的 Task factory 使用确定性测试目录，例如：

```ts
task_dir: `/tmp/buddy/workspaces/${taskId}-workspace/tasks/${taskId}`,
```

只更新实际构造完整 `Task` 的 fixture；不要给 `TaskState`、`TaskDetail` 或其他类型添加无关字段。

**Step 5: 运行聚焦测试**

Run:

```bash
pnpm vitest run tests/unit/main/buddy-store.test.ts tests/unit/renderer/task-list.test.ts tests/unit/renderer/sidebar.test.tsx
```

Expected: PASS。

**Step 6: 提交**

```bash
git add src/shared/types.ts src/main/buddy/store.ts tests/unit/main/buddy-store.test.ts tests/unit/renderer/sidebar.test.tsx tests/unit/renderer/task-list.test.ts
git commit -m "feat(sidebar): expose task data directories"
```

---

### Task 2: 创建可复用、不会被 Sidebar 裁剪的菜单容器

**Files:**
- Create: `src/renderer/components/SidebarActionMenu.tsx`
- Create: `tests/unit/renderer/sidebar-action-menu.test.tsx`

**Step 1: 写失败测试——关闭和视口约束**

覆盖以下行为：

1. `Escape` 调用一次 `onClose`。
2. 点击菜单外部调用 `onClose`，点击菜单内部不调用。
3. `window.blur`、捕获阶段的滚动和 `resize` 调用 `onClose`。
4. 右下角锚点不会使菜单的最终 `left/top` 超出 `window.innerWidth/innerHeight`。
5. 组件通过 Portal 渲染到 `document.body`，菜单带有 `role="menu"`。

测试使用明确的 `getBoundingClientRect()` mock 设置菜单宽高，不得依赖 jsdom 默认的零尺寸。

**Step 2: 运行测试确认失败**

Run:

```bash
pnpm vitest run tests/unit/renderer/sidebar-action-menu.test.tsx
```

Expected: FAIL，因为共享菜单组件尚不存在。

**Step 3: 定义最小公共 API**

```ts
export interface SidebarMenuAnchor {
  x: number
  y: number
  align: 'left' | 'right'
}

export interface SidebarActionMenuProps {
  anchor: SidebarMenuAnchor
  onClose: () => void
  children: React.ReactNode
  minWidth?: number
}
```

同时导出只负责统一样式的 `SidebarMenuItem` 和 `SidebarMenuDivider`。`SidebarMenuItem` 接受 `icon`、`children`、`onSelect`、可选 `danger` 和 `disabled`；具体业务菜单不得复制按钮 className。

**Step 4: 实现 Portal 和定位算法**

要求：

```text
初始 left = align=right ? x - menuWidth : x
初始 top  = y
left      = clamp(left, 8, viewportWidth - menuWidth - 8)
top       = 若底部溢出则优先使用 y - menuHeight，否则使用 y
top       = clamp(top, 8, viewportHeight - menuHeight - 8)
```

使用 `useLayoutEffect` 在菜单实际渲染后测量尺寸。关闭监听器必须在组件卸载时完整移除，不得为每个菜单项各自注册 document 事件。

**Step 5: 运行聚焦测试**

Run:

```bash
pnpm vitest run tests/unit/renderer/sidebar-action-menu.test.tsx
```

Expected: PASS。

**Step 6: 提交**

```bash
git add src/renderer/components/SidebarActionMenu.tsx tests/unit/renderer/sidebar-action-menu.test.tsx
git commit -m "refactor(sidebar): add shared action menu popup"
```

---

### Task 3: 用单一菜单状态替换三处内联菜单

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx:1-710`
- Modify: `tests/unit/renderer/sidebar.test.tsx`

**Step 1: 写失败测试——同一目标只能打开一个共享菜单**

增加测试，先通过项目 `...` 打开菜单，再通过任务 `...` 打开另一个菜单，断言：

- 页面始终只有一个 `[role="menu"]`。
- 第二次打开后，项目菜单项消失并显示任务菜单项。
- 点击菜单外部和 `Escape` 都关闭当前菜单。

**Step 2: 运行测试确认当前实现失败**

Run:

```bash
pnpm vitest run tests/unit/renderer/sidebar.test.tsx
```

Expected: FAIL，因为当前实现分别维护 `openMenuRepoRoot`、`openMenuTaskId`、`menuRef` 和 `taskMenuRef`，且菜单 JSX 重复。

**Step 3: 建立判别联合状态**

在 `ChatSidebar` 中只保留一个菜单状态：

```ts
type SidebarMenuState =
  | {
      kind: 'project'
      repoRoot: string
      projectName: string
      anchor: SidebarMenuAnchor
    }
  | {
      kind: 'task'
      task: Task
      displayName: string
      isPinned: boolean
      anchor: SidebarMenuAnchor
    }
  | null
```

删除 `openMenuRepoRoot`、`openMenuTaskId`、`menuRef`、`taskMenuRef` 以及两套 outside-click effect。菜单目标必须保留完整 `workspace_key + task_id`，不得只用可能跨项目重复的 `task_id` 判断目标。

**Step 4: 抽取业务菜单项组件**

在 `Sidebar.tsx` 中定义一次 `ProjectActionsMenu` 和一次 `TaskActionsMenu`：

- `ProjectActionsMenu` 只接收项目目标和动作回调。
- `TaskActionsMenu` 只接收任务目标、显示名称、置顶状态和动作回调。
- 置顶区和项目区不得各自复制任务菜单 JSX。
- `...` 按钮只计算锚点并设置 `menuState`。
- 所有动作执行前调用统一 `closeMenu()`。

**Step 5: 运行测试**

Run:

```bash
pnpm vitest run tests/unit/renderer/sidebar.test.tsx tests/unit/renderer/sidebar-action-menu.test.tsx
```

Expected: PASS，现有重命名、置顶、删除、项目 Finder 和移除行为不回归。

**Step 6: 提交**

```bash
git add src/renderer/components/Sidebar.tsx tests/unit/renderer/sidebar.test.tsx
git commit -m "refactor(sidebar): share project and task action menus"
```

---

### Task 4: 增加项目右键菜单和复制项目目录

**Files:**
- Modify: `src/renderer/App.tsx:20-195,630-643`
- Modify: `src/renderer/components/Sidebar.tsx:33-140,548-623`
- Modify: `src/renderer/lib/i18n.ts:114-147,550-583,971-1004`
- Modify: `tests/unit/renderer/sidebar.test.tsx`

**Step 1: 写失败测试——项目右键不折叠**

测试流程：

```ts
const onCopyText = vi.fn()
const props = renderSidebar([task('first')], { onCopyText })
const projectRow = screen.getByRole('button', { name: /repo/ })

fireEvent.contextMenu(projectRow, { clientX: 120, clientY: 80 })

expect(projectRow).toHaveAttribute('aria-expanded', 'true')
expect(props.onCreateTask).not.toHaveBeenCalled()
expect(screen.getByText('Copy Project Path')).toBeVisible()

fireEvent.click(screen.getByText('Copy Project Path'))
expect(onCopyText).toHaveBeenCalledWith('/tmp/repo')
```

另加一组断言证明从 `...` 打开的菜单包含完全相同的标签和动作。

**Step 2: 运行测试确认失败**

Run:

```bash
pnpm vitest run tests/unit/renderer/sidebar.test.tsx
```

Expected: FAIL，因为项目行没有右键处理，也没有复制项目目录菜单项。

**Step 3: 增加复制回调和多语言文案**

为 `SidebarProps` 增加：

```ts
onCopyText: (text: string) => void
```

在 `App.tsx` 中实现一次通用复制处理器，并传给 Sidebar：

```ts
const handleCopyText = useCallback((text: string) => {
  navigator.clipboard.writeText(text).catch((error: unknown) => {
    console.error('Failed to copy text:', error)
    window.alert(t('sidebar.copyFail', {
      message: error instanceof Error ? error.message : String(error)
    }))
  })
}, [t])
```

新增三套键值：

```text
sidebar.menuCopyProjectDirectory = Copy Project Path / 复制项目目录 / 複製專案目錄
sidebar.copyFail                = Copy failed: {message} / 复制失败：{message} / 複製失敗：{message}
```

使用 lucide-react 的 `Copy` 图标，不引入其他图标库或自定义 SVG。

**Step 4: 接入项目右键入口**

项目行的 `onContextMenu` 必须：

```ts
e.preventDefault()
e.stopPropagation()
openProjectMenu(repoRoot, projectKey, {
  x: e.clientX,
  y: e.clientY,
  align: 'left'
})
```

`...` 按钮继续 `stopPropagation()`，使用按钮的 `getBoundingClientRect()` 生成 `align: 'right'` 的锚点。两个入口都渲染 `ProjectActionsMenu`。

**Step 5: 运行聚焦测试**

Run:

```bash
pnpm vitest run tests/unit/renderer/sidebar.test.tsx
```

Expected: PASS。

**Step 6: 提交**

```bash
git add src/renderer/App.tsx src/renderer/components/Sidebar.tsx src/renderer/lib/i18n.ts tests/unit/renderer/sidebar.test.tsx
git commit -m "feat(sidebar): add project context menu actions"
```

---

### Task 5: 增加任务右键菜单、复制名称和打开数据目录

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx:450-535,628-710`
- Modify: `src/renderer/lib/i18n.ts:114-147,550-583,971-1004`
- Modify: `tests/unit/renderer/sidebar.test.tsx`

**Step 1: 写失败测试——普通任务的右键行为**

至少覆盖：

```ts
const onSelectTask = vi.fn()
const onCopyText = vi.fn()
const onOpenInFinder = vi.fn()

renderSidebar([task('original-name')], {
  onSelectTask,
  onCopyText,
  onOpenInFinder,
  taskNames: { 'original-name': '显示名称' }
})

const taskRow = screen.getByText('显示名称').closest('[title]')!
fireEvent.contextMenu(taskRow, { clientX: 90, clientY: 110 })

expect(onSelectTask).not.toHaveBeenCalled()
fireEvent.click(screen.getByText('Copy Task Name'))
expect(onCopyText).toHaveBeenCalledWith('显示名称')
```

重新打开右键菜单并点击 “Show in Finder”，断言：

```ts
expect(onOpenInFinder).toHaveBeenCalledWith(
  '/tmp/buddy/workspaces/original-name-workspace/tasks/original-name'
)
```

**Step 2: 写失败测试——置顶任务复用同一菜单**

将任务写入 `buddy.pinnedTaskIds` 后右键置顶区任务，断言：

- 菜单仍包含复制名称和 Finder 动作。
- 置顶动作显示为 `Unpin`。
- 点击复制和 Finder 使用相同回调参数。
- 页面只有一个 `[role="menu"]`。

**Step 3: 运行测试确认失败**

Run:

```bash
pnpm vitest run tests/unit/renderer/sidebar.test.tsx
```

Expected: FAIL，因为任务行没有右键入口，且任务菜单没有复制/Finder 动作。

**Step 4: 增加任务菜单项和右键入口**

新增文案：

```text
sidebar.menuCopyTaskName = Copy Task Name / 复制任务名称 / 複製任務名稱
```

任务行的 `onContextMenu` 必须调用 `preventDefault()`、`stopPropagation()`，保存完整 `task`、`displayName`、`isPinned` 和鼠标锚点。菜单动作固定为：

```ts
onCopyText(displayName)
onOpenInFinder(task.task_dir)
```

不得使用 `task.task_id` 替代 `displayName`，也不得使用 `repo_root` 替代 `task_dir`。

**Step 5: 验证菜单入口不改变其他状态**

测试必须断言：

- 右键不调用 `onSelectTask`。
- 右键不调用 `togglePin`。
- 打开/关闭菜单不写 `buddy.taskReadState`。
- 复制或打开 Finder 不调用删除、重命名或置顶回调。

**Step 6: 运行聚焦测试**

Run:

```bash
pnpm vitest run tests/unit/renderer/sidebar.test.tsx tests/unit/renderer/sidebar-action-menu.test.tsx
```

Expected: PASS。

**Step 7: 提交**

```bash
git add src/renderer/components/Sidebar.tsx src/renderer/lib/i18n.ts tests/unit/renderer/sidebar.test.tsx
git commit -m "feat(sidebar): add task context menu actions"
```

---

### Task 6: 让 Finder 错误可被 Renderer 感知

**Files:**
- Create: `src/main/ipc/open-path.ts`
- Create: `tests/unit/main/open-path.test.ts`
- Modify: `src/main/index.ts:96-98`
- Modify: `src/renderer/App.tsx:187-191`
- Modify: `src/renderer/lib/i18n.ts:114-147,550-583,971-1004`

**Step 1: 写失败测试——非空 shell 错误必须抛出**

```ts
import { openPathOrThrow } from '../../../src/main/ipc/open-path'

it('throws when Electron returns an openPath error string', async () => {
  const openPath = vi.fn().mockResolvedValue('The file does not exist')

  await expect(openPathOrThrow(openPath, '/missing')).rejects.toThrow(
    'The file does not exist'
  )
})

it('resolves when Electron returns an empty error string', async () => {
  const openPath = vi.fn().mockResolvedValue('')

  await expect(openPathOrThrow(openPath, '/existing')).resolves.toBeUndefined()
})
```

**Step 2: 运行测试确认失败**

Run:

```bash
pnpm vitest run tests/unit/main/open-path.test.ts
```

Expected: FAIL，因为 helper 尚不存在。

**Step 3: 实现并接入 helper**

```ts
export async function openPathOrThrow(
  openPath: (path: string) => Promise<string>,
  path: string
): Promise<void> {
  const errorMessage = await openPath(path)
  if (errorMessage) throw new Error(errorMessage)
}
```

主进程 handler 改为：

```ts
ipcMain.handle('shell:openInFinder', async (_event, path: string) => {
  await openPathOrThrow(shell.openPath.bind(shell), path)
})
```

`App.tsx` 保留统一 Finder 回调，但 rejection 时除日志外显示 `sidebar.openInFinderFail` 本地化错误。不要为项目和任务创建两套 Finder handler。

三套错误文案固定为：

```text
sidebar.openInFinderFail = Failed to open in Finder: {message}
                         / 无法在访达中打开：{message}
                         / 無法在 Finder 中顯示：{message}
```

**Step 4: 运行聚焦测试**

Run:

```bash
pnpm vitest run tests/unit/main/open-path.test.ts tests/unit/preload/index.test.ts tests/unit/renderer/sidebar.test.tsx
```

Expected: PASS。

**Step 5: 提交**

```bash
git add src/main/ipc/open-path.ts src/main/index.ts src/renderer/App.tsx src/renderer/lib/i18n.ts tests/unit/main/open-path.test.ts
git commit -m "fix(shell): surface Finder open failures"
```

---

### Task 7: 完整回归验证和人工验收

**Files:**
- No further edits expected.

**Step 1: 运行格式与类型检查**

Run:

```bash
git diff --check
pnpm typecheck
```

Expected: 两个命令均退出 0；`git diff --check` 无输出。

**Step 2: 运行完整单元测试**

Run:

```bash
pnpm test
```

Expected: 所有现有与新增 Vitest 测试通过。

**Step 3: 运行生产构建**

Run:

```bash
pnpm build
```

Expected: Electron main、preload、renderer 三个目标全部构建成功。

**Step 4: 开发模式人工验收**

Run:

```bash
pnpm dev
```

依次验证：

1. 项目 `...` 与项目右键的菜单项、顺序、图标一致。
2. 任务 `...` 与任务右键的菜单项、顺序、图标一致。
3. 右键已折叠/已展开项目都不会改变折叠状态。
4. 右键未选中的任务不会切换当前任务。
5. 普通任务和置顶任务使用相同任务菜单。
6. 自定义重命名后的任务复制显示名称，未重命名任务复制 `task_id`。
7. 项目复制的是绝对 `repo_root`；项目 Finder 打开项目目录。
8. 任务 Finder 打开 Buddy 任务数据目录，并能看到 `task.md`、`state.json`、`events.jsonl` 等内容。
9. 在 Sidebar 右侧、底部边缘右键时菜单完整可见，不被裁剪。
10. 点击外部、按 `Escape`、滚动 Sidebar、调整窗口大小都关闭菜单。
11. Finder 目标被临时移走后，操作显示错误且不改变任务或项目状态；测试完成后恢复目录，不得删除用户数据。

**Step 5: 检查最终范围**

Run:

```bash
git status --short
git diff --stat
```

Expected: 仅出现本计划列出的源文件和测试文件；无任务数据、构建产物、Release 文件或无关格式化改动。

**Step 6: 最终提交**

仅当 Task 1–6 没有按计划分别提交时执行：

```bash
git add src/main src/renderer src/shared tests/unit
git commit -m "feat(sidebar): add shared project and task context menus"
```

不得 push；由用户审查本地提交后决定后续集成和发布。

---

## 验收标准

- 项目行和任务行均支持右键菜单。
- 右键菜单与对应 `...` 菜单复用同一组件和动作定义，用户可见内容完全一致。
- 项目菜单新增“复制项目目录”，复制准确的完整 `repo_root`。
- 任务菜单新增“复制任务名称”和“在访达中打开”。
- 任务名称复制当前显示名称；无自定义名称时复制 `task_id`。
- 任务 Finder 打开由主进程提供的准确 `task_dir`，Renderer 不拼路径。
- 右键项目不折叠/展开，右键任务不选择任务或标记已读。
- 普通任务和置顶任务均通过同一任务菜单实现。
- 菜单不会被 Sidebar 或视口裁剪，并支持点击外部、`Escape`、失焦、滚动和 resize 关闭。
- Finder 和剪贴板失败有用户可见、本地化的错误反馈。
- zh-CN、zh-TW、en 三套文案完整，不显示原始 i18n key。
- `git diff --check`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过。
