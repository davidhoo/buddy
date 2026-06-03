# Buddy MVP 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 构建 macOS 原生桌面应用，包装 buddy-python HTTP API，提供三栏布局的任务管理界面

**Architecture:** Electron 主进程管理窗口和 buddy-python 服务连接，React 渲染进程提供原生 UI，通过 HTTP API 与 buddy-python 通信

**Tech Stack:** Electron 33, React 18, TypeScript 5, Tailwind CSS, TanStack Query, electron-vite

---

## Task 1: 项目初始化

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `electron.vite.config.ts`
- Create: `.gitignore`

**Step 1: 初始化 npm 项目**

```bash
npm init -y
```

**Step 2: 安装依赖**

```bash
npm install electron@33 react@18 react-dom@18
npm install -D typescript@5 @types/react@18 @types/react-dom@18
npm install -D electron-vite @electron-toolkit/preload
npm install tailwindcss@3 postcss autoprefixer
npm install @tanstack/react-query axios
npm install -D vitest @testing-library/react @testing-library/jest-dom
```

**Step 3: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: 创建 electron.vite.config.ts**

```typescript
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer')
      }
    },
    plugins: [react()]
  }
})
```

**Step 5: 创建 .gitignore**

```
node_modules
dist
out
.DS_Store
*.log
```

**Step 6: Commit**

```bash
git add package.json tsconfig.json electron.vite.config.ts .gitignore
git commit -m "chore: initialize project structure"
```

---

## Task 2: Electron 主进程基础

**Files:**
- Create: `src/main/index.ts`
- Create: `src/main/window-manager.ts`
- Create: `src/preload/index.ts`

**Step 1: 创建窗口管理器**

```typescript
// src/main/window-manager.ts
import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

export class WindowManager {
  private mainWindow: BrowserWindow | null = null

  createWindow(): BrowserWindow {
    this.mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1000,
      minHeight: 600,
      show: false,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })

    this.mainWindow.on('ready-to-show', () => {
      this.mainWindow?.show()
    })

    this.mainWindow.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      this.mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }

    return this.mainWindow
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }
}
```

**Step 2: 创建主入口**

```typescript
// src/main/index.ts
import { app, BrowserWindow } from 'electron'
import { WindowManager } from './window-manager'

const windowManager = new WindowManager()

app.whenReady().then(() => {
  windowManager.createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windowManager.createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
```

**Step 3: 创建 preload 脚本**

```typescript
// src/preload/index.ts
import { contextBridge } from 'electron'

const api = {
  // 后续添加 API
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
```

**Step 4: Commit**

```bash
git add src/main/index.ts src/main/window-manager.ts src/preload/index.ts
git commit -m "feat: add electron main process and window manager"
```

---

## Task 3: Buddy Service (HTTP 客户端)

**Files:**
- Create: `src/main/buddy-service.ts`
- Create: `src/shared/types.ts`

**Step 1: 定义类型**

```typescript
// src/shared/types.ts
export interface Task {
  task_id: string
  workspace_key: string
  status: TaskStatus
  updated_at: string
  repo_root: string
}

export type TaskStatus = 
  | 'READY'
  | 'RUNNING_CLAUDE'
  | 'RUNNING_CODEX'
  | 'RUNNING_OPENCODE'
  | 'RUNNING_KIMI'
  | 'COUNTDOWN'
  | 'PAUSED'
  | 'FAILED'
  | 'DONE'

export interface TaskDetail {
  task_id: string
  workspace_key: string
  state: TaskState
  settings: TaskSettings
  task_text: string
  context_text: string
  transcript: TranscriptEntry[]
  events: Event[]
  latest_failure: Failure | null
}

export interface TaskState {
  status: TaskStatus
  round: number
  next_actor: string
  countdown?: Countdown
  active_run?: ActiveRun
  claude_session_id?: string
  codex_thread_id?: string
}

export interface Countdown {
  status: 'running' | 'paused' | 'elapsed' | 'skipped'
  remaining: number
  default_next_actor: string
}

export interface ActiveRun {
  actor: string
  started_at: string
}

export interface TaskSettings {
  protocol_version: string
  countdown_seconds: number
  flow_policy: string
  role_mode: string
  launchers: Record<string, Launcher>
}

export interface Launcher {
  command: string
  env: Record<string, string>
  timeout_seconds: number
}

export interface TranscriptEntry {
  role: 'human' | 'claude' | 'codex' | 'opencode' | 'kimi' | 'system'
  content: string
  ts: string
  round?: number
  meta?: Record<string, unknown>
}

export interface Event {
  seq: number
  type: string
  actor?: string
  ts: string
  payload: Record<string, unknown>
}

export interface Failure {
  message: string
  actor?: string
  ts?: string
}

export interface HealthResponse {
  app: string
  version: string
  pid: number
  host: string
  port: number
}

export interface BootstrapResponse {
  version: string
  repo_root: string
  data_root: string
  workspace_key: string
  tasks: Task[]
}
```

**Step 2: 创建 Buddy Service**

```typescript
// src/main/buddy-service.ts
import axios, { AxiosInstance } from 'axios'
import { spawn, ChildProcess } from 'child_process'
import { 
  Task, TaskDetail, HealthResponse, BootstrapResponse 
} from '../shared/types'

export class BuddyService {
  private client: AxiosInstance
  private baseUrl: string
  private process: ChildProcess | null = null
  private isRunning = false

  constructor(host = '127.0.0.1', port = 8765) {
    this.baseUrl = `http://${host}:${port}`
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000
    })
  }

  async checkHealth(): Promise<HealthResponse | null> {
    try {
      const response = await this.client.get<HealthResponse>('/api/health')
      return response.data
    } catch {
      return null
    }
  }

  async start(): Promise<boolean> {
    // 检查是否已有服务运行
    const health = await this.checkHealth()
    if (health) {
      this.isRunning = true
      return true
    }

    // 启动新服务
    try {
      this.process = spawn('buddy', ['serve', '--foreground'], {
        detached: true,
        stdio: 'ignore'
      })
      this.process.unref()

      // 等待服务启动
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        const health = await this.checkHealth()
        if (health) {
          this.isRunning = true
          return true
        }
      }
    } catch (error) {
      console.error('Failed to start buddy service:', error)
    }

    return false
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill()
      this.process = null
    }
    this.isRunning = false
  }

  async bootstrap(): Promise<BootstrapResponse> {
    const response = await this.client.get<BootstrapResponse>('/api/bootstrap')
    return response.data
  }

  async getTasks(): Promise<Task[]> {
    const response = await this.client.get<{ tasks: Task[] }>('/api/tasks')
    return response.data.tasks
  }

  async getTaskDetail(taskId: string, workspaceKey?: string): Promise<TaskDetail> {
    const params = workspaceKey ? { workspace: workspaceKey } : {}
    const response = await this.client.get<TaskDetail>(
      `/api/tasks/${encodeURIComponent(taskId)}`,
      { params }
    )
    return response.data
  }

  async createTask(data: {
    task_id: string
    repo_root?: string
    task_text?: string
    context_text?: string
    settings?: Record<string, unknown>
  }): Promise<{ task: string; path: string; workspace_key: string }> {
    const response = await this.client.post('/api/tasks', data)
    return response.data
  }

  async deleteTask(taskId: string, workspaceKey?: string): Promise<void> {
    const params = workspaceKey ? { workspace: workspaceKey } : {}
    await this.client.delete(`/api/tasks/${encodeURIComponent(taskId)}`, { params })
  }

  async startTask(taskId: string, data: {
    actor?: string
    message?: string
    workspace_key?: string
  }): Promise<void> {
    await this.client.post(
      `/api/tasks/${encodeURIComponent(taskId)}/start`,
      data
    )
  }

  async sendMessage(taskId: string, data: {
    actor?: string
    message?: string
    workspace_key?: string
  }): Promise<void> {
    await this.client.post(
      `/api/tasks/${encodeURIComponent(taskId)}/message`,
      data
    )
  }

  async skipCountdown(taskId: string, data: {
    next_actor?: string
    workspace_key?: string
  }): Promise<void> {
    await this.client.post(
      `/api/tasks/${encodeURIComponent(taskId)}/skip-countdown`,
      data
    )
  }

  async pauseCountdown(taskId: string, data: {
    next_actor?: string
    workspace_key?: string
  }): Promise<void> {
    await this.client.post(
      `/api/tasks/${encodeURIComponent(taskId)}/pause-countdown`,
      data
    )
  }

  async interrupt(taskId: string, workspaceKey?: string): Promise<void> {
    const params = workspaceKey ? { workspace: workspaceKey } : {}
    await this.client.post(
      `/api/tasks/${encodeURIComponent(taskId)}/interrupt`,
      {},
      { params }
    )
  }

  async getEvents(taskId: string, since: number, workspaceKey?: string): Promise<{
    events: { seq: number; type: string; actor?: string; ts: string; payload: Record<string, unknown> }[]
  }> {
    const params: Record<string, string | number> = {
      task: taskId,
      since
    }
    if (workspaceKey) {
      params.workspace = workspaceKey
    }
    const response = await this.client.get('/api/events', { params })
    return response.data
  }

  isConnected(): boolean {
    return this.isRunning
  }
}
```

**Step 3: Commit**

```bash
git add src/shared/types.ts src/main/buddy-service.ts
git commit -m "feat: add buddy service HTTP client"
```

---

## Task 4: React 基础结构

**Files:**
- Create: `src/renderer/index.html`
- Create: `src/renderer/main.tsx`
- Create: `src/renderer/App.tsx`
- Create: `tailwind.config.js`
- Create: `postcss.config.js`
- Create: `src/renderer/styles/globals.css`

**Step 1: 创建 index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>buddy</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

**Step 2: 创建 main.tsx**

```typescript
// src/renderer/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import './styles/globals.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 3,
      staleTime: 1000
    }
  }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
)
```

**Step 3: 创建 tailwind.config.js**

```javascript
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#f2f0eb',
        'canvas-2': '#edebe9',
        'house-green': '#1e3932',
        'brand-green': '#006241',
        'accent-green': '#00754a',
        gold: '#cba258',
        danger: '#c82014',
        card: '#ffffff',
        panel: '#fbfaf7'
      }
    }
  },
  plugins: []
}
```

**Step 4: 创建 postcss.config.js**

```javascript
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {}
  }
}
```

**Step 5: 创建 globals.css**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --canvas: #f2f0eb;
  --house-green: #1e3932;
  --brand-green: #006241;
  --gold: #cba258;
  --danger: #c82014;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--canvas);
  color: rgba(0, 0, 0, 0.87);
}

#root {
  height: 100vh;
  overflow: hidden;
}
```

**Step 6: 创建 App.tsx 占位**

```typescript
// src/renderer/App.tsx
export default function App() {
  return (
    <div className="h-screen flex items-center justify-center">
      <h1 className="text-2xl font-bold">buddy</h1>
    </div>
  )
}
```

**Step 7: Commit**

```bash
git add src/renderer/index.html src/renderer/main.tsx src/renderer/App.tsx
git add tailwind.config.js postcss.config.js src/renderer/styles/globals.css
git commit -m "feat: add React base structure with Tailwind CSS"
```

---

## Task 5: API 客户端和 Hooks

**Files:**
- Create: `src/renderer/lib/api.ts`
- Create: `src/renderer/hooks/useBuddy.ts`
- Create: `src/renderer/hooks/useTasks.ts`

**Step 1: 创建 API 客户端**

```typescript
// src/renderer/lib/api.ts
import axios from 'axios'
import { 
  Task, TaskDetail, BootstrapResponse, Event 
} from '../../shared/types'

const client = axios.create({
  baseURL: 'http://127.0.0.1:8765',
  timeout: 10000
})

export const api = {
  async bootstrap(): Promise<BootstrapResponse> {
    const response = await client.get('/api/bootstrap')
    return response.data
  },

  async getTasks(): Promise<Task[]> {
    const response = await client.get('/api/tasks')
    return response.data.tasks
  },

  async getTaskDetail(taskId: string, workspaceKey?: string): Promise<TaskDetail> {
    const params = workspaceKey ? { workspace: workspaceKey } : {}
    const response = await client.get(`/api/tasks/${encodeURIComponent(taskId)}`, { params })
    return response.data
  },

  async createTask(data: {
    task_id: string
    repo_root?: string
    task_text?: string
    context_text?: string
    settings?: Record<string, unknown>
  }): Promise<{ task: string; path: string; workspace_key: string }> {
    const response = await client.post('/api/tasks', data)
    return response.data
  },

  async deleteTask(taskId: string, workspaceKey?: string): Promise<void> {
    const params = workspaceKey ? { workspace: workspaceKey } : {}
    await client.delete(`/api/tasks/${encodeURIComponent(taskId)}`, { params })
  },

  async startTask(taskId: string, data: {
    actor?: string
    message?: string
    workspace_key?: string
  }): Promise<void> {
    await client.post(`/api/tasks/${encodeURIComponent(taskId)}/start`, data)
  },

  async sendMessage(taskId: string, data: {
    actor?: string
    message?: string
    workspace_key?: string
  }): Promise<void> {
    await client.post(`/api/tasks/${encodeURIComponent(taskId)}/message`, data)
  },

  async skipCountdown(taskId: string, data: {
    next_actor?: string
    workspace_key?: string
  }): Promise<void> {
    await client.post(`/api/tasks/${encodeURIComponent(taskId)}/skip-countdown`, data)
  },

  async pauseCountdown(taskId: string, data: {
    next_actor?: string
    workspace_key?: string
  }): Promise<void> {
    await client.post(`/api/tasks/${encodeURIComponent(taskId)}/pause-countdown`, data)
  },

  async interrupt(taskId: string, workspaceKey?: string): Promise<void> {
    const params = workspaceKey ? { workspace: workspaceKey } : {}
    await client.post(`/api/tasks/${encodeURIComponent(taskId)}/interrupt`, {}, { params })
  },

  async getEvents(taskId: string, since: number, workspaceKey?: string): Promise<{
    events: Event[]
  }> {
    const params: Record<string, string | number> = { task: taskId, since }
    if (workspaceKey) params.workspace = workspaceKey
    const response = await client.get('/api/events', { params })
    return response.data
  }
}
```

**Step 2: 创建 useBuddy hook**

```typescript
// src/renderer/hooks/useBuddy.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'

export function useBootstrap() {
  return useQuery({
    queryKey: ['bootstrap'],
    queryFn: api.bootstrap,
    retry: 3
  })
}

export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: api.getTasks,
    refetchInterval: 5000
  })
}

export function useTaskDetail(taskId: string | null, workspaceKey?: string) {
  return useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.getTaskDetail(taskId!, workspaceKey),
    enabled: !!taskId,
    refetchInterval: 1500
  })
}

export function useEvents(taskId: string | null, since: number, workspaceKey?: string) {
  return useQuery({
    queryKey: ['events', taskId, since],
    queryFn: () => api.getEvents(taskId!, since, workspaceKey),
    enabled: !!taskId,
    refetchInterval: 1500
  })
}

export function useCreateTask() {
  const queryClient = useQueryClient()
  
  return useMutation({
    mutationFn: api.createTask,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    }
  })
}

export function useDeleteTask() {
  const queryClient = useQueryClient()
  
  return useMutation({
    mutationFn: ({ taskId, workspaceKey }: { taskId: string; workspaceKey?: string }) =>
      api.deleteTask(taskId, workspaceKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    }
  })
}

export function useStartTask() {
  const queryClient = useQueryClient()
  
  return useMutation({
    mutationFn: ({ taskId, data }: { taskId: string; data: { actor?: string; message?: string; workspace_key?: string } }) =>
      api.startTask(taskId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task'] })
    }
  })
}

export function useSendMessage() {
  const queryClient = useQueryClient()
  
  return useMutation({
    mutationFn: ({ taskId, data }: { taskId: string; data: { actor?: string; message?: string; workspace_key?: string } }) =>
      api.sendMessage(taskId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task'] })
    }
  })
}

export function useSkipCountdown() {
  const queryClient = useQueryClient()
  
  return useMutation({
    mutationFn: ({ taskId, data }: { taskId: string; data: { next_actor?: string; workspace_key?: string } }) =>
      api.skipCountdown(taskId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task'] })
    }
  })
}

export function usePauseCountdown() {
  const queryClient = useQueryClient()
  
  return useMutation({
    mutationFn: ({ taskId, data }: { taskId: string; data: { next_actor?: string; workspace_key?: string } }) =>
      api.pauseCountdown(taskId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task'] })
    }
  })
}

export function useInterrupt() {
  const queryClient = useQueryClient()
  
  return useMutation({
    mutationFn: ({ taskId, workspaceKey }: { taskId: string; workspaceKey?: string }) =>
      api.interrupt(taskId, workspaceKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task'] })
    }
  })
}
```

**Step 3: Commit**

```bash
git add src/renderer/lib/api.ts src/renderer/hooks/useBuddy.ts src/renderer/hooks/useTasks.ts
git commit -m "feat: add API client and React hooks"
```

---

## Task 6: 标题栏组件

**Files:**
- Create: `src/renderer/components/TitleBar.tsx`

**Step 1: 创建 TitleBar 组件**

```typescript
// src/renderer/components/TitleBar.tsx
interface TitleBarProps {
  taskName: string
  isSidebarOpen: boolean
  isStatusBarOpen: boolean
  onToggleSidebar: () => void
  onToggleStatusBar: () => void
}

export function TitleBar({
  taskName,
  isSidebarOpen,
  isStatusBarOpen,
  onToggleSidebar,
  onToggleStatusBar
}: TitleBarProps) {
  return (
    <div className="h-13 flex items-center px-4 bg-house-green text-white drag-region">
      {/* 红绿灯占位 */}
      <div className="w-[68px] flex-shrink-0" />
      
      {/* 左侧栏切换按钮 */}
      <button
        onClick={onToggleSidebar}
        className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 no-drag"
        title={isSidebarOpen ? '收起侧边栏' : '展开侧边栏'}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
      
      {/* 任务名 */}
      <div className="flex-1 text-center text-sm font-medium truncate px-4">
        {taskName || 'buddy'}
      </div>
      
      {/* 右侧栏切换按钮 */}
      <button
        onClick={onToggleStatusBar}
        className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 no-drag"
        title={isStatusBarOpen ? '收起状态栏' : '展开状态栏'}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <line x1="15" y1="3" x2="15" y2="21" />
        </svg>
      </button>
      
      {/* 窗口控制占位 */}
      <div className="w-[68px] flex-shrink-0" />
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add src/renderer/components/TitleBar.tsx
git commit -m "feat: add title bar component"
```

---

## Task 7: 侧边栏组件

**Files:**
- Create: `src/renderer/components/Sidebar.tsx`

**Step 1: 创建 Sidebar 组件**

```typescript
// src/renderer/components/Sidebar.tsx
import { Task } from '../../shared/types'

interface SidebarProps {
  isOpen: boolean
  tasks: Task[]
  selectedTaskId: string | null
  onSelectTask: (taskId: string, workspaceKey: string) => void
  onCreateTask: () => void
  onOpenSettings: () => void
}

export function Sidebar({
  isOpen,
  tasks,
  selectedTaskId,
  onSelectTask,
  onCreateTask,
  onOpenSettings
}: SidebarProps) {
  if (!isOpen) return null

  // 按 workspace 分组
  const groupedTasks = tasks.reduce<Record<string, Task[]>>((acc, task) => {
    const key = task.workspace_key || 'default'
    if (!acc[key]) acc[key] = []
    acc[key].push(task)
    return acc
  }, {})

  return (
    <div className="w-60 bg-house-green text-white flex flex-col h-full">
      {/* 应用标题 */}
      <div className="px-4 pt-4 pb-2">
        <div className="text-xl font-bold">buddy</div>
        <div className="text-xs text-white/70">Coding Agent 协作台</div>
      </div>
      
      {/* 新建任务按钮 */}
      <div className="px-4 py-2">
        <button
          onClick={onCreateTask}
          className="w-full px-4 py-2 bg-accent-green text-white rounded-lg hover:bg-brand-green transition-colors"
        >
          新建任务
        </button>
      </div>
      
      {/* 任务列表 */}
      <div className="flex-1 overflow-y-auto px-2">
        {Object.entries(groupedTasks).map(([workspaceKey, workspaceTasks]) => (
          <div key={workspaceKey} className="mb-4">
            <div className="px-2 py-1 text-xs text-white/50 font-medium">
              {workspaceKey}
            </div>
            {workspaceTasks.map((task) => (
              <button
                key={task.task_id}
                onClick={() => onSelectTask(task.task_id, task.workspace_key)}
                className={`w-full text-left px-3 py-2 rounded-lg mb-1 transition-colors ${
                  selectedTaskId === task.task_id
                    ? 'bg-white/20'
                    : 'hover:bg-white/10'
                }`}
              >
                <div className="text-sm font-medium truncate">{task.task_id}</div>
                <div className="text-xs text-white/50">
                  {formatStatus(task.status)}
                </div>
              </button>
            ))}
          </div>
        ))}
      </div>
      
      {/* 设置按钮 */}
      <div className="p-4 border-t border-white/10">
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white/70 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          设置
        </button>
      </div>
    </div>
  )
}

function formatStatus(status: string): string {
  const statusMap: Record<string, string> = {
    READY: '就绪',
    RUNNING_CLAUDE: 'Claude 运行中',
    RUNNING_CODEX: 'Codex 运行中',
    RUNNING_OPENCODE: 'OpenCode 运行中',
    RUNNING_KIMI: 'Kimi 运行中',
    COUNTDOWN: '倒计时中',
    PAUSED: '已暂停',
    FAILED: '失败',
    DONE: '已完成'
  }
  return statusMap[status] || status
}
```

**Step 2: Commit**

```bash
git add src/renderer/components/Sidebar.tsx
git commit -m "feat: add sidebar component"
```

---

## Task 8: 状态栏组件

**Files:**
- Create: `src/renderer/components/StatusBar.tsx`

**Step 1: 创建 StatusBar 组件**

```typescript
// src/renderer/components/StatusBar.tsx
import { TaskState, TaskSettings } from '../../shared/types'

interface StatusBarProps {
  isOpen: boolean
  taskState: TaskState | null
  taskSettings: TaskSettings | null
  onSkipCountdown: () => void
  onPauseCountdown: () => void
  onInterrupt: () => void
}

export function StatusBar({
  isOpen,
  taskState,
  taskSettings,
  onSkipCountdown,
  onPauseCountdown,
  onInterrupt
}: StatusBarProps) {
  if (!isOpen) return null

  const isRunning = taskState?.status?.startsWith('RUNNING_')
  const isCountdown = taskState?.status === 'COUNTDOWN'
  const countdown = taskState?.countdown

  return (
    <div className="w-70 bg-white border-l border-gray-200 flex flex-col h-full">
      {/* Actor 状态 */}
      <div className="p-4 border-b border-gray-200">
        <div className="text-sm font-medium text-gray-500 mb-3">运行状态</div>
        
        {/* Claude 状态 */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm">Claude</span>
          <span className={`text-xs px-2 py-1 rounded ${
            taskState?.status === 'RUNNING_CLAUDE' 
              ? 'bg-green-100 text-green-800' 
              : 'bg-gray-100 text-gray-600'
          }`}>
            {taskState?.status === 'RUNNING_CLAUDE' ? '运行中' : '空闲'}
          </span>
        </div>
        
        {/* Codex 状态 */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm">Codex</span>
          <span className={`text-xs px-2 py-1 rounded ${
            taskState?.status === 'RUNNING_CODEX' 
              ? 'bg-green-100 text-green-800' 
              : 'bg-gray-100 text-gray-600'
          }`}>
            {taskState?.status === 'RUNNING_CODEX' ? '运行中' : '空闲'}
          </span>
        </div>
        
        {/* 轮次信息 */}
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
          <span className="text-sm text-gray-500">轮次</span>
          <span className="text-sm font-medium">{taskState?.round || 0}</span>
        </div>
      </div>
      
      {/* 倒计时 */}
      {isCountdown && countdown && (
        <div className="p-4 border-b border-gray-200">
          <div className="text-sm font-medium text-gray-500 mb-2">倒计时</div>
          <div className="text-2xl font-bold text-center mb-3">
            {Math.ceil(countdown.remaining)}秒
          </div>
          <div className="flex gap-2">
            <button
              onClick={onSkipCountdown}
              className="flex-1 px-3 py-2 bg-accent-green text-white text-sm rounded hover:bg-brand-green transition-colors"
            >
              跳过
            </button>
            <button
              onClick={onPauseCountdown}
              className="flex-1 px-3 py-2 bg-gray-200 text-gray-700 text-sm rounded hover:bg-gray-300 transition-colors"
            >
              暂停
            </button>
          </div>
        </div>
      )}
      
      {/* 运行中操作 */}
      {isRunning && (
        <div className="p-4 border-b border-gray-200">
          <button
            onClick={onInterrupt}
            className="w-full px-3 py-2 bg-danger text-white text-sm rounded hover:bg-red-700 transition-colors"
          >
            打断运行
          </button>
        </div>
      )}
      
      {/* 任务设置 */}
      {taskSettings && (
        <div className="p-4 border-b border-gray-200">
          <div className="text-sm font-medium text-gray-500 mb-2">任务设置</div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-xs text-gray-500">倒计时</span>
              <span className="text-xs">{taskSettings.countdown_seconds}秒</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-gray-500">执行方</span>
              <span className="text-xs">{taskSettings.role_mode === 'claude_implements' ? 'Claude' : 'Codex'}</span>
            </div>
          </div>
        </div>
      )}
      
      {/* 会话信息 */}
      <div className="p-4 flex-1">
        <div className="text-sm font-medium text-gray-500 mb-2">会话信息</div>
        {taskState?.claude_session_id && (
          <div className="mb-2">
            <span className="text-xs text-gray-500">Claude: </span>
            <span className="text-xs font-mono">{taskState.claude_session_id.slice(0, 8)}...</span>
          </div>
        )}
        {taskState?.codex_thread_id && (
          <div>
            <span className="text-xs text-gray-500">Codex: </span>
            <span className="text-xs font-mono">{taskState.codex_thread_id.slice(0, 8)}...</span>
          </div>
        )}
      </div>
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add src/renderer/components/StatusBar.tsx
git commit -m "feat: add status bar component"
```

---

## Task 9: 对话区域组件

**Files:**
- Create: `src/renderer/components/ChatArea.tsx`
- Create: `src/renderer/components/MessageBubble.tsx`
- Create: `src/renderer/components/Composer.tsx`

**Step 1: 创建 MessageBubble 组件**

```typescript
// src/renderer/components/MessageBubble.tsx
import { TranscriptEntry } from '../../shared/types'

interface MessageBubbleProps {
  entry: TranscriptEntry
}

export function MessageBubble({ entry }: MessageBubbleProps) {
  const isUser = entry.role === 'human'
  const isSystem = entry.role === 'system'
  
  if (isSystem) {
    return (
      <div className="flex justify-center my-2">
        <div className="text-xs text-gray-400 bg-gray-100 px-3 py-1 rounded-full">
          {entry.content}
        </div>
      </div>
    )
  }
  
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div className={`max-w-[80%] ${isUser ? 'order-2' : ''}`}>
        {/* 发送者 */}
        <div className={`text-xs text-gray-500 mb-1 ${isUser ? 'text-right' : ''}`}>
          {formatRole(entry.role)}
          {entry.ts && (
            <span className="ml-2">
              {new Date(entry.ts).toLocaleTimeString('zh-CN', { 
                hour: '2-digit', 
                minute: '2-digit' 
              })}
            </span>
          )}
        </div>
        
        {/* 消息内容 */}
        <div className={`px-4 py-3 rounded-2xl ${
          isUser 
            ? 'bg-accent-green text-white rounded-br-md' 
            : 'bg-white border border-gray-200 rounded-bl-md'
        }`}>
          <div className="text-sm whitespace-pre-wrap">{entry.content}</div>
        </div>
      </div>
    </div>
  )
}

function formatRole(role: string): string {
  const roleMap: Record<string, string> = {
    human: '你',
    claude: 'Claude',
    codex: 'Codex',
    opencode: 'OpenCode',
    kimi: 'Kimi'
  }
  return roleMap[role] || role
}
```

**Step 2: 创建 Composer 组件**

```typescript
// src/renderer/components/Composer.tsx
import { useState, useRef, useEffect } from 'react'

interface ComposerProps {
  onSend: (message: string) => void
  onStart: () => void
  isRunning: boolean
  isReady: boolean
}

export function Composer({ onSend, onStart, isRunning, isReady }: ComposerProps) {
  const [message, setMessage] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
    }
  }, [message])
  
  const handleSend = () => {
    if (message.trim()) {
      onSend(message.trim())
      setMessage('')
    }
  }
  
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }
  
  return (
    <div className="border-t border-gray-200 bg-white p-4">
      <div className="flex gap-3">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe a task..."
          className="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-3 text-sm focus:outline-none focus:border-accent-green focus:ring-1 focus:ring-accent-green"
          rows={1}
          disabled={isRunning}
        />
        
        {isReady && !message.trim() ? (
          <button
            onClick={onStart}
            className="px-6 py-3 bg-accent-green text-white rounded-xl hover:bg-brand-green transition-colors self-end"
          >
            开始
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!message.trim() || isRunning}
            className="px-6 py-3 bg-accent-green text-white rounded-xl hover:bg-brand-green transition-colors disabled:opacity-50 disabled:cursor-not-allowed self-end"
          >
            发送
          </button>
        )}
      </div>
    </div>
  )
}
```

**Step 3: 创建 ChatArea 组件**

```typescript
// src/renderer/components/ChatArea.tsx
import { useEffect, useRef } from 'react'
import { TaskDetail } from '../../shared/types'
import { MessageBubble } from './MessageBubble'
import { Composer } from './Composer'

interface ChatAreaProps {
  task: TaskDetail | null
  onSendMessage: (message: string) => void
  onStartTask: () => void
}

export function ChatArea({ task, onSendMessage, onStartTask }: ChatAreaProps) {
  const transcriptRef = useRef<HTMLDivElement>(null)
  
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
    }
  }, [task?.transcript])
  
  const isRunning = task?.state?.status?.startsWith('RUNNING_') ?? false
  const isReady = task?.state?.status === 'READY' && (task?.state?.round ?? 0) === 0
  
  return (
    <div className="flex-1 flex flex-col bg-canvas min-w-0">
      {/* Workspace 标签 */}
      {task?.workspace_key && (
        <div className="px-6 py-2 bg-white border-b border-gray-200">
          <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
            {task.workspace_key}
          </span>
        </div>
      )}
      
      {/* 对话区域 */}
      <div ref={transcriptRef} className="flex-1 overflow-y-auto px-6 py-4">
        {!task ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-gray-400">
              <div className="text-lg font-medium mb-2">选择或创建一个任务</div>
              <div className="text-sm">在左侧栏选择任务，或创建新任务开始</div>
            </div>
          </div>
        ) : task.transcript.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-gray-400">
              <div className="text-lg font-medium mb-2">任务已创建</div>
              <div className="text-sm">点击下方"开始"让 AI 开始工作</div>
            </div>
          </div>
        ) : (
          task.transcript.map((entry, index) => (
            <MessageBubble key={index} entry={entry} />
          ))
        )}
      </div>
      
      {/* 输入区域 */}
      <Composer
        onSend={onSendMessage}
        onStart={onStartTask}
        isRunning={isRunning}
        isReady={isReady}
      />
    </div>
  )
}
```

**Step 4: Commit**

```bash
git add src/renderer/components/ChatArea.tsx src/renderer/components/MessageBubble.tsx src/renderer/components/Composer.tsx
git commit -m "feat: add chat area components"
```

---

## Task 10: 主应用集成

**Files:**
- Modify: `src/renderer/App.tsx`

**Step 1: 更新 App.tsx**

```typescript
// src/renderer/App.tsx
import { useState, useCallback, useEffect } from 'react'
import { useBootstrap, useTasks, useTaskDetail, useCreateTask, useSendMessage, useStartTask, useSkipCountdown, usePauseCountdown, useInterrupt } from './hooks/useBuddy'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { ChatArea } from './components/ChatArea'
import { StatusBar } from './components/StatusBar'

export default function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [isStatusBarOpen, setIsStatusBarOpen] = useState(true)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<string | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  
  const { data: bootstrap } = useBootstrap()
  const { data: tasks = [] } = useTasks()
  const { data: taskDetail } = useTaskDetail(selectedTaskId, selectedWorkspaceKey ?? undefined)
  
  const createTask = useCreateTask()
  const sendMessage = useSendMessage()
  const startTask = useStartTask()
  const skipCountdown = useSkipCountdown()
  const pauseCountdown = usePauseCountdown()
  const interrupt = useInterrupt()
  
  const handleSelectTask = useCallback((taskId: string, workspaceKey: string) => {
    setSelectedTaskId(taskId)
    setSelectedWorkspaceKey(workspaceKey)
  }, [])
  
  const handleCreateTask = useCallback(async (taskId: string, taskText: string) => {
    try {
      const result = await createTask.mutateAsync({
        task_id: taskId,
        repo_root: bootstrap?.repo_root,
        task_text: taskText
      })
      setSelectedTaskId(result.task)
      setSelectedWorkspaceKey(result.workspace_key)
      setShowCreateModal(false)
    } catch (error) {
      console.error('Failed to create task:', error)
    }
  }, [bootstrap, createTask])
  
  const handleSendMessage = useCallback((message: string) => {
    if (!selectedTaskId) return
    sendMessage.mutate({
      taskId: selectedTaskId,
      data: {
        message,
        workspace_key: selectedWorkspaceKey ?? undefined
      }
    })
  }, [selectedTaskId, selectedWorkspaceKey, sendMessage])
  
  const handleStartTask = useCallback(() => {
    if (!selectedTaskId) return
    startTask.mutate({
      taskId: selectedTaskId,
      data: {
        workspace_key: selectedWorkspaceKey ?? undefined
      }
    })
  }, [selectedTaskId, selectedWorkspaceKey, startTask])
  
  const handleSkipCountdown = useCallback(() => {
    if (!selectedTaskId) return
    skipCountdown.mutate({
      taskId: selectedTaskId,
      data: {
        workspace_key: selectedWorkspaceKey ?? undefined
      }
    })
  }, [selectedTaskId, selectedWorkspaceKey, skipCountdown])
  
  const handlePauseCountdown = useCallback(() => {
    if (!selectedTaskId) return
    pauseCountdown.mutate({
      taskId: selectedTaskId,
      data: {
        workspace_key: selectedWorkspaceKey ?? undefined
      }
    })
  }, [selectedTaskId, selectedWorkspaceKey, pauseCountdown])
  
  const handleInterrupt = useCallback(() => {
    if (!selectedTaskId) return
    interrupt.mutate({
      taskId: selectedTaskId,
      workspaceKey: selectedWorkspaceKey ?? undefined
    })
  }, [selectedTaskId, selectedWorkspaceKey, interrupt])
  
  return (
    <div className="h-screen flex flex-col">
      {/* 标题栏 */}
      <TitleBar
        taskName={taskDetail?.task_id ?? ''}
        isSidebarOpen={isSidebarOpen}
        isStatusBarOpen={isStatusBarOpen}
        onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        onToggleStatusBar={() => setIsStatusBarOpen(!isStatusBarOpen)}
      />
      
      {/* 主内容区 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧栏 */}
        <Sidebar
          isOpen={isSidebarOpen}
          tasks={tasks}
          selectedTaskId={selectedTaskId}
          onSelectTask={handleSelectTask}
          onCreateTask={() => setShowCreateModal(true)}
          onOpenSettings={() => {/* TODO */}}
        />
        
        {/* 中间对话区域 */}
        <ChatArea
          task={taskDetail ?? null}
          onSendMessage={handleSendMessage}
          onStartTask={handleStartTask}
        />
        
        {/* 右侧状态栏 */}
        <StatusBar
          isOpen={isStatusBarOpen}
          taskState={taskDetail?.state ?? null}
          taskSettings={taskDetail?.settings ?? null}
          onSkipCountdown={handleSkipCountdown}
          onPauseCountdown={handlePauseCountdown}
          onInterrupt={handleInterrupt}
        />
      </div>
      
      {/* 创建任务模态框 */}
      {showCreateModal && (
        <CreateTaskModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreateTask}
          defaultRepoRoot={bootstrap?.repo_root ?? ''}
        />
      )}
    </div>
  )
}

// 创建任务模态框组件
function CreateTaskModal({ 
  onClose, 
  onCreate, 
  defaultRepoRoot 
}: { 
  onClose: () => void
  onCreate: (taskId: string, taskText: string) => void
  defaultRepoRoot: string
}) {
  const [taskId, setTaskId] = useState('')
  const [taskText, setTaskText] = useState('# 目标\n\n描述要完成的任务。\n\n# 背景与约束\n\n项目背景、约束等。\n\n# 验收标准\n- ')
  
  const handleSubmit = () => {
    if (taskId.trim()) {
      onCreate(taskId.trim(), taskText)
    }
  }
  
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-[600px] max-h-[80vh] flex flex-col">
        {/* 头部 */}
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">新建任务</h2>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded hover:bg-gray-100"
            >
              ×
            </button>
          </div>
        </div>
        
        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* 任务名 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              任务名称 <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              placeholder="输入任务名称"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-accent-green focus:ring-1 focus:ring-accent-green"
            />
          </div>
          
          {/* 工作目录 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              工作目录
            </label>
            <input
              type="text"
              value={defaultRepoRoot}
              disabled
              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-500"
            />
          </div>
          
          {/* 任务说明 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              任务说明
            </label>
            <textarea
              value={taskText}
              onChange={(e) => setTaskText(e.target.value)}
              rows={8}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-accent-green focus:ring-1 focus:ring-accent-green font-mono text-sm"
            />
          </div>
        </div>
        
        {/* 底部 */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!taskId.trim()}
            className="px-4 py-2 text-sm bg-accent-green text-white rounded-lg hover:bg-brand-green transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            创建任务
          </button>
        </div>
      </div>
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: integrate all components into main app"
```

---

## Task 11: 端到端测试

**Files:**
- Create: `tests/e2e/app.test.ts`

**Step 1: 创建 E2E 测试**

```typescript
// tests/e2e/app.test.ts
import { test, expect } from '@playwright/test'

test('app should launch and show title bar', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('text=buddy')).toBeVisible()
})

test('should show sidebar by default', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('text=新建任务')).toBeVisible()
})

test('should toggle sidebar', async ({ page }) => {
  await page.goto('/')
  
  // 点击切换按钮
  await page.locator('button[title="收起侧边栏"]').click()
  
  // 验证侧边栏隐藏
  await expect(page.locator('text=新建任务')).not.toBeVisible()
  
  // 再次点击展开
  await page.locator('button[title="展开侧边栏"]').click()
  
  // 验证侧边栏显示
  await expect(page.locator('text=新建任务')).toBeVisible()
})
```

**Step 2: Commit**

```bash
git add tests/e2e/app.test.ts
git commit -m "test: add e2e tests for basic app functionality"
```

---

## Task 12: 最终集成和打包配置

**Files:**
- Modify: `package.json`
- Create: `electron-builder.yml`

**Step 1: 更新 package.json scripts**

```json
{
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "test": "vitest",
    "test:e2e": "playwright test",
    "package": "electron-builder --mac",
    "package:dir": "electron-builder --mac --dir"
  }
}
```

**Step 2: 创建 electron-builder.yml**

```yaml
appId: com.buddy.macos
productName: buddy
directories:
  release: release
  output: dist
files:
  - dist/**/*
  - out/**/*
mac:
  category: public.app-category.developer-tools
  icon: build/icon.icns
  target:
    - dmg
    - zip
dmg:
  contents:
    - x: 130
      y: 220
    - x: 410
      y: 220
      type: link
      path: /Applications
```

**Step 3: Commit**

```bash
git add package.json electron-builder.yml
git commit -m "chore: add build and package configuration"
```

---

## 完成

实现计划已保存到 `docs/plans/2026-05-25-buddy-macos-mvp-implementation.md`

**两种执行方式：**

1. **Subagent-Driven (本会话)** - 我分发子代理执行每个任务，任务间进行代码审查，快速迭代

2. **Parallel Session (独立会话)** - 打开新会话使用 executing-plans，批量执行并设置检查点

**选择哪种方式？**
