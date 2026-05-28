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

export interface InstructionQueueItem {
  id: string
  content: string
  created_at: string
}

export interface TaskState {
  protocol_version?: string
  task_id?: string
  repo_root?: string
  status: TaskStatus
  round: number
  rounds_in_window?: number
  next_actor: string
  countdown?: Countdown | null
  active_run?: ActiveRun | null
  instruction_queue?: InstructionQueueItem[]
  claude_session_id?: string | null
  codex_thread_id?: string | null
  opencode_session_id?: string | null
  kimi_session_id?: string | null
  context_hash?: string
  context_sent?: Record<string, boolean>
  event_seq?: number
  transcript_seq?: number
  consecutive_failures?: number
  last_error?: Failure | null
  created_at?: string
  updated_at?: string
  pending_break?: { actor?: string; round?: number } | null
  latest_failure?: Failure | null
}

export interface Countdown {
  status: 'running' | 'paused' | 'elapsed' | 'skipped' | 'expired'
  remaining?: number
  started_at?: string
  after_actor?: string
  default_next_actor: string
  deadline?: string
}

export interface ActiveRun {
  run_id?: string
  actor: string
  started_at: string
  status?: 'running'
  session_id_before?: string | null
  session_id_after?: string | null
}

export interface TaskSettings {
  protocol_version: string
  flow_policy: string
  role_mode: string
  launchers: Record<string, Launcher>
  implementer_actor?: string
  reviewer_actor?: string
  max_consecutive_failures?: number
  seed_claude_session_id?: string
  seed_codex_thread_id?: string
  seed_opencode_session_id?: string
  seed_kimi_session_id?: string
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
  task_id?: string
  type: string
  actor?: string
  ts: string
  run_id?: string
  payload: Record<string, unknown>
}

export interface Failure {
  message: string
  actor?: string
  run_id?: string
  ts?: string
  output_file?: string
  event_file?: string
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
  home_dir: string
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
  seed_claude_session_id?: string
  seed_codex_thread_id?: string
  seed_opencode_session_id?: string
  seed_kimi_session_id?: string
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

export interface GitDiffStats {
  filesChanged: number
  insertions: number
  deletions: number
  summary: string
}

export interface GitRemote {
  name: string
  url: string
}

export interface GitStatusResult {
  branch: string
  diff: GitDiffStats | null
  staged: GitDiffStats | null
  untracked: number
  remotes: GitRemote[]
}
