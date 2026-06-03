# Buddy MVP 设计文档

## 1. 概述

Buddy 是一个 macOS 原生桌面应用，采用 Electron + React 构建，包装 buddy-python 的 HTTP API，提供原生 macOS 体验。

### 1.1 核心理念

- **不重写 buddy-python**：直接调用 buddy-python 的 HTTP API
- **智能检测服务**：自动检测并复用已运行的 buddy 服务，或自动启动
- **原生 UI**：使用 React + Tailwind CSS 构建原生 macOS 风格界面
- **三栏布局**：左侧任务列表、中间对话区域、右侧状态栏

### 1.2 功能范围 (MVP)

**包含**:
- 任务列表（显示已有任务）
- 新建任务（填写任务名、说明、选择 Actor）
- 对话区域（显示消息）
- 输入框（发送消息）
- 右侧状态栏（Actor 状态、倒计时）
- 左侧栏折叠/展开
- 右侧栏折叠/展开

**不包含 (后续版本)**:
- 搜索功能
- 技能/插件系统
- 自动化功能
- 环境信息显示

## 2. 架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Electron 主进程                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ BuddyService│  │ WindowMgr   │  │ TrayMgr     │         │
│  │ (HTTP 客户端)│  │ (窗口管理)  │  │ (系统托盘)  │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└─────────────────────────────────────────────────────────────┘
                              │ HTTP API
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    buddy-python 服务                        │
│              (localhost:8765 或自动启动)                     │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 技术栈

- **Electron**: 33.x
- **React**: 18.x
- **TypeScript**: 5.x
- **UI**: Tailwind CSS + Radix UI
- **状态管理**: TanStack Query
- **构建**: electron-vite

### 2.3 目录结构

```
buddy/
├── src/
│   ├── main/                    # Electron 主进程
│   │   ├── index.ts             # 主入口
│   │   ├── buddy-service.ts     # buddy-python HTTP 客户端
│   │   ├── window-manager.ts    # 窗口管理
│   │   └── tray-manager.ts      # 系统托盘
│   ├── renderer/                # React 渲染进程
│   │   ├── App.tsx              # 主应用组件
│   │   ├── components/          # UI 组件
│   │   │   ├── Sidebar.tsx      # 左侧栏
│   │   │   ├── ChatArea.tsx     # 中间对话区域
│   │   │   ├── StatusBar.tsx    # 右侧状态栏
│   │   │   └── TitleBar.tsx     # 顶部标题栏
│   │   ├── hooks/               # 自定义 hooks
│   │   │   ├── useBuddy.ts      # buddy API hooks
│   │   │   └── useTasks.ts      # 任务相关 hooks
│   │   └── lib/                 # 工具函数
│   │       └── api.ts           # API 客户端
│   └── shared/                  # 共享类型
│       └── types.ts             # TypeScript 类型定义
├── docs/
│   └── plans/
│       └── 2026-05-25-buddy-macos-mvp-design.md
└── package.json
```

## 3. 窗口布局

### 3.1 整体布局

```
┌─────────────────────────────────────────────────────────────┐
│ ● ● ●  ≡  │ macos app store issues │           ▶ │ [□][□][□] │
├───────────┴────────────────────────┴─────────────┴───────────┤
│ Local                                                       │
├─────────────────────────────────────┬───────────────────────┤
│                                     │                       │
│  11:58 PM                           │   Codex               │
│  You                                │   ─────────           │
│  how to reproduce                   │   Reading README.md   │
│                                     │                       │
│  11:58 PM                           │   [Approve]           │
│  Codex                              │   [Reject]            │
│  I'll investigate...                │                       │
│                                     │                       │
├─────────────────────────────────────┤                       │
│ Describe a task...           [→]   │                       │
└─────────────────────────────────────┴───────────────────────┘
```

### 3.2 顶部标题栏

```
┌─────────────────────────────────────────────────────────────┐
│ ● ● ●  ≡  │ macos app store issues │           ▶ │ [□][□][□] │
└─────────────────────────────────────────────────────────────┘
│     │              │                    │           │
│     │              │                    │           └─ 窗口控制
│     │              │                    └─ 右侧栏切换
│     │              └─ 任务名
│     └─ 左侧栏切换
└─ 窗口红绿灯
```

**元素**:
- **左侧**: 红黄绿窗口按钮 + ≡ 按钮（左侧栏切换）
- **中间**: 当前任务名
- **右侧**: ▶ 按钮（右侧栏切换）+ 窗口控制按钮

### 3.3 左侧栏 (240px, 可折叠)

**展开状态**:
```
┌────────────────┐
│                │
│   buddy        │
│                │
│ ┌────────────┐ │
│ │ New task   │ │
│ └────────────┘ │
│                │
│ macos app      │
│ store issues   │
│                │
│ memory macos   │
│ app store      │
│ issues         │
│                │
│                │
│ ⚙ Settings     │
└────────────────┘
```

**收起状态**:
- 只显示 ≡ 按钮（在标题栏中）
- 左侧栏完全隐藏

**内容**:
- 应用图标 "buddy"
- 新建任务按钮
- 任务列表（按 workspace 分组）
- 底部设置按钮

### 3.4 中间对话区域

**结构**:
- **顶部**: Local 标签（workspace 标识）
- **对话区域**: 消息气泡列表
- **底部**: 输入框（悬浮定位）

**消息类型**:
- **用户消息**: 右侧对齐，显示时间戳
- **AI 消息**: 左侧对齐，显示 Actor 名称、时间戳
- **系统消息**: 居中显示

**输入框**:
- 占位符: "Describe a task..."
- 发送按钮: → 图标
- **悬浮定位**: 固定在对话区域底部

### 3.5 右侧状态栏 (280px, 可折叠)

**展开状态**:
```
┌────────────────┐
│                │
│   Codex        │
│   ─────────    │
│   Reading      │
│   README.md    │
│                │
│   [Approve]    │
│   [Reject]     │
│                │
│   任务设置     │
│   事件日志     │
│                │
└────────────────┘
```

**收起状态**:
- 只显示 ▶ 按钮（在标题栏中）
- 右侧栏完全隐藏

**内容**:
- **当前 Actor 状态**:
  - Actor 名称
  - 当前执行步骤
  - 进度指示
- **操作按钮**: Approve / Reject
- **倒计时控制**
- **任务设置摘要**
- **事件日志**

## 4. 数据流

### 4.1 服务检测与启动

```
应用启动
    ↓
检测 localhost:8765
    ↓
┌─────────────────┬─────────────────┐
│ 服务已运行       │ 服务未运行       │
│ 复用现有服务     │ 自动启动服务     │
└─────────────────┴─────────────────┘
    ↓
开始轮询 API
```

### 4.2 数据获取流程

```
React 组件
    ↓ useQuery/useMutation
API Service (axios)
    ↓ HTTP 请求
BuddyService (主进程)
    ↓ 智能检测/启动
buddy-python HTTP API
```

### 4.3 轮询机制

- **活动状态**: 1.5 秒轮询间隔
- **空闲状态**: 5 秒轮询间隔
- **错误状态**: 指数退避，最大 8 秒

## 5. 核心功能实现

### 5.1 任务管理

**API 端点**:
- `GET /api/tasks` - 获取任务列表
- `POST /api/tasks` - 创建任务
- `DELETE /api/tasks/{task_id}` - 删除任务
- `GET /api/tasks/{task_id}` - 获取任务详情

**数据结构**:
```typescript
interface Task {
  task_id: string;
  workspace_key: string;
  status: 'READY' | 'RUNNING_CLAUDE' | 'RUNNING_CODEX' | 'COUNTDOWN' | 'PAUSED' | 'FAILED' | 'DONE';
  updated_at: string;
  repo_root: string;
}
```

### 5.2 对话管理

**API 端点**:
- `GET /api/tasks/{task_id}` - 获取任务详情（包含 transcript）
- `POST /api/tasks/{task_id}/message` - 发送消息
- `POST /api/tasks/{task_id}/start` - 开始任务

**Transcript 结构**:
```typescript
interface TranscriptEntry {
  role: 'human' | 'claude' | 'codex' | 'system';
  content: string;
  ts: string;
  round?: number;
}
```

### 5.3 状态管理

**API 端点**:
- `GET /api/events?task={task_id}&since={seq}` - 获取事件流
- `POST /api/tasks/{task_id}/skip-countdown` - 跳过倒计时
- `POST /api/tasks/{task_id}/pause-countdown` - 暂停倒计时
- `POST /api/tasks/{task_id}/interrupt` - 打断运行

**状态结构**:
```typescript
interface TaskState {
  status: string;
  round: number;
  next_actor: string;
  countdown?: {
    status: 'running' | 'paused' | 'elapsed' | 'skipped';
    remaining: number;
  };
  active_run?: {
    actor: string;
    started_at: string;
  };
}
```

## 6. UI 组件设计

### 6.1 TitleBar 组件

**功能**: 顶部标题栏，包含窗口控制和侧边栏切换

**Props**:
```typescript
interface TitleBarProps {
  taskName: string;
  isSidebarOpen: boolean;
  isStatusBarOpen: boolean;
  onToggleSidebar: () => void;
  onToggleStatusBar: () => void;
}
```

### 6.2 Sidebar 组件

**功能**: 左侧任务列表栏

**Props**:
```typescript
interface SidebarProps {
  isOpen: boolean;
  tasks: Task[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onCreateTask: () => void;
  onOpenSettings: () => void;
}
```

### 6.3 ChatArea 组件

**功能**: 中间对话区域

**Props**:
```typescript
interface ChatAreaProps {
  task: TaskDetail | null;
  onSendMessage: (message: string) => void;
  onStartTask: () => void;
}
```

### 6.4 StatusBar 组件

**功能**: 右侧状态栏

**Props**:
```typescript
interface StatusBarProps {
  isOpen: boolean;
  taskState: TaskState | null;
  onSkipCountdown: () => void;
  onPauseCountdown: () => void;
  onInterrupt: () => void;
}
```

## 7. 样式设计

### 7.1 颜色方案

参考 buddy-python web 版本的 Starbucks 风格：

```css
:root {
  --canvas: #f2f0eb;
  --canvas-2: #edebe9;
  --house-green: #1e3932;
  --brand-green: #006241;
  --accent-green: #00754a;
  --gold: #cba258;
  --danger: #c82014;
  --card: #ffffff;
  --panel: #fbfaf7;
  --text: rgba(0, 0, 0, 0.87);
  --muted: rgba(0, 0, 0, 0.58);
  --line: rgba(30, 57, 50, 0.14);
}
```

### 7.2 布局尺寸

- **左侧栏**: 240px（展开）/ 0px（收起）
- **右侧栏**: 280px（展开）/ 0px（收起）
- **标题栏高度**: 52px
- **输入框高度**: 60px

### 7.3 动画效果

- **侧边栏切换**: 300ms ease-in-out
- **消息出现**: 200ms fade-in
- **状态变化**: 150ms transition

## 8. 错误处理

### 8.1 连接错误

- **服务不可用**: 显示重试按钮
- **网络超时**: 自动重试，指数退避
- **API 错误**: 显示错误提示

### 8.2 任务错误

- **任务创建失败**: 显示错误信息
- **任务运行失败**: 显示失败原因
- **Actor 错误**: 显示 Actor 名称和错误详情

## 9. 测试策略

### 9.1 单元测试

- **组件测试**: React Testing Library
- **Hook 测试**: renderHook
- **工具函数测试**: Vitest

### 9.2 集成测试

- **API 集成**: Mock buddy-python 服务
- **Electron 集成**: Spectron

### 9.3 E2E 测试

- **完整流程**: 创建任务 → 运行 → 完成
- **错误场景**: 服务中断、网络错误

## 10. 部署与分发

### 10.1 构建

```bash
# 开发环境
npm run dev

# 生产构建
npm run build

# 打包 DMG
npm run package
```

### 10.2 分发

- **DMG 安装包**: 未签名版本
- **自动更新**: 后续版本实现

## 11. 后续版本规划

### v0.2
- 搜索功能
- 环境信息显示

### v0.3
- 技能/插件系统
- 自动化功能

### v0.4
- 系统托盘
- 通知集成

### v0.5
- 代码签名
- 自动更新
