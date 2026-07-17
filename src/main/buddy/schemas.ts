import { z } from 'zod'

const taskStatusSchema = z.enum([
  'QUEUED',
  'READY',
  'RUNNING_CLAUDE',
  'RUNNING_CODEX',
  'RUNNING_OPENCODE',
  'RUNNING_KIMI',
  'RUNNING_CURSOR',
  'PINGING',
  'COUNTDOWN',
  'PAUSED',
  'FAILED',
  'DONE'
])

const executionModeSchema = z.enum(['immediate', 'queued'])

const taskQueueInfoSchema = z.object({
  state: z.enum(['waiting', 'active', 'superseded']),
  enqueued_at: z.string(),
  activated_at: z.string().optional(),
  activation_source: z.enum(['automatic', 'manual']).optional()
})

const activeRunSchema = z.object({
  run_id: z.string().optional(),
  actor: z.string(),
  started_at: z.string(),
  status: z.literal('running').optional(),
  session_id_before: z.string().nullable().optional(),
  session_id_after: z.string().nullable().optional()
})

const countdownSchema = z.object({
  status: z.enum(['running', 'paused', 'elapsed', 'skipped', 'expired']),
  remaining: z.number().optional().default(0),
  started_at: z.string().optional(),
  after_actor: z.string().optional(),
  default_next_actor: z.string(),
  deadline: z.string().optional()
})

const failureSchema = z.object({
  message: z.string(),
  actor: z.string().optional(),
  run_id: z.string().optional(),
  ts: z.string().optional(),
  output_file: z.string().optional(),
  event_file: z.string().optional()
})

const attachmentMetaSchema = z.object({
  path: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number()
})

const instructionQueueItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  created_at: z.string(),
  attachments: z.array(attachmentMetaSchema).optional()
})

const healthCheckResultSchema = z.object({
  actors: z.record(z.string(), z.enum(['pending', 'running', 'passed', 'failed'])),
  failed_actor: z.string().optional(),
  failed_reason: z.string().optional()
})

export const taskStateSchema = z.object({
  protocol_version: z.string().optional(),
  task_id: z.string().optional(),
  repo_root: z.string().optional(),
  status: taskStatusSchema,
  round: z.number(),
  rounds_in_window: z.number().default(0),
  next_actor: z.string(),
  countdown: countdownSchema.nullable().optional(),
  active_run: activeRunSchema.nullable().optional(),
  instruction_queue: z.array(instructionQueueItemSchema).default([]),
  claude_session_id: z.string().nullable().optional(),
  codex_thread_id: z.string().nullable().optional(),
  opencode_session_id: z.string().nullable().optional(),
  kimi_session_id: z.string().nullable().optional(),
  agent_sessions: z.record(z.string(), z.string().nullable()).default({}),
  context_hash: z.string().optional(),
  context_sent: z.record(z.string(), z.boolean()).default({}),
  event_seq: z.number().optional(),
  transcript_seq: z.number().optional(),
  consecutive_failures: z.number().optional(),
  last_error: failureSchema.nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  pending_break: z.object({ actor: z.string().optional(), round: z.number().optional() }).nullable().optional(),
  break_rejected_by: z.object({ actor: z.string().optional(), round: z.number().optional() }).nullable().optional(),
  latest_failure: failureSchema.nullable().optional(),
  health_check: healthCheckResultSchema.nullable().optional(),
  compact_retries: z.number().optional(),
  execution_mode: executionModeSchema.optional(),
  queue: taskQueueInfoSchema.optional()
})

// Empty/whitespace optional strings are normalized to undefined so clearing a
// field removes its behavior rather than persisting an empty override.
const optionalNonEmptyString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined))

const cursorLauncherOptionsSchema = z.object({
  mode: z.enum(['agent', 'plan', 'ask']).optional(),
  force: z.boolean().optional(),
  trust: z.boolean().optional(),
  approve_mcps: z.boolean().optional(),
  sandbox: z.enum(['default', 'enabled', 'disabled']).optional(),
  stream_partial_output: z.boolean().optional(),
  extra_args: z.array(z.string()).optional()
})

export const launcherSchema = z.object({
  command: z.string(),
  env: z.record(z.string(), z.string()).default({}),
  timeout_seconds: z.number().default(600),
  backend: z.enum(['auto', 'claude', 'codex', 'opencode', 'kimi', 'cursor', 'contract']).optional(),
  display_name: optionalNonEmptyString,
  model: optionalNonEmptyString,
  prompt_preset_id: optionalNonEmptyString,
  custom_prompt: optionalNonEmptyString,
  cursor: cursorLauncherOptionsSchema.optional()
})

const promptPresetSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  prompt: z.string().trim().min(1)
})

export const taskSettingsSchema = z.object({
  protocol_version: z.string().default('1'),
  flow_policy: z.string().default('claude_then_codex'),
  role_mode: z.string().default('claude_implements'),
  launchers: z.record(z.string(), launcherSchema).default({}),
  implementer_actor: z.string().optional(),
  reviewer_actor: z.string().optional(),
  max_consecutive_failures: z.number().optional(),
  seed_claude_session_id: z.string().optional(),
  seed_codex_thread_id: z.string().optional(),
  seed_opencode_session_id: z.string().optional(),
  seed_kimi_session_id: z.string().optional(),
  seed_agent_sessions: z.record(z.string(), z.string()).default({}),
  prompt_presets: z.array(promptPresetSchema).optional(),
  max_compact_retries: z.number().optional()
})

export const globalSettingsSchema = z.object({
  protocol_version: z.string().default('1'),
  countdown_seconds: z.number().default(30),
  max_rounds: z.number().default(9999),
  max_consecutive_failures: z.number().default(10),
  launchers: z.record(z.string(), launcherSchema).default({}),
  seed_claude_session_id: z.string().optional(),
  seed_codex_thread_id: z.string().optional(),
  seed_opencode_session_id: z.string().optional(),
  seed_kimi_session_id: z.string().optional(),
  max_compact_retries: z.number().optional(),
  auto_generate_commit_message: z.boolean().default(true),
  system_notifications_enabled: z.boolean().default(true),
  max_upgrade_retries: z.number().optional(),
  custom_prompt: optionalNonEmptyString,
  prompt_presets: z.array(promptPresetSchema).default([])
})

export const eventSchema = z.object({
  seq: z.number(),
  task_id: z.string().optional(),
  type: z.string(),
  actor: z.string().optional(),
  ts: z.string(),
  run_id: z.string().optional(),
  payload: z.record(z.string(), z.unknown())
})

export function parseTaskState(input: unknown) {
  return taskStateSchema.parse(input)
}

export function parseTaskSettings(input: unknown) {
  return taskSettingsSchema.parse(input)
}

export function parseGlobalSettings(input: unknown) {
  return globalSettingsSchema.parse(input)
}

export function parseEventLine(line: string) {
  return eventSchema.parse(JSON.parse(line))
}
