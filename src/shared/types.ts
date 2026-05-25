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
