export interface Task {
  task_id: string
  workspace_key: string
  status: TaskStatus
  updated_at: string
  repo_root: string
  round?: number
  active_run?: ActiveRun | null
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
  active_run?: ActiveRun | null
  claude_session_id?: string
  codex_thread_id?: string
  opencode_session_id?: string
  kimi_session_id?: string
  updated_at?: string
  repo_root?: string
  pending_break?: { actor?: string; round?: number } | null
  latest_failure?: Failure | null
}

export interface Countdown {
  status: 'running' | 'paused' | 'elapsed' | 'skipped' | 'expired'
  remaining: number
  default_next_actor: string
  deadline?: string
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
  implementer_actor?: string
  reviewer_actor?: string
  max_rounds?: number
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
  run_id?: string
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
  version?: string
  repo_root: string
  data_root: string
  workspace_key?: string
  tasks: Task[]
  global_settings?: GlobalSettings
}

export interface GlobalSettings {
  protocol_version?: string
  countdown_seconds?: number
  max_rounds?: number
  max_consecutive_failures?: number
  launchers?: Record<string, Launcher>
}

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
