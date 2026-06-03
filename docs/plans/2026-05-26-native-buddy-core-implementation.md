# Native Buddy Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the buddy-python HTTP runtime with a TypeScript Buddy Core inside the Electron main process.

**Architecture:** The renderer calls a narrow `window.buddy` preload API. Preload forwards calls to Electron main IPC handlers. Main process owns the Buddy service, store, runner, launcher child processes, parser pipeline, locks, and event persistence.

**Tech Stack:** Electron 33, electron-vite, React 18, TypeScript 5, Vitest, Playwright, Node `fs/promises`, Node `child_process.spawn`, Zod for IPC and file schema validation.

---

## Implementation Notes

- Current worktree has unrelated user changes. Execute this plan in a dedicated branch or worktree before modifying source files.
- Use TDD for every task that changes behavior.
- Keep commits small. Each task below ends with a commit.
- Do not preserve or introduce any `buddy-python` sidecar, Python interpreter, or local HTTP server.
- Prefer repo-relative paths in commands from repository root: `/Users/david/SynologyDrive/Projects/github/buddy`.

## Task 1: Add Native Buddy API Types

**Files:**
- Modify: `src/shared/types.ts`
- Create: `tests/unit/main/types.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/main/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { BuddyError, TaskEventEnvelope } from '../../../src/shared/types'

describe('native buddy shared types', () => {
  it('supports structured IPC errors', () => {
    const error: BuddyError = {
      code: 'TASK_NOT_FOUND',
      message: 'Task not found',
      recoverable: false,
      details: { task_id: 'missing' }
    }

    expect(error.code).toBe('TASK_NOT_FOUND')
    expect(error.recoverable).toBe(false)
  })

  it('supports task event envelopes for live IPC updates', () => {
    const envelope: TaskEventEnvelope = {
      workspace_key: 'abc123def456',
      task_id: 'demo',
      event: {
        seq: 1,
        type: 'task.updated',
        ts: '2026-05-26T00:00:00.000Z',
        payload: { status: 'READY' }
      }
    }

    expect(envelope.event.type).toBe('task.updated')
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/types.test.ts
```

Expected: FAIL because `BuddyError` and `TaskEventEnvelope` are not exported.

**Step 3: Write minimal implementation**

Append to `src/shared/types.ts`:

```ts
export interface BuddyError {
  code: string
  message: string
  details?: unknown
  recoverable?: boolean
}

export interface TaskEventEnvelope {
  workspace_key: string
  task_id: string
  event: Event
}

export interface CreateTaskInput {
  task_id: string
  repo_root?: string
  task_text?: string
  context_text?: string
  settings?: Record<string, unknown>
}

export interface CreateTaskResult {
  task: string
  path: string
  workspace_key: string
}

export interface StartTaskInput {
  actor?: string
  message?: string
  workspace_key?: string
}

export interface SendMessageInput {
  actor?: string
  message?: string
  workspace_key?: string
}

export interface CountdownInput {
  next_actor?: string
  workspace_key?: string
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm test tests/unit/main/types.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/shared/types.ts tests/unit/main/types.test.ts
git commit -m "feat: add native buddy api types"
```

## Task 2: Define The Preload Buddy Bridge

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/global.d.ts`
- Create: `src/preload/buddy-api.ts`
- Create: `tests/unit/preload/buddy-api.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/preload/buddy-api.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createBuddyPreloadApi } from '../../../src/preload/buddy-api'

describe('createBuddyPreloadApi', () => {
  it('maps methods to buddy IPC channels', async () => {
    const invoke = vi.fn().mockResolvedValue({ version: 'native' })
    const on = vi.fn()
    const removeListener = vi.fn()
    const api = createBuddyPreloadApi({ invoke, on, removeListener })

    await expect(api.bootstrap()).resolves.toEqual({ version: 'native' })
    expect(invoke).toHaveBeenCalledWith('buddy:bootstrap')
  })

  it('returns unsubscribe for live task events', () => {
    const invoke = vi.fn()
    const on = vi.fn()
    const removeListener = vi.fn()
    const api = createBuddyPreloadApi({ invoke, on, removeListener })
    const callback = vi.fn()

    const unsubscribe = api.onTaskEvent(callback)
    expect(on).toHaveBeenCalledWith('buddy:event', expect.any(Function))

    unsubscribe()
    expect(removeListener).toHaveBeenCalledWith('buddy:event', expect.any(Function))
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/preload/buddy-api.test.ts
```

Expected: FAIL because `src/preload/buddy-api.ts` does not exist.

**Step 3: Write minimal implementation**

Create `src/preload/buddy-api.ts`:

```ts
import type {
  BootstrapResponse,
  CountdownInput,
  CreateTaskInput,
  CreateTaskResult,
  Event,
  GlobalSettings,
  SendMessageInput,
  StartTaskInput,
  Task,
  TaskDetail,
  TaskEventEnvelope
} from '../shared/types'

type Listener = (event: unknown, payload: TaskEventEnvelope) => void

interface IpcLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: Listener): void
  removeListener(channel: string, listener: Listener): void
}

export function createBuddyPreloadApi(ipc: IpcLike) {
  return {
    checkHealth: (): Promise<boolean> =>
      ipc.invoke('buddy:checkHealth') as Promise<boolean>,
    bootstrap: (): Promise<BootstrapResponse> =>
      ipc.invoke('buddy:bootstrap') as Promise<BootstrapResponse>,
    getTasks: (): Promise<Task[]> =>
      ipc.invoke('buddy:getTasks') as Promise<Task[]>,
    getTaskDetail: (taskId: string, workspaceKey?: string): Promise<TaskDetail> =>
      ipc.invoke('buddy:getTaskDetail', taskId, workspaceKey) as Promise<TaskDetail>,
    createTask: (input: CreateTaskInput): Promise<CreateTaskResult> =>
      ipc.invoke('buddy:createTask', input) as Promise<CreateTaskResult>,
    deleteTask: (taskId: string, workspaceKey?: string): Promise<void> =>
      ipc.invoke('buddy:deleteTask', taskId, workspaceKey) as Promise<void>,
    startTask: (taskId: string, input: StartTaskInput): Promise<void> =>
      ipc.invoke('buddy:startTask', taskId, input) as Promise<void>,
    sendMessage: (taskId: string, input: SendMessageInput): Promise<void> =>
      ipc.invoke('buddy:sendMessage', taskId, input) as Promise<void>,
    skipCountdown: (taskId: string, input: CountdownInput): Promise<void> =>
      ipc.invoke('buddy:skipCountdown', taskId, input) as Promise<void>,
    pauseCountdown: (taskId: string, input: CountdownInput): Promise<void> =>
      ipc.invoke('buddy:pauseCountdown', taskId, input) as Promise<void>,
    interrupt: (taskId: string, workspaceKey?: string): Promise<void> =>
      ipc.invoke('buddy:interrupt', taskId, workspaceKey) as Promise<void>,
    getEvents: (taskId: string, since: number, workspaceKey?: string): Promise<{ events: Event[] }> =>
      ipc.invoke('buddy:getEvents', taskId, since, workspaceKey) as Promise<{ events: Event[] }>,
    updateGlobalSettings: (settings: GlobalSettings): Promise<GlobalSettings> =>
      ipc.invoke('buddy:updateGlobalSettings', settings) as Promise<GlobalSettings>,
    onTaskEvent: (callback: (payload: TaskEventEnvelope) => void): (() => void) => {
      const listener: Listener = (_event, payload) => callback(payload)
      ipc.on('buddy:event', listener)
      return () => ipc.removeListener('buddy:event', listener)
    }
  }
}

export type BuddyPreloadApi = ReturnType<typeof createBuddyPreloadApi>
```

Modify `src/preload/index.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { createBuddyPreloadApi } from './buddy-api'

const api = {
  selectDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:selectDirectory', defaultPath),
  openInFinder: (path: string): Promise<void> =>
    ipcRenderer.invoke('shell:openInFinder', path),
  onFullScreenChange: (callback: (isFullScreen: boolean) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isFullScreen: boolean) => callback(isFullScreen)
    ipcRenderer.on('window:fullScreenChange', handler)
    return () => { ipcRenderer.removeListener('window:fullScreenChange', handler) }
  },
  isFullScreen: (): Promise<boolean> =>
    ipcRenderer.invoke('window:isFullScreen')
}

const buddy = createBuddyPreloadApi(ipcRenderer)

contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('buddy', buddy)

export type Api = typeof api
export type BuddyApi = typeof buddy
```

Modify `src/renderer/global.d.ts`:

```ts
import type { Api, BuddyApi } from '../preload'

declare global {
  interface Window {
    api: Api
    buddy: BuddyApi
  }
}

export {}
```

**Step 4: Run test and typecheck**

Run:

```bash
pnpm test tests/unit/preload/buddy-api.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/preload/index.ts src/preload/buddy-api.ts src/renderer/global.d.ts tests/unit/preload/buddy-api.test.ts
git commit -m "feat: expose native buddy preload api"
```

## Task 3: Add Main IPC Handler Registration

**Files:**
- Create: `src/main/ipc/buddy-handlers.ts`
- Modify: `src/main/index.ts`
- Create: `tests/unit/main/buddy-handlers.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/main/buddy-handlers.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { registerBuddyHandlers } from '../../../src/main/ipc/buddy-handlers'

describe('registerBuddyHandlers', () => {
  it('registers native buddy channels', async () => {
    const handle = vi.fn()
    const service = {
      checkHealth: vi.fn(),
      bootstrap: vi.fn(),
      getTasks: vi.fn(),
      getTaskDetail: vi.fn(),
      createTask: vi.fn(),
      deleteTask: vi.fn(),
      startTask: vi.fn(),
      sendMessage: vi.fn(),
      skipCountdown: vi.fn(),
      pauseCountdown: vi.fn(),
      interrupt: vi.fn(),
      getEvents: vi.fn(),
      updateGlobalSettings: vi.fn(),
      onTaskEvent: vi.fn()
    }

    registerBuddyHandlers({ handle }, service)

    expect(handle).toHaveBeenCalledWith('buddy:bootstrap', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:startTask', expect.any(Function))
    expect(handle).toHaveBeenCalledTimes(13)
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-handlers.test.ts
```

Expected: FAIL because `buddy-handlers.ts` does not exist.

**Step 3: Write minimal implementation**

Create `src/main/ipc/buddy-handlers.ts`:

```ts
import type { IpcMain } from 'electron'
import type {
  CountdownInput,
  CreateTaskInput,
  GlobalSettings,
  SendMessageInput,
  StartTaskInput
} from '../../shared/types'

export interface BuddyHandlerService {
  checkHealth(): Promise<boolean>
  bootstrap(): Promise<unknown>
  getTasks(): Promise<unknown>
  getTaskDetail(taskId: string, workspaceKey?: string): Promise<unknown>
  createTask(input: CreateTaskInput): Promise<unknown>
  deleteTask(taskId: string, workspaceKey?: string): Promise<void>
  startTask(taskId: string, input: StartTaskInput): Promise<void>
  sendMessage(taskId: string, input: SendMessageInput): Promise<void>
  skipCountdown(taskId: string, input: CountdownInput): Promise<void>
  pauseCountdown(taskId: string, input: CountdownInput): Promise<void>
  interrupt(taskId: string, workspaceKey?: string): Promise<void>
  getEvents(taskId: string, since: number, workspaceKey?: string): Promise<unknown>
  updateGlobalSettings(settings: GlobalSettings): Promise<unknown>
}

type IpcHandle = Pick<IpcMain, 'handle'>

export function registerBuddyHandlers(ipcMain: IpcHandle, service: BuddyHandlerService): void {
  ipcMain.handle('buddy:checkHealth', () => service.checkHealth())
  ipcMain.handle('buddy:bootstrap', () => service.bootstrap())
  ipcMain.handle('buddy:getTasks', () => service.getTasks())
  ipcMain.handle('buddy:getTaskDetail', (_event, taskId: string, workspaceKey?: string) =>
    service.getTaskDetail(taskId, workspaceKey)
  )
  ipcMain.handle('buddy:createTask', (_event, input: CreateTaskInput) =>
    service.createTask(input)
  )
  ipcMain.handle('buddy:deleteTask', (_event, taskId: string, workspaceKey?: string) =>
    service.deleteTask(taskId, workspaceKey)
  )
  ipcMain.handle('buddy:startTask', (_event, taskId: string, input: StartTaskInput) =>
    service.startTask(taskId, input)
  )
  ipcMain.handle('buddy:sendMessage', (_event, taskId: string, input: SendMessageInput) =>
    service.sendMessage(taskId, input)
  )
  ipcMain.handle('buddy:skipCountdown', (_event, taskId: string, input: CountdownInput) =>
    service.skipCountdown(taskId, input)
  )
  ipcMain.handle('buddy:pauseCountdown', (_event, taskId: string, input: CountdownInput) =>
    service.pauseCountdown(taskId, input)
  )
  ipcMain.handle('buddy:interrupt', (_event, taskId: string, workspaceKey?: string) =>
    service.interrupt(taskId, workspaceKey)
  )
  ipcMain.handle('buddy:getEvents', (_event, taskId: string, since: number, workspaceKey?: string) =>
    service.getEvents(taskId, since, workspaceKey)
  )
  ipcMain.handle('buddy:updateGlobalSettings', (_event, settings: GlobalSettings) =>
    service.updateGlobalSettings(settings)
  )
}
```

Modify `src/main/index.ts` after `const windowManager = new WindowManager()`:

```ts
import { registerBuddyHandlers } from './ipc/buddy-handlers'
import { BuddyCoreService } from './buddy/service'

const buddyService = new BuddyCoreService()
registerBuddyHandlers(ipcMain, buddyService)
```

If `BuddyCoreService` does not exist yet, create the stub in Task 4 first or temporarily use a TODO service object in `index.ts`. Keep the commit compiling.

**Step 4: Run test**

Run:

```bash
pnpm test tests/unit/main/buddy-handlers.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/ipc/buddy-handlers.ts src/main/index.ts tests/unit/main/buddy-handlers.test.ts
git commit -m "feat: register native buddy ipc handlers"
```

## Task 4: Add Buddy Core Service Stub

**Files:**
- Create: `src/main/buddy/service.ts`
- Create: `tests/unit/main/buddy-service.test.ts`
- Modify: `src/main/index.ts`

**Step 1: Write the failing test**

Create `tests/unit/main/buddy-service.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BuddyCoreService } from '../../../src/main/buddy/service'

describe('BuddyCoreService', () => {
  it('reports native health without HTTP', async () => {
    const service = new BuddyCoreService()

    await expect(service.checkHealth()).resolves.toBe(true)
  })

  it('returns empty bootstrap before store is wired', async () => {
    const service = new BuddyCoreService()

    await expect(service.bootstrap()).resolves.toMatchObject({
      version: 'native',
      tasks: []
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-service.test.ts
```

Expected: FAIL because `BuddyCoreService` does not exist.

**Step 3: Write minimal implementation**

Create `src/main/buddy/service.ts`:

```ts
import type {
  BootstrapResponse,
  CountdownInput,
  CreateTaskInput,
  CreateTaskResult,
  Event,
  GlobalSettings,
  SendMessageInput,
  StartTaskInput,
  Task,
  TaskDetail
} from '../../shared/types'

export class BuddyCoreService {
  async checkHealth(): Promise<boolean> {
    return true
  }

  async bootstrap(): Promise<BootstrapResponse> {
    return {
      version: 'native',
      repo_root: '',
      data_root: '',
      tasks: []
    }
  }

  async getTasks(): Promise<Task[]> {
    return []
  }

  async getTaskDetail(_taskId: string, _workspaceKey?: string): Promise<TaskDetail> {
    throw new Error('Task detail store is not implemented yet')
  }

  async createTask(_input: CreateTaskInput): Promise<CreateTaskResult> {
    throw new Error('Task creation is not implemented yet')
  }

  async deleteTask(_taskId: string, _workspaceKey?: string): Promise<void> {
    throw new Error('Task deletion is not implemented yet')
  }

  async startTask(_taskId: string, _input: StartTaskInput): Promise<void> {
    throw new Error('Runner is not implemented yet')
  }

  async sendMessage(_taskId: string, _input: SendMessageInput): Promise<void> {
    throw new Error('Messaging is not implemented yet')
  }

  async skipCountdown(_taskId: string, _input: CountdownInput): Promise<void> {
    throw new Error('Countdown is not implemented yet')
  }

  async pauseCountdown(_taskId: string, _input: CountdownInput): Promise<void> {
    throw new Error('Countdown is not implemented yet')
  }

  async interrupt(_taskId: string, _workspaceKey?: string): Promise<void> {
    throw new Error('Interrupt is not implemented yet')
  }

  async getEvents(_taskId: string, _since: number, _workspaceKey?: string): Promise<{ events: Event[] }> {
    return { events: [] }
  }

  async updateGlobalSettings(settings: GlobalSettings): Promise<GlobalSettings> {
    return settings
  }
}
```

Modify `src/main/index.ts` so `BuddyCoreService` is registered before window creation:

```ts
const windowManager = new WindowManager()
const buddyService = new BuddyCoreService()

registerBuddyHandlers(ipcMain, buddyService)
```

**Step 4: Run test and typecheck**

Run:

```bash
pnpm test tests/unit/main/buddy-service.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/buddy/service.ts src/main/index.ts tests/unit/main/buddy-service.test.ts
git commit -m "feat: add native buddy core service"
```

## Task 5: Move Renderer API From Axios To IPC

**Files:**
- Modify: `src/renderer/lib/api.ts`
- Create: `tests/unit/renderer/api.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/renderer/api.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('renderer api', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('window', {
      buddy: {
        checkHealth: vi.fn().mockResolvedValue(true),
        bootstrap: vi.fn().mockResolvedValue({ version: 'native', tasks: [] }),
        getTasks: vi.fn().mockResolvedValue([]),
        getTaskDetail: vi.fn(),
        createTask: vi.fn(),
        deleteTask: vi.fn(),
        startTask: vi.fn(),
        sendMessage: vi.fn(),
        skipCountdown: vi.fn(),
        pauseCountdown: vi.fn(),
        interrupt: vi.fn(),
        getEvents: vi.fn(),
        updateGlobalSettings: vi.fn()
      }
    })
  })

  it('uses the preload buddy API for health checks', async () => {
    const { api } = await import('../../../src/renderer/lib/api')

    await expect(api.checkHealth()).resolves.toBe(true)
    expect(window.buddy.checkHealth).toHaveBeenCalled()
  })

  it('uses the preload buddy API for bootstrap', async () => {
    const { api } = await import('../../../src/renderer/lib/api')

    await expect(api.bootstrap()).resolves.toEqual({ version: 'native', tasks: [] })
    expect(window.buddy.bootstrap).toHaveBeenCalled()
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/renderer/api.test.ts
```

Expected: FAIL because `src/renderer/lib/api.ts` imports axios and does not call `window.buddy`.

**Step 3: Write minimal implementation**

Replace `src/renderer/lib/api.ts` with:

```ts
import type { CreateTaskInput, GlobalSettings } from '../../shared/types'

function buddy() {
  if (!window.buddy) {
    throw new Error('Native Buddy API is unavailable')
  }
  return window.buddy
}

export const api = {
  checkHealth: () => buddy().checkHealth(),
  bootstrap: () => buddy().bootstrap(),
  getTasks: () => buddy().getTasks(),
  getTaskDetail: (taskId: string, workspaceKey?: string) =>
    buddy().getTaskDetail(taskId, workspaceKey),
  createTask: (data: CreateTaskInput) =>
    buddy().createTask(data),
  deleteTask: (taskId: string, workspaceKey?: string) =>
    buddy().deleteTask(taskId, workspaceKey),
  startTask: (
    taskId: string,
    data: { actor?: string; message?: string; workspace_key?: string }
  ) => buddy().startTask(taskId, data),
  sendMessage: (
    taskId: string,
    data: { actor?: string; message?: string; workspace_key?: string }
  ) => buddy().sendMessage(taskId, data),
  skipCountdown: (
    taskId: string,
    data: { next_actor?: string; workspace_key?: string }
  ) => buddy().skipCountdown(taskId, data),
  pauseCountdown: (
    taskId: string,
    data: { next_actor?: string; workspace_key?: string }
  ) => buddy().pauseCountdown(taskId, data),
  interrupt: (taskId: string, workspaceKey?: string) =>
    buddy().interrupt(taskId, workspaceKey),
  getEvents: (taskId: string, since: number, workspaceKey?: string) =>
    buddy().getEvents(taskId, since, workspaceKey),
  updateGlobalSettings: (settings: GlobalSettings) =>
    buddy().updateGlobalSettings(settings)
}
```

**Step 4: Run tests and typecheck**

Run:

```bash
pnpm test tests/unit/renderer/api.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/renderer/lib/api.ts tests/unit/renderer/api.test.ts
git commit -m "feat: route renderer buddy api through ipc"
```

## Task 6: Remove The Renderer HTTP Proxy

**Files:**
- Modify: `src/main/window-manager.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `tests/unit/main/window-manager-source.test.ts`

**Step 1: Write the failing source test**

Create `tests/unit/main/window-manager-source.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('window manager source', () => {
  it('does not proxy renderer requests to the Python HTTP server', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/window-manager.ts'), 'utf8')

    expect(source).not.toContain('127.0.0.1:8765')
    expect(source).not.toContain('onBeforeRequest')
    expect(source).not.toContain('file:///api/*')
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/window-manager-source.test.ts
```

Expected: FAIL because `window-manager.ts` contains the HTTP proxy.

**Step 3: Remove proxy implementation**

Modify `src/main/window-manager.ts`:

```ts
import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
```

Remove:

- `session` import
- `BUDDY_API_ORIGIN`
- `this.setupApiProxy()`
- the entire `setupApiProxy()` method

If `axios` is no longer used after Task 5, remove it:

```bash
pnpm remove axios
```

Only remove axios if `rg "from 'axios'|axios" src tests package.json` confirms no source references remain.

**Step 4: Run tests**

Run:

```bash
pnpm test tests/unit/main/window-manager-source.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/window-manager.ts package.json pnpm-lock.yaml tests/unit/main/window-manager-source.test.ts
git commit -m "feat: remove buddy http proxy"
```

## Task 7: Add Buddy Path Resolution

**Files:**
- Create: `src/main/buddy/paths.ts`
- Create: `tests/unit/main/buddy-paths.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/main/buddy-paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createBuddyPaths, workspaceKeyForRepo } from '../../../src/main/buddy/paths'

describe('buddy paths', () => {
  it('uses macOS application support buddy directory', () => {
    const paths = createBuddyPaths('/Users/demo/Library/Application Support/buddy')

    expect(paths.dataRoot).toBe('/Users/demo/Library/Application Support/buddy')
    expect(paths.globalSettings).toBe('/Users/demo/Library/Application Support/buddy/global/settings.json')
    expect(paths.runtimeTasksDir).toBe('/Users/demo/Library/Application Support/buddy/runtime/tasks')
  })

  it('derives stable 12 character workspace keys from repo roots', () => {
    expect(workspaceKeyForRepo('/tmp/project')).toMatch(/^[a-f0-9]{12}$/)
    expect(workspaceKeyForRepo('/tmp/project')).toBe(workspaceKeyForRepo('/tmp/project'))
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-paths.test.ts
```

Expected: FAIL because `paths.ts` does not exist.

**Step 3: Write minimal implementation**

Create `src/main/buddy/paths.ts`:

```ts
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export interface BuddyPaths {
  dataRoot: string
  globalSettings: string
  workspacesDir: string
  runtimeTasksDir: string
}

export function createBuddyPaths(dataRoot: string): BuddyPaths {
  return {
    dataRoot,
    globalSettings: join(dataRoot, 'global', 'settings.json'),
    workspacesDir: join(dataRoot, 'workspaces'),
    runtimeTasksDir: join(dataRoot, 'runtime', 'tasks')
  }
}

export function workspaceKeyForRepo(repoRoot: string): string {
  return createHash('sha256').update(repoRoot).digest('hex').slice(0, 12)
}

export function workspaceDir(paths: BuddyPaths, workspaceKey: string): string {
  return join(paths.workspacesDir, workspaceKey)
}

export function taskDir(paths: BuddyPaths, workspaceKey: string, taskId: string): string {
  return join(workspaceDir(paths, workspaceKey), 'tasks', taskId)
}
```

**Step 4: Run test**

Run:

```bash
pnpm test tests/unit/main/buddy-paths.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/buddy/paths.ts tests/unit/main/buddy-paths.test.ts
git commit -m "feat: add buddy path helpers"
```

## Task 8: Add Schema Validation Dependency And Schemas

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/main/buddy/schemas.ts`
- Create: `tests/unit/main/buddy-schemas.test.ts`

**Step 1: Install Zod**

Run:

```bash
pnpm add zod
```

Expected: `package.json` and `pnpm-lock.yaml` update.

**Step 2: Write the failing test**

Create `tests/unit/main/buddy-schemas.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseEventLine, parseTaskState } from '../../../src/main/buddy/schemas'

describe('buddy schemas', () => {
  it('parses task state with defaults for optional fields', () => {
    const state = parseTaskState({
      status: 'READY',
      round: 1,
      next_actor: 'claude',
      active_run: null
    })

    expect(state.status).toBe('READY')
    expect(state.round).toBe(1)
  })

  it('parses event json lines', () => {
    const event = parseEventLine('{"seq":1,"type":"task.created","ts":"2026-05-26T00:00:00.000Z","payload":{}}')

    expect(event.seq).toBe(1)
    expect(event.type).toBe('task.created')
  })

  it('rejects malformed event json lines', () => {
    expect(() => parseEventLine('{bad')).toThrow()
  })
})
```

**Step 3: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-schemas.test.ts
```

Expected: FAIL because `schemas.ts` does not exist.

**Step 4: Write minimal implementation**

Create `src/main/buddy/schemas.ts`:

```ts
import { z } from 'zod'

const taskStatusSchema = z.enum([
  'READY',
  'RUNNING_CLAUDE',
  'RUNNING_CODEX',
  'RUNNING_OPENCODE',
  'RUNNING_KIMI',
  'COUNTDOWN',
  'PAUSED',
  'FAILED',
  'DONE'
])

const activeRunSchema = z.object({
  actor: z.string(),
  started_at: z.string()
})

const countdownSchema = z.object({
  status: z.enum(['running', 'paused', 'elapsed', 'skipped', 'expired']),
  remaining: z.number(),
  default_next_actor: z.string(),
  deadline: z.string().optional()
})

export const taskStateSchema = z.object({
  status: taskStatusSchema,
  round: z.number(),
  next_actor: z.string(),
  countdown: countdownSchema.optional(),
  active_run: activeRunSchema.nullable().optional(),
  claude_session_id: z.string().optional(),
  codex_thread_id: z.string().optional(),
  opencode_session_id: z.string().optional(),
  kimi_session_id: z.string().optional(),
  updated_at: z.string().optional(),
  repo_root: z.string().optional(),
  pending_break: z.object({ actor: z.string().optional() }).nullable().optional()
})

export const eventSchema = z.object({
  seq: z.number(),
  type: z.string(),
  actor: z.string().optional(),
  ts: z.string(),
  payload: z.record(z.string(), z.unknown())
})

export function parseTaskState(input: unknown) {
  return taskStateSchema.parse(input)
}

export function parseEventLine(line: string) {
  return eventSchema.parse(JSON.parse(line))
}
```

**Step 5: Run test and typecheck**

Run:

```bash
pnpm test tests/unit/main/buddy-schemas.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/main/buddy/schemas.ts tests/unit/main/buddy-schemas.test.ts
git commit -m "feat: add buddy schema validation"
```

## Task 9: Implement Store Read Model

**Files:**
- Create: `src/main/buddy/store.ts`
- Modify: `src/main/buddy/service.ts`
- Create: `tests/unit/main/buddy-store.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/main/buddy-store.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'

describe('BuddyStore read model', () => {
  it('loads tasks and task detail from the buddy data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-store-'))
    const taskDir = join(root, 'workspaces', 'abc123def456', 'tasks', 'demo')
    await mkdir(taskDir, { recursive: true })
    await writeFile(join(taskDir, 'settings.json'), JSON.stringify({
      protocol_version: '1',
      countdown_seconds: 30,
      flow_policy: 'claude_then_codex',
      role_mode: 'claude_implements',
      launchers: {}
    }))
    await writeFile(join(taskDir, 'state.json'), JSON.stringify({
      status: 'READY',
      round: 1,
      next_actor: 'claude',
      active_run: null,
      updated_at: '2026-05-26T00:00:00.000Z',
      repo_root: '/tmp/repo'
    }))
    await writeFile(join(taskDir, 'transcript.md'), 'hello transcript')
    await writeFile(join(taskDir, 'events.jsonl'), '{"seq":1,"type":"task.created","ts":"2026-05-26T00:00:00.000Z","payload":{}}\n')

    const store = new BuddyStore(root)

    await expect(store.getTasks()).resolves.toEqual([
      expect.objectContaining({
        task_id: 'demo',
        workspace_key: 'abc123def456',
        status: 'READY',
        repo_root: '/tmp/repo'
      })
    ])

    await expect(store.getTaskDetail('demo', 'abc123def456')).resolves.toMatchObject({
      task_id: 'demo',
      workspace_key: 'abc123def456',
      task_text: '',
      context_text: '',
      transcript: [],
      events: [expect.objectContaining({ seq: 1 })]
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-store.test.ts
```

Expected: FAIL because `BuddyStore` does not exist.

**Step 3: Write minimal implementation**

Create `src/main/buddy/store.ts` with these public methods:

```ts
export class BuddyStore {
  constructor(private readonly dataRoot: string) {}

  async getTasks(): Promise<Task[]> {
    // scan workspaces/*/tasks/*
    // read state.json
    // return Task summaries sorted by updated_at descending
  }

  async getTaskDetail(taskId: string, workspaceKey: string): Promise<TaskDetail> {
    // read settings.json, state.json, transcript.md, events.jsonl
    // parse JSON through schemas
    // return TaskDetail
  }

  async getEvents(taskId: string, since: number, workspaceKey: string): Promise<{ events: Event[] }> {
    // read events.jsonl and filter event.seq > since
  }
}
```

Use `node:fs/promises` and helper functions from `src/main/buddy/paths.ts` and `src/main/buddy/schemas.ts`.

For the first pass, parse `transcript.md` into an empty array unless the existing transcript format is already structured. Do not block the read model on perfect transcript parsing.

**Step 4: Wire service to store**

Modify `src/main/buddy/service.ts`:

```ts
import { app } from 'electron'
import { join } from 'node:path'
import { BuddyStore } from './store'

export class BuddyCoreService {
  private readonly store: BuddyStore

  constructor(dataRoot = join(app.getPath('appData'), 'buddy')) {
    this.store = new BuddyStore(dataRoot)
  }

  async bootstrap(): Promise<BootstrapResponse> {
    return {
      version: 'native',
      repo_root: '',
      data_root: this.store.dataRoot,
      tasks: await this.store.getTasks()
    }
  }

  getTasks(): Promise<Task[]> {
    return this.store.getTasks()
  }

  getTaskDetail(taskId: string, workspaceKey?: string): Promise<TaskDetail> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    return this.store.getTaskDetail(taskId, workspaceKey)
  }

  getEvents(taskId: string, since: number, workspaceKey?: string): Promise<{ events: Event[] }> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    return this.store.getEvents(taskId, since, workspaceKey)
  }
}
```

Make `dataRoot` public readonly on `BuddyStore`.

**Step 5: Run tests**

Run:

```bash
pnpm test tests/unit/main/buddy-store.test.ts tests/unit/main/buddy-service.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/main/buddy/store.ts src/main/buddy/service.ts tests/unit/main/buddy-store.test.ts tests/unit/main/buddy-service.test.ts
git commit -m "feat: read buddy tasks from native store"
```

## Task 10: Implement Atomic Store Writes And Task Creation

**Files:**
- Modify: `src/main/buddy/store.ts`
- Modify: `src/main/buddy/service.ts`
- Create: `tests/unit/main/buddy-store-write.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/main/buddy-store-write.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'

describe('BuddyStore writes', () => {
  it('creates a task with state, settings, transcript, and initial event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-write-'))
    const store = new BuddyStore(root)

    const result = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      task_text: 'Build it',
      context_text: 'Use tests'
    })

    const taskDir = join(root, 'workspaces', result.workspace_key, 'tasks', 'demo')
    await expect(readFile(join(taskDir, 'state.json'), 'utf8')).resolves.toContain('"status":"READY"')
    await expect(readFile(join(taskDir, 'settings.json'), 'utf8')).resolves.toContain('"protocol_version":"1"')
    await expect(readFile(join(taskDir, 'transcript.md'), 'utf8')).resolves.toContain('Build it')
    await expect(readFile(join(taskDir, 'events.jsonl'), 'utf8')).resolves.toContain('"task.created"')
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-store-write.test.ts
```

Expected: FAIL because `createTask` is not implemented.

**Step 3: Write minimal implementation**

Modify `src/main/buddy/store.ts`:

```ts
async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
  const repoRoot = input.repo_root ?? ''
  const workspaceKey = workspaceKeyForRepo(repoRoot || input.task_id)
  const dir = taskDir(createBuddyPaths(this.dataRoot), workspaceKey, input.task_id)
  await mkdir(join(dir, 'artifacts'), { recursive: true })

  await atomicWriteJson(join(dir, 'settings.json'), defaultTaskSettings(input.settings))
  await atomicWriteJson(join(dir, 'state.json'), defaultTaskState(repoRoot))
  await atomicWriteText(join(dir, 'transcript.md'), initialTranscript(input))
  await appendEvent(join(dir, 'events.jsonl'), {
    seq: 1,
    type: 'task.created',
    ts: new Date().toISOString(),
    payload: { task_text: input.task_text ?? '', context_text: input.context_text ?? '' }
  })

  return { task: input.task_id, path: dir, workspace_key: workspaceKey }
}
```

Add local helper functions:

- `atomicWriteJson(path, value)`
- `atomicWriteText(path, value)`
- `defaultTaskSettings(overrides)`
- `defaultTaskState(repoRoot)`
- `initialTranscript(input)`
- `appendEvent(path, event)`

**Step 4: Wire service**

Modify `src/main/buddy/service.ts`:

```ts
createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
  return this.store.createTask(input)
}
```

**Step 5: Run tests**

Run:

```bash
pnpm test tests/unit/main/buddy-store-write.test.ts tests/unit/main/buddy-store.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/main/buddy/store.ts src/main/buddy/service.ts tests/unit/main/buddy-store-write.test.ts
git commit -m "feat: create buddy tasks in native store"
```

## Task 11: Implement Delete Task And Global Settings Writes

**Files:**
- Modify: `src/main/buddy/store.ts`
- Modify: `src/main/buddy/service.ts`
- Create: `tests/unit/main/buddy-settings.test.ts`

**Step 1: Write failing tests**

Create `tests/unit/main/buddy-settings.test.ts`:

```ts
import { access, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'

describe('BuddyStore settings and delete', () => {
  it('updates global settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-settings-'))
    const store = new BuddyStore(root)

    await store.updateGlobalSettings({ countdown_seconds: 45 })

    await expect(readFile(join(root, 'global', 'settings.json'), 'utf8')).resolves.toContain('"countdown_seconds":45')
  })

  it('deletes task directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-delete-'))
    const store = new BuddyStore(root)
    const created = await store.createTask({ task_id: 'demo', repo_root: '/tmp/repo' })

    await store.deleteTask('demo', created.workspace_key)

    await expect(access(created.path)).rejects.toThrow()
  })
})
```

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test tests/unit/main/buddy-settings.test.ts
```

Expected: FAIL because methods are not implemented.

**Step 3: Implement store methods**

Modify `src/main/buddy/store.ts`:

```ts
async deleteTask(taskId: string, workspaceKey: string): Promise<void> {
  await rm(taskDir(createBuddyPaths(this.dataRoot), workspaceKey, taskId), {
    recursive: true,
    force: true
  })
}

async updateGlobalSettings(settings: GlobalSettings): Promise<GlobalSettings> {
  const path = createBuddyPaths(this.dataRoot).globalSettings
  await mkdir(dirname(path), { recursive: true })
  await atomicWriteJson(path, settings)
  return settings
}
```

**Step 4: Wire service**

Modify `src/main/buddy/service.ts`:

```ts
deleteTask(taskId: string, workspaceKey?: string): Promise<void> {
  if (!workspaceKey) throw new Error('workspaceKey is required')
  return this.store.deleteTask(taskId, workspaceKey)
}

updateGlobalSettings(settings: GlobalSettings): Promise<GlobalSettings> {
  return this.store.updateGlobalSettings(settings)
}
```

**Step 5: Run tests**

Run:

```bash
pnpm test tests/unit/main/buddy-settings.test.ts tests/unit/main/buddy-store-write.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/main/buddy/store.ts src/main/buddy/service.ts tests/unit/main/buddy-settings.test.ts
git commit -m "feat: update native buddy settings"
```

## Task 12: Add Event Bus

**Files:**
- Create: `src/main/buddy/events.ts`
- Modify: `src/main/ipc/buddy-handlers.ts`
- Modify: `src/main/index.ts`
- Create: `tests/unit/main/buddy-events.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/main/buddy-events.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { BuddyEventBus } from '../../../src/main/buddy/events'

describe('BuddyEventBus', () => {
  it('publishes task event envelopes to subscribers', () => {
    const bus = new BuddyEventBus()
    const callback = vi.fn()
    const unsubscribe = bus.subscribe(callback)

    bus.publish({
      workspace_key: 'abc123def456',
      task_id: 'demo',
      event: {
        seq: 1,
        type: 'task.updated',
        ts: '2026-05-26T00:00:00.000Z',
        payload: {}
      }
    })

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ task_id: 'demo' }))

    unsubscribe()
    bus.publish({
      workspace_key: 'abc123def456',
      task_id: 'demo',
      event: {
        seq: 2,
        type: 'task.updated',
        ts: '2026-05-26T00:00:01.000Z',
        payload: {}
      }
    })

    expect(callback).toHaveBeenCalledTimes(1)
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-events.test.ts
```

Expected: FAIL because `events.ts` does not exist.

**Step 3: Implement event bus**

Create `src/main/buddy/events.ts`:

```ts
import type { BrowserWindow } from 'electron'
import type { TaskEventEnvelope } from '../../shared/types'

type Subscriber = (event: TaskEventEnvelope) => void

export class BuddyEventBus {
  private readonly subscribers = new Set<Subscriber>()

  subscribe(callback: Subscriber): () => void {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  publish(event: TaskEventEnvelope): void {
    for (const subscriber of this.subscribers) {
      subscriber(event)
    }
  }

  publishToWindow(window: BrowserWindow, event: TaskEventEnvelope): void {
    window.webContents.send('buddy:event', event)
  }
}
```

**Step 4: Wire main window publishing**

Modify `src/main/index.ts`:

```ts
const buddyEvents = new BuddyEventBus()
const buddyService = new BuddyCoreService({ events: buddyEvents })

buddyEvents.subscribe((event) => {
  windowManager.getMainWindow()?.webContents.send('buddy:event', event)
})
```

If the service constructor still accepts only `dataRoot`, change it to an options object:

```ts
interface BuddyCoreServiceOptions {
  dataRoot?: string
  events?: BuddyEventBus
}
```

**Step 5: Run tests and typecheck**

Run:

```bash
pnpm test tests/unit/main/buddy-events.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/main/buddy/events.ts src/main/index.ts src/main/ipc/buddy-handlers.ts tests/unit/main/buddy-events.test.ts
git commit -m "feat: add native buddy event bus"
```

## Task 13: Implement Runner State Transitions Without Launchers

**Files:**
- Create: `src/main/buddy/runner.ts`
- Modify: `src/main/buddy/store.ts`
- Modify: `src/main/buddy/service.ts`
- Create: `tests/unit/main/buddy-runner.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/main/buddy-runner.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'
import { BuddyRunner } from '../../../src/main/buddy/runner'

describe('BuddyRunner state transitions', () => {
  it('moves READY task to RUNNING actor state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-'))
    const store = new BuddyStore(root)
    const created = await store.createTask({ task_id: 'demo', repo_root: '/tmp/repo' })
    const runner = new BuddyRunner(store)

    const result = await runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'claude'
    })

    const detail = await store.getTaskDetail('demo', created.workspace_key)

    expect(result.run_id).toMatch(/^run_/)
    expect(detail.state.status).toBe('RUNNING_CLAUDE')
    expect(detail.state.active_run?.actor).toBe('claude')
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-runner.test.ts
```

Expected: FAIL because `BuddyRunner` does not exist.

**Step 3: Add store state update helpers**

Modify `src/main/buddy/store.ts`:

```ts
async updateTaskState(taskId: string, workspaceKey: string, update: (state: TaskState) => TaskState): Promise<TaskState> {
  const current = await this.readTaskState(taskId, workspaceKey)
  const next = update(current)
  await atomicWriteJson(this.statePath(taskId, workspaceKey), next)
  return next
}

async appendTaskEvent(taskId: string, workspaceKey: string, event: Omit<Event, 'seq' | 'ts'>): Promise<Event> {
  const existing = await this.getEvents(taskId, 0, workspaceKey)
  const next = {
    seq: existing.events.length + 1,
    ts: new Date().toISOString(),
    ...event
  }
  await appendEvent(this.eventsPath(taskId, workspaceKey), next)
  return next
}
```

**Step 4: Implement runner**

Create `src/main/buddy/runner.ts`:

```ts
import type { StartTaskInput } from '../../shared/types'
import { BuddyStore } from './store'

const ACTOR_STATUS: Record<string, string> = {
  claude: 'RUNNING_CLAUDE',
  codex: 'RUNNING_CODEX',
  opencode: 'RUNNING_OPENCODE',
  kimi: 'RUNNING_KIMI'
}

export class BuddyRunner {
  constructor(private readonly store: BuddyStore) {}

  async startTask(taskId: string, input: StartTaskInput): Promise<{ run_id: string }> {
    if (!input.workspace_key) throw new Error('workspace_key is required')
    const actor = input.actor ?? 'claude'
    const status = ACTOR_STATUS[actor]
    if (!status) throw new Error(`Unsupported actor: ${actor}`)
    const runId = `run_${Date.now()}`

    await this.store.updateTaskState(taskId, input.workspace_key, (state) => {
      if (state.status !== 'READY' && state.status !== 'PAUSED') {
        throw new Error(`Cannot start task from ${state.status}`)
      }
      return {
        ...state,
        status: status as never,
        active_run: {
          actor,
          started_at: new Date().toISOString()
        },
        updated_at: new Date().toISOString()
      }
    })

    await this.store.appendTaskEvent(taskId, input.workspace_key, {
      type: 'actor.started',
      actor,
      payload: { run_id: runId }
    })

    return { run_id: runId }
  }
}
```

**Step 5: Wire service**

Modify `src/main/buddy/service.ts`:

```ts
private readonly runner: BuddyRunner

constructor(options: BuddyCoreServiceOptions = {}) {
  this.store = new BuddyStore(options.dataRoot ?? join(app.getPath('appData'), 'buddy'))
  this.runner = new BuddyRunner(this.store)
}

startTask(taskId: string, input: StartTaskInput): Promise<void> {
  return this.runner.startTask(taskId, input).then(() => undefined)
}
```

If preserving `run_id` to renderer is useful, change the shared handler and preload `startTask` return type to `Promise<{ run_id: string }>` in the same commit.

**Step 6: Run tests**

Run:

```bash
pnpm test tests/unit/main/buddy-runner.test.ts tests/unit/main/buddy-store-write.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/main/buddy/runner.ts src/main/buddy/store.ts src/main/buddy/service.ts tests/unit/main/buddy-runner.test.ts
git commit -m "feat: add native buddy runner state start"
```

## Task 14: Add Countdown Transitions

**Files:**
- Modify: `src/main/buddy/runner.ts`
- Modify: `src/main/buddy/service.ts`
- Create: `tests/unit/main/buddy-countdown.test.ts`

**Step 1: Write failing tests**

Create `tests/unit/main/buddy-countdown.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'
import { BuddyRunner } from '../../../src/main/buddy/runner'

describe('BuddyRunner countdown', () => {
  it('pauses a running countdown back to READY', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-countdown-'))
    const store = new BuddyStore(root)
    const created = await store.createTask({ task_id: 'demo', repo_root: '/tmp/repo' })
    await store.updateTaskState('demo', created.workspace_key, (state) => ({
      ...state,
      status: 'COUNTDOWN',
      countdown: { status: 'running', remaining: 30, default_next_actor: 'codex' }
    }))
    const runner = new BuddyRunner(store)

    await runner.pauseCountdown('demo', { workspace_key: created.workspace_key })

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    expect(detail.state.status).toBe('READY')
    expect(detail.state.countdown?.status).toBe('paused')
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-countdown.test.ts
```

Expected: FAIL because countdown methods do not exist.

**Step 3: Implement countdown methods**

Modify `src/main/buddy/runner.ts`:

```ts
async pauseCountdown(taskId: string, input: CountdownInput): Promise<void> {
  if (!input.workspace_key) throw new Error('workspace_key is required')
  await this.store.updateTaskState(taskId, input.workspace_key, (state) => {
    if (state.status !== 'COUNTDOWN' || state.countdown?.status !== 'running') {
      throw new Error('No running countdown to pause')
    }
    return {
      ...state,
      status: 'READY',
      countdown: { ...state.countdown, status: 'paused' },
      updated_at: new Date().toISOString()
    }
  })
  await this.store.appendTaskEvent(taskId, input.workspace_key, {
    type: 'countdown.paused',
    payload: {}
  })
}

async skipCountdown(taskId: string, input: CountdownInput): Promise<{ run_id: string }> {
  if (!input.workspace_key) throw new Error('workspace_key is required')
  const detail = await this.store.getTaskDetail(taskId, input.workspace_key)
  const actor = input.next_actor ?? detail.state.countdown?.default_next_actor
  if (!actor) throw new Error('next actor is required')
  await this.store.updateTaskState(taskId, input.workspace_key, (state) => ({
    ...state,
    status: 'READY',
    countdown: state.countdown ? { ...state.countdown, status: 'skipped' } : undefined
  }))
  return this.startTask(taskId, { workspace_key: input.workspace_key, actor })
}
```

**Step 4: Wire service**

Modify `src/main/buddy/service.ts`:

```ts
pauseCountdown(taskId: string, input: CountdownInput): Promise<void> {
  return this.runner.pauseCountdown(taskId, input)
}

skipCountdown(taskId: string, input: CountdownInput): Promise<void> {
  return this.runner.skipCountdown(taskId, input).then(() => undefined)
}
```

**Step 5: Run tests**

Run:

```bash
pnpm test tests/unit/main/buddy-countdown.test.ts tests/unit/main/buddy-runner.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/main/buddy/runner.ts src/main/buddy/service.ts tests/unit/main/buddy-countdown.test.ts
git commit -m "feat: add native countdown controls"
```

## Task 15: Add Parser Fixtures For Actor Output

**Files:**
- Create: `src/main/buddy/parsers.ts`
- Create: `tests/unit/main/buddy-parsers.test.ts`

**Step 1: Write failing tests**

Create `tests/unit/main/buddy-parsers.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseClaudeStreamLine, parseCodexJsonLine } from '../../../src/main/buddy/parsers'

describe('buddy actor parsers', () => {
  it('extracts text from Claude stream-json content blocks', () => {
    const event = parseClaudeStreamLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hello' }]
      },
      session_id: 'claude-session'
    }))

    expect(event).toMatchObject({
      text: 'hello',
      sessionId: 'claude-session'
    })
  })

  it('extracts text from Codex json lines', () => {
    const event = parseCodexJsonLine(JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done' }],
      thread_id: 'codex-thread'
    }))

    expect(event).toMatchObject({
      text: 'done',
      threadId: 'codex-thread'
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-parsers.test.ts
```

Expected: FAIL because parser module does not exist.

**Step 3: Implement parser helpers**

Create `src/main/buddy/parsers.ts`:

```ts
export interface ParsedActorLine {
  text?: string
  sessionId?: string
  threadId?: string
  rawType?: string
}

export function parseClaudeStreamLine(line: string): ParsedActorLine {
  const json = JSON.parse(line)
  const text = Array.isArray(json.message?.content)
    ? json.message.content
        .filter((part: { type?: string; text?: string }) => part.type === 'text' && part.text)
        .map((part: { text: string }) => part.text)
        .join('')
    : undefined

  return {
    text,
    sessionId: json.session_id,
    rawType: json.type
  }
}

export function parseCodexJsonLine(line: string): ParsedActorLine {
  const json = JSON.parse(line)
  const text = Array.isArray(json.content)
    ? json.content
        .filter((part: { type?: string; text?: string }) => part.text)
        .map((part: { text: string }) => part.text)
        .join('')
    : json.message

  return {
    text,
    threadId: json.thread_id,
    rawType: json.type
  }
}
```

**Step 4: Run tests**

Run:

```bash
pnpm test tests/unit/main/buddy-parsers.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/buddy/parsers.ts tests/unit/main/buddy-parsers.test.ts
git commit -m "feat: parse actor json output"
```

## Task 16: Add Launcher Abstraction With Fake Process Tests

**Files:**
- Create: `src/main/buddy/launchers.ts`
- Modify: `src/main/buddy/runner.ts`
- Create: `tests/unit/main/buddy-launchers.test.ts`

**Step 1: Write failing tests**

Create `tests/unit/main/buddy-launchers.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildLauncherCommand } from '../../../src/main/buddy/launchers'

describe('launcher command builder', () => {
  it('builds Claude non-interactive stream-json command', () => {
    expect(buildLauncherCommand({
      actor: 'claude',
      command: 'claude',
      promptFile: '/tmp/prompt.md'
    })).toEqual({
      command: 'claude',
      args: ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'text']
    })
  })

  it('builds Codex json command', () => {
    expect(buildLauncherCommand({
      actor: 'codex',
      command: 'codex',
      promptFile: '/tmp/prompt.md'
    }).args).toContain('--json')
  })
})
```

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test tests/unit/main/buddy-launchers.test.ts
```

Expected: FAIL because `launchers.ts` does not exist.

**Step 3: Implement command builder**

Create `src/main/buddy/launchers.ts`:

```ts
export interface LauncherCommandInput {
  actor: string
  command: string
  promptFile: string
  sessionId?: string
}

export interface LauncherCommand {
  command: string
  args: string[]
}

export function buildLauncherCommand(input: LauncherCommandInput): LauncherCommand {
  if (input.actor === 'claude') {
    return {
      command: input.command,
      args: [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--input-format',
        'text',
        ...(input.sessionId ? ['--resume', input.sessionId] : [])
      ]
    }
  }

  if (input.actor === 'codex') {
    return {
      command: input.command,
      args: ['--json', ...(input.sessionId ? ['resume', input.sessionId] : [])]
    }
  }

  throw new Error(`Unsupported actor: ${input.actor}`)
}
```

Do not spawn real actor CLIs in this task. Keep real process execution for Task 17.

**Step 4: Run tests**

Run:

```bash
pnpm test tests/unit/main/buddy-launchers.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/buddy/launchers.ts tests/unit/main/buddy-launchers.test.ts
git commit -m "feat: build native actor launcher commands"
```

## Task 17: Run Fake Actor Through Native Runner

**Files:**
- Modify: `src/main/buddy/launchers.ts`
- Modify: `src/main/buddy/runner.ts`
- Modify: `src/main/buddy/store.ts`
- Create: `tests/unit/main/buddy-runner-launcher.test.ts`

**Step 1: Write failing integration-style unit test**

Create `tests/unit/main/buddy-runner-launcher.test.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'
import { BuddyRunner } from '../../../src/main/buddy/runner'

describe('BuddyRunner with fake launcher', () => {
  it('records actor output and enters countdown after successful run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-launcher-'))
    const fake = join(root, 'fake-actor.js')
    await writeFile(fake, "process.stdout.write(JSON.stringify({type:'message',role:'assistant',content:[{type:'output_text',text:'done'}],thread_id:'t1'}) + '\\n')\n")

    const store = new BuddyStore(root)
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          codex: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    const runner = new BuddyRunner(store)

    await runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'codex'
    })

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    expect(detail.state.status).toBe('COUNTDOWN')
    expect(detail.state.codex_thread_id).toBe('t1')
    expect(detail.events.some((event) => event.type === 'actor.completed')).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-runner-launcher.test.ts
```

Expected: FAIL because runner only changes state and does not execute launchers.

**Step 3: Implement process execution**

Modify `src/main/buddy/launchers.ts`:

```ts
import { spawn } from 'node:child_process'
import { once } from 'node:events'

export async function runLauncher(input: {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  stdinText?: string
  timeoutMs: number
  onStdout(line: string): void
  onStderr(line: string): void
}): Promise<{ exitCode: number | null }> {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: input.command.includes(' ')
  })

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) input.onStdout(line)
  })
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) input.onStderr(line)
  })

  if (input.stdinText) child.stdin.end(input.stdinText)
  else child.stdin.end()

  const timeout = setTimeout(() => child.kill('SIGTERM'), input.timeoutMs)
  const [exitCode] = await once(child, 'exit') as [number | null]
  clearTimeout(timeout)
  return { exitCode }
}
```

Modify `BuddyRunner.startTask` to:

- set running state
- read launcher settings from task settings
- write prompt artifact
- call `runLauncher`
- parse stdout lines
- append `actor.stream` events
- on exit code `0`, set state to `COUNTDOWN`
- on non-zero, set state to `FAILED`

Keep this task minimal with fake Codex JSON only. Generalize after the test passes.

**Step 4: Run tests**

Run:

```bash
pnpm test tests/unit/main/buddy-runner-launcher.test.ts tests/unit/main/buddy-runner.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/buddy/launchers.ts src/main/buddy/runner.ts src/main/buddy/store.ts tests/unit/main/buddy-runner-launcher.test.ts
git commit -m "feat: execute native actor launcher"
```

## Task 18: Add Prompt Generation

**Files:**
- Create: `src/main/buddy/prompts.ts`
- Modify: `src/main/buddy/runner.ts`
- Create: `tests/unit/main/buddy-prompts.test.ts`

**Step 1: Write failing test**

Create `tests/unit/main/buddy-prompts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildActorPrompt } from '../../../src/main/buddy/prompts'

describe('buildActorPrompt', () => {
  it('includes task, context, actor, round, and repo root', () => {
    const prompt = buildActorPrompt({
      actor: 'claude',
      round: 1,
      repoRoot: '/tmp/repo',
      taskText: 'Build feature',
      contextText: 'Use tests',
      transcript: []
    })

    expect(prompt).toContain('claude')
    expect(prompt).toContain('/tmp/repo')
    expect(prompt).toContain('Build feature')
    expect(prompt).toContain('Use tests')
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-prompts.test.ts
```

Expected: FAIL because `prompts.ts` does not exist.

**Step 3: Implement prompt builder**

Create `src/main/buddy/prompts.ts`:

```ts
import type { TranscriptEntry } from '../../shared/types'

export interface BuildActorPromptInput {
  actor: string
  round: number
  repoRoot: string
  taskText: string
  contextText: string
  transcript: TranscriptEntry[]
}

export function buildActorPrompt(input: BuildActorPromptInput): string {
  return [
    `You are ${input.actor} in a Buddy engineering loop.`,
    `Round: ${input.round}`,
    `Repository: ${input.repoRoot}`,
    '',
    'Task:',
    input.taskText || '(empty)',
    '',
    'Context:',
    input.contextText || '(empty)',
    '',
    'Previous transcript:',
    input.transcript.map((entry) => `${entry.role}: ${entry.content}`).join('\n') || '(none)',
    '',
    'Respond using the Buddy Message Protocol.'
  ].join('\n')
}
```

Modify runner to call `buildActorPrompt` and write the prompt artifact before spawning.

**Step 4: Run tests**

Run:

```bash
pnpm test tests/unit/main/buddy-prompts.test.ts tests/unit/main/buddy-runner-launcher.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/buddy/prompts.ts src/main/buddy/runner.ts tests/unit/main/buddy-prompts.test.ts
git commit -m "feat: generate native actor prompts"
```

## Task 19: Add Redaction Before Persistent Events

**Files:**
- Create: `src/main/buddy/redact.ts`
- Modify: `src/main/buddy/store.ts`
- Create: `tests/unit/main/buddy-redact.test.ts`

**Step 1: Write failing tests**

Create `tests/unit/main/buddy-redact.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { redactSensitiveText } from '../../../src/main/buddy/redact'

describe('redactSensitiveText', () => {
  it('redacts common API keys', () => {
    expect(redactSensitiveText('token sk-abcdefghijklmnopqrstuvwxyz1234567890')).toContain('[REDACTED]')
    expect(redactSensitiveText('token sk-ant-abcdefghijklmnopqrstuvwxyz1234567890')).toContain('[REDACTED]')
    expect(redactSensitiveText('aws AKIAABCDEFGHIJKLMNOP')).toContain('[REDACTED]')
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-redact.test.ts
```

Expected: FAIL because `redact.ts` does not exist.

**Step 3: Implement redaction**

Create `src/main/buddy/redact.ts`:

```ts
const PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g
]

export function redactSensitiveText(input: string): string {
  return PATTERNS.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), input)
}

export function redactJsonValue<T>(value: T): T {
  return JSON.parse(redactSensitiveText(JSON.stringify(value))) as T
}
```

Modify `appendTaskEvent` in `src/main/buddy/store.ts` to apply `redactJsonValue` before writing JSONL.

**Step 4: Run tests**

Run:

```bash
pnpm test tests/unit/main/buddy-redact.test.ts tests/unit/main/buddy-runner-launcher.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/buddy/redact.ts src/main/buddy/store.ts tests/unit/main/buddy-redact.test.ts
git commit -m "feat: redact native buddy events"
```

## Task 20: Add Run Locks

**Files:**
- Create: `src/main/buddy/locks.ts`
- Modify: `src/main/buddy/runner.ts`
- Create: `tests/unit/main/buddy-locks.test.ts`

**Step 1: Write failing tests**

Create `tests/unit/main/buddy-locks.test.ts`:

```ts
import { mkdtemp, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createRunLock, removeRunLock } from '../../../src/main/buddy/locks'

describe('run locks', () => {
  it('creates and removes run lock files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-locks-'))
    const lockPath = await createRunLock(root, {
      workspace_key: 'abc123def456',
      task_id: 'demo',
      run_id: 'run_1',
      pid: 123
    })

    await expect(readFile(lockPath, 'utf8')).resolves.toContain('"app":"buddy"')

    await removeRunLock(lockPath)
    await expect(access(lockPath)).rejects.toThrow()
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-locks.test.ts
```

Expected: FAIL because `locks.ts` does not exist.

**Step 3: Implement locks**

Create `src/main/buddy/locks.ts`:

```ts
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function createRunLock(dataRoot: string, input: {
  workspace_key: string
  task_id: string
  run_id: string
  pid: number
}): Promise<string> {
  const dir = join(dataRoot, 'runtime', 'tasks')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${input.workspace_key}__${input.task_id}.lock`)
  await writeFile(path, JSON.stringify({
    ...input,
    app: 'buddy',
    started_at: new Date().toISOString()
  }))
  return path
}

export async function removeRunLock(path: string): Promise<void> {
  await rm(path, { force: true })
}
```

Wire lock creation/removal in `BuddyRunner` around actor launcher execution.

**Step 4: Run tests**

Run:

```bash
pnpm test tests/unit/main/buddy-locks.test.ts tests/unit/main/buddy-runner-launcher.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/buddy/locks.ts src/main/buddy/runner.ts tests/unit/main/buddy-locks.test.ts
git commit -m "feat: add native actor run locks"
```

## Task 21: Add Interrupt And Failure Handling

**Files:**
- Modify: `src/main/buddy/runner.ts`
- Modify: `src/main/buddy/service.ts`
- Create: `tests/unit/main/buddy-failure.test.ts`

**Step 1: Write failing tests**

Create `tests/unit/main/buddy-failure.test.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'
import { BuddyRunner } from '../../../src/main/buddy/runner'

describe('BuddyRunner failure handling', () => {
  it('marks task failed when actor exits non-zero', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-failure-'))
    const fake = join(root, 'fake-fail.js')
    await writeFile(fake, "process.stderr.write('boom\\n'); process.exit(2)\n")

    const store = new BuddyStore(root)
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          codex: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    const runner = new BuddyRunner(store)

    await expect(runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'codex'
    })).rejects.toThrow()

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    expect(detail.state.status).toBe('FAILED')
    expect(detail.latest_failure?.message).toContain('boom')
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-failure.test.ts
```

Expected: FAIL because non-zero exits are not recorded correctly.

**Step 3: Implement failure state**

Modify `src/main/buddy/runner.ts`:

- collect stderr lines during launcher execution
- on non-zero exit:
  - set state `FAILED`
  - clear `active_run`
  - write `latest_failure`
  - append `actor.failed`
  - throw a structured error
- implement `interrupt(taskId, workspaceKey)`:
  - kill active child if tracked
  - mark state `PAUSED`
  - clear `active_run`
  - append `actor.interrupted`

Modify state schema if `latest_failure` is not accepted.

**Step 4: Wire service**

Modify `src/main/buddy/service.ts`:

```ts
interrupt(taskId: string, workspaceKey?: string): Promise<void> {
  if (!workspaceKey) throw new Error('workspaceKey is required')
  return this.runner.interrupt(taskId, workspaceKey)
}
```

**Step 5: Run tests**

Run:

```bash
pnpm test tests/unit/main/buddy-failure.test.ts tests/unit/main/buddy-runner-launcher.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/main/buddy/runner.ts src/main/buddy/service.ts src/main/buddy/schemas.ts tests/unit/main/buddy-failure.test.ts
git commit -m "feat: handle native actor failures"
```

## Task 22: Add Break Detection And DONE Transition

**Files:**
- Modify: `src/main/buddy/parsers.ts`
- Modify: `src/main/buddy/runner.ts`
- Create: `tests/unit/main/buddy-break.test.ts`

**Step 1: Write failing tests**

Create `tests/unit/main/buddy-break.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseBuddyMessage } from '../../../src/main/buddy/parsers'

describe('Buddy protocol break parsing', () => {
  it('detects break messages', () => {
    expect(parseBuddyMessage('type=break\nreason=done')).toMatchObject({
      kind: 'break',
      reason: 'done'
    })
  })

  it('treats normal text as message', () => {
    expect(parseBuddyMessage('keep going')).toMatchObject({
      kind: 'message',
      text: 'keep going'
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-break.test.ts
```

Expected: FAIL because `parseBuddyMessage` does not exist.

**Step 3: Implement protocol parsing**

Modify `src/main/buddy/parsers.ts`:

```ts
export type BuddyMessage =
  | { kind: 'break'; reason?: string }
  | { kind: 'message'; text: string }

export function parseBuddyMessage(text: string): BuddyMessage {
  const lines = text.trim().split(/\r?\n/)
  const fields = new Map(lines.map((line) => {
    const index = line.indexOf('=')
    return index === -1 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)]
  }))

  if (fields.get('type') === 'break') {
    return { kind: 'break', reason: fields.get('reason') }
  }

  return { kind: 'message', text }
}
```

Modify runner completion:

- if current actor returns break and `pending_break` is empty, set `pending_break` and enter `COUNTDOWN`
- if current actor returns break and `pending_break.actor` is a different actor in the same round, set `DONE`
- otherwise continue to countdown

**Step 4: Run tests**

Run:

```bash
pnpm test tests/unit/main/buddy-break.test.ts tests/unit/main/buddy-runner-launcher.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/buddy/parsers.ts src/main/buddy/runner.ts tests/unit/main/buddy-break.test.ts
git commit -m "feat: support buddy break completion"
```

## Task 23: Add Restart Recovery

**Files:**
- Modify: `src/main/buddy/service.ts`
- Modify: `src/main/buddy/store.ts`
- Create: `tests/unit/main/buddy-recovery.test.ts`

**Step 1: Write failing test**

Create `tests/unit/main/buddy-recovery.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'
import { BuddyCoreService } from '../../../src/main/buddy/service'

describe('BuddyCoreService recovery', () => {
  it('marks active runs interrupted on startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-recovery-'))
    const store = new BuddyStore(root)
    const created = await store.createTask({ task_id: 'demo', repo_root: '/tmp/repo' })
    await store.updateTaskState('demo', created.workspace_key, (state) => ({
      ...state,
      status: 'RUNNING_CODEX',
      active_run: { actor: 'codex', started_at: '2026-05-26T00:00:00.000Z' }
    }))

    const service = new BuddyCoreService({ dataRoot: root })
    await service.recoverInterruptedRuns()

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    expect(detail.state.status).toBe('PAUSED')
    expect(detail.state.active_run).toBeNull()
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/buddy-recovery.test.ts
```

Expected: FAIL because `recoverInterruptedRuns` does not exist.

**Step 3: Implement recovery**

Modify `src/main/buddy/service.ts`:

```ts
async recoverInterruptedRuns(): Promise<void> {
  const tasks = await this.store.getTasks()
  for (const task of tasks) {
    if (task.status.startsWith('RUNNING_')) {
      await this.store.updateTaskState(task.task_id, task.workspace_key, (state) => ({
        ...state,
        status: 'PAUSED',
        active_run: null,
        updated_at: new Date().toISOString()
      }))
      await this.store.appendTaskEvent(task.task_id, task.workspace_key, {
        type: 'actor.interrupted',
        payload: { reason: 'app_restarted' }
      })
    }
  }
}
```

Call `await buddyService.recoverInterruptedRuns()` during `app.whenReady()` before `createWindow()`.

**Step 4: Run tests**

Run:

```bash
pnpm test tests/unit/main/buddy-recovery.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/buddy/service.ts src/main/index.ts tests/unit/main/buddy-recovery.test.ts
git commit -m "feat: recover native buddy runs on startup"
```

## Task 24: Delete Legacy HTTP Buddy Service

**Files:**
- Delete: `src/main/buddy-service.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `tests/unit/main/no-python-http.test.ts`

**Step 1: Write failing source test**

Create `tests/unit/main/no-python-http.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function readSources(dir: string): string {
  return readdirSync(dir).map((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return readSources(path)
    if (!path.endsWith('.ts') && !path.endsWith('.tsx')) return ''
    return readFileSync(path, 'utf8')
  }).join('\n')
}

describe('native runtime source', () => {
  it('does not start buddy-python or call local buddy HTTP', () => {
    const source = readSources(join(process.cwd(), 'src'))

    expect(source).not.toContain("spawn('buddy'")
    expect(source).not.toContain('buddy serve')
    expect(source).not.toContain('127.0.0.1:8765')
    expect(source).not.toContain('baseURL: \\'/api\\'')
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/main/no-python-http.test.ts
```

Expected: FAIL while `src/main/buddy-service.ts` and axios API code remain.

**Step 3: Delete legacy service and remove unused axios**

Delete:

```bash
rm src/main/buddy-service.ts
```

Use `apply_patch` for the delete if doing manual edits.

Remove axios if no source references remain:

```bash
pnpm remove axios
```

Confirm:

```bash
rg "axios|buddy serve|127\\.0\\.0\\.1:8765|file:///api|/api" src package.json
```

Expected: no legacy runtime references. Some unrelated URL strings may remain in markdown sanitizer; those are fine if unrelated to Buddy API.

**Step 4: Run tests**

Run:

```bash
pnpm test tests/unit/main/no-python-http.test.ts
pnpm typecheck
pnpm test
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/buddy-service.ts package.json pnpm-lock.yaml tests/unit/main/no-python-http.test.ts
git commit -m "feat: remove python http buddy runtime"
```

## Task 25: Add E2E Smoke With Native IPC

**Files:**
- Modify: `tests/e2e/app.test.ts`
- Create: `tests/e2e/native-buddy.test.ts`

**Step 1: Write e2e smoke test**

Create `tests/e2e/native-buddy.test.ts`:

```ts
import { test, expect } from '@playwright/test'

test('app boots with native buddy backend', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('text=buddy')).toBeVisible()
  await expect(page.locator('text=新建任务')).toBeVisible()
  await expect(page.locator('text=服务未连接')).not.toBeVisible()
})
```

Adjust the final assertion to match the actual current UI text after native health checks. The point is to verify the UI does not show a Python server connection failure.

**Step 2: Run e2e test**

Run:

```bash
pnpm test:e2e tests/e2e/native-buddy.test.ts
```

Expected: PASS.

**Step 3: Run full verification**

Run:

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

Expected: all pass.

**Step 4: Commit**

```bash
git add tests/e2e/app.test.ts tests/e2e/native-buddy.test.ts
git commit -m "test: add native buddy backend smoke"
```

## Final Verification

Run:

```bash
rg "buddy-python|buddy serve|127\\.0\\.0\\.1:8765|file:///api|baseURL: '/api'|axios" src package.json docs/REQUIREMENTS.md docs/plans
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

Expected:

- No runtime source references to buddy-python, `buddy serve`, `127.0.0.1:8765`, `file:///api`, or axios.
- Documentation may still mention buddy-python for history or compatibility, but product docs should say runtime is native.
- Typecheck passes.
- Unit tests pass.
- E2E tests pass.
- Build passes.

## Handoff

After this plan is complete, update `docs/REQUIREMENTS.md` and `package.json` description so product docs describe the native Buddy Core rather than an HTTP wrapper.
