export interface Task {
  task_id: string
  workspace_key: string
  status: TaskStatus
  updated_at: string
  repo_root: string
  round?: number
  active_run?: ActiveRun | null
  execution_mode?: ExecutionMode
  queue?: TaskQueueInfo
  created_at?: string
}

export type TaskStatus =
  | 'QUEUED'
  | 'READY'
  | 'RUNNING_CLAUDE'
  | 'RUNNING_CODEX'
  | 'RUNNING_OPENCODE'
  | 'RUNNING_KIMI'
  | 'RUNNING_CURSOR'
  | 'PINGING'
  | 'COUNTDOWN'
  | 'PAUSED'
  | 'FAILED'
  | 'DONE'

/** Per-project FIFO queue metadata attached to queued-execution tasks. */
export interface TaskQueueInfo {
  state: 'waiting' | 'active' | 'superseded'
  enqueued_at: string
  activated_at?: string
  activation_source?: 'automatic' | 'manual'
}

export type ExecutionMode = 'immediate' | 'queued'

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
  attachments?: AttachmentMeta[]
}

export interface HealthCheckResult {
  actors: Record<string, 'pending' | 'running' | 'passed' | 'failed'>
  failed_actor?: string
  failed_reason?: string
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
  /** Session IDs keyed by configurable agent profile ID. */
  agent_sessions?: Record<string, string | null>
  context_hash?: string
  context_sent?: Record<string, boolean>
  event_seq?: number
  transcript_seq?: number
  consecutive_failures?: number
  last_error?: Failure | null
  created_at?: string
  updated_at?: string
  pending_break?: { actor?: string; round?: number } | null
  break_rejected_by?: { actor?: string; round?: number } | null
  latest_failure?: Failure | null
  health_check?: HealthCheckResult | null
  compact_retries?: number
  execution_mode?: ExecutionMode
  queue?: TaskQueueInfo
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
  /** Seed sessions keyed by configurable agent profile ID. */
  seed_agent_sessions?: Record<string, string>
  /** Snapshot of prompt presets available when the task was created. */
  prompt_presets?: PromptPreset[]
}

export type LauncherBackend = 'auto' | 'claude' | 'codex' | 'opencode' | 'kimi' | 'cursor' | 'contract'

export interface CursorLauncherOptions {
  mode?: 'agent' | 'plan' | 'ask'
  force?: boolean
  trust?: boolean
  approve_mcps?: boolean
  sandbox?: 'default' | 'enabled' | 'disabled'
  stream_partial_output?: boolean
  extra_args?: string[]
}

export interface Launcher {
  command: string
  env: Record<string, string>
  timeout_seconds: number
  /**
   * Explicit launcher protocol. `auto` detects known executable names and
   * preserves the legacy contract protocol for unknown commands. Select a
   * native backend explicitly when `command` is a wrapper around that CLI.
   */
  backend?: LauncherBackend
  /** Human-readable profile name. The record key remains the stable actor ID. */
  display_name?: string
  /** Backend-specific model ID; passed to Cursor Agent as `--model`. */
  model?: string
  prompt_preset_id?: string
  /** Instructions appended only for this agent profile. */
  custom_prompt?: string
  cursor?: CursorLauncherOptions
}

export interface TranscriptEntry {
  /** Built-in role or a configurable agent profile ID. */
  role: string
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
  locale?: string
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
  max_compact_retries?: number
  auto_generate_commit_message?: boolean
  system_notifications_enabled?: boolean
  max_upgrade_retries?: number
  custom_prompt?: string
  prompt_presets?: PromptPreset[]
}

export interface PromptPreset {
  id: string
  name: string
  prompt: string
}

export interface CursorModelParameterValue {
  value: string
  displayName?: string
}

export interface CursorModelParameterDefinition {
  id: string
  displayName?: string
  values: CursorModelParameterValue[]
}

export interface CursorModelVariant {
  params: Array<{ id: string; value: string }>
  displayName: string
  description?: string
  isDefault?: boolean
}

export interface CursorModel {
  id: string
  displayName: string
  description?: string
  aliases?: string[]
  parameters?: CursorModelParameterDefinition[]
  variants?: CursorModelVariant[]
}

export interface CursorModelCatalog {
  models: CursorModel[]
  source: 'cursor-api' | 'cli'
  fetchedAt: string
  warning?: string
}

export interface CursorModelDiscoveryInput {
  command?: string
  env?: Record<string, string>
  apiKey?: string
}

export interface BuddyError {
  code: string
  message: string
  details?: unknown
  recoverable?: boolean
}

export interface TestLauncherResult {
  actor: string
  success: boolean
  phase: 'tool_check' | 'ping'
  error?: string
  sessionId?: string
  threadId?: string
  responsePreview?: string
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
  execution_mode?: ExecutionMode
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

export interface Attachment {
  id: string
  name: string
  category: 'image' | 'file'
  mimeType: string
  size: number
  previewUrl?: string
  bufferBase64?: string
  filePath?: string
}

export interface AttachmentMeta {
  path: string
  name: string
  mimeType: string
  size: number
}

export interface SendMessageInput {
  actor?: string
  message?: string
  workspace_key?: string
  attachments?: Attachment[]
  attachmentMeta?: AttachmentMeta[]
}

export interface CountdownInput {
  next_actor?: string
  workspace_key?: string
}

export interface RoundEventEntry {
  type: 'thinking' | 'text' | 'tool_use' | 'tool_result' | 'result'
  thinkingLength?: number
  text?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResultPreview?: string
  isError?: boolean
  durationMs?: number
  costUsd?: number
  model?: string
}

export interface RoundEventSummary {
  runId: string
  events: RoundEventEntry[]
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  durationMs?: number
  costUsd?: number
  model?: string
}

export interface TaskActorStats {
  actor: string
  model?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  durationMs: number
  costUsd?: number
  rounds: number
}

export interface TaskStats {
  actors: TaskActorStats[]
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalDurationMs: number
  totalCostUsd?: number
  totalRounds: number
}

export type GitFileStatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?'

export interface GitFileStatus {
  path: string
  status: GitFileStatusCode
  insertions: number
  deletions: number
}

export interface GitDiffStats {
  filesChanged: number
  insertions: number
  deletions: number
  summary: string
  files?: GitFileStatus[]
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
  files: GitFileStatus[]
  remotes: GitRemote[]
}
