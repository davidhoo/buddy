import { z } from 'zod'

const serviceBaseSchema = z.object({
  id: z.string().uuid(), name: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
  task_id: z.string(), workspace_key: z.string(), created_at: z.string(),
  keep_reason: z.string().min(1).optional()
})
export const taskServiceSchema = z.discriminatedUnion('owner', [
  serviceBaseSchema.extend({
    owner: z.literal('buddy'), command: z.array(z.string()).min(1), cwd: z.string(),
    token: z.string().min(32), socket: z.string(), status_path: z.string(), log_path: z.string()
  }),
  serviceBaseSchema.extend({ owner: z.literal('external'), pid: z.number().int().positive() })
])
export type TaskServiceRecord = z.infer<typeof taskServiceSchema>
export const serviceStatusSchema = z.object({
  status: z.enum(['starting', 'running', 'stopped', 'exited', 'failed', 'cleanup_failed']),
  supervisor_pid: z.number().int().positive().optional(), pid: z.number().int().positive().nullable().optional(),
  exit_code: z.number().nullable().optional(), signal: z.string().nullable().optional(),
  reason: z.string().optional(), error: z.string().optional(), ended_at: z.string().optional()
})
export const serviceRequestSchema = z.object({
  action: z.enum(['start', 'list', 'stop', 'keep', 'external']),
  name: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/).optional(),
  command: z.array(z.string()).min(1).optional(), cwd: z.string().optional(),
  keepReason: z.string().trim().min(1).optional(), pid: z.number().int().positive().optional()
})
export const serviceTaskManifestSchema = z.object({ task_id: z.string(), workspace_key: z.string() })

const taskStatusSchema = z.enum([
  'QUEUED',
  'READY',
  'RUNNING_AGENT',
  'RUNNING_CLAUDE',
  'RUNNING_CODEX',
  'RUNNING_CURSOR',
  'RUNNING_AGY',
  'RUNNING_OPENCODE',
  'RUNNING_KIMI',
  'RUNNING_DSH',
  'RUNNING_WECODE_CLAUDE',
  'RUNNING_WECODE_CODEX',
  'RUNNING_WECODE_OPENCODE',
  'PINGING',
  'COUNTDOWN',
  'PAUSED',
  'FAILED',
  'DONE',
  'CANCELLED'
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
  actor_sessions: z.record(z.string(), z.string()).default({}),
  claude_session_id: z.string().nullable().optional(),
  codex_thread_id: z.string().nullable().optional(),
  cursor_session_id: z.string().nullable().optional(),
  agy_session_id: z.string().nullable().optional(),
  opencode_session_id: z.string().nullable().optional(),
  kimi_session_id: z.string().nullable().optional(),
  dsh_session_id: z.string().nullable().optional(),
  wecode_claude_session_id: z.string().nullable().optional(),
  wecode_codex_thread_id: z.string().nullable().optional(),
  wecode_opencode_session_id: z.string().nullable().optional(),
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
  queue: taskQueueInfoSchema.optional(),
  service_cleanup_pending: z.boolean().optional()
})

export const launcherSchema = z.object({
  protocol: z.enum(['acp', 'cli']).optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).default({}),
  timeout_seconds: z.number().default(600),
  model: z.string().optional()
})

// Empty/whitespace custom_prompt is normalized to undefined so an emptied
// field means "no custom prompt" rather than an empty trailing section.
const optionalNonEmptyString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined))

export const taskSettingsSchema = z.object({
  seed_actor_sessions: z.record(z.string(),z.string()).optional(),
  protocol_version: z.string().default('1'),
  flow_policy: z.string().default('claude_then_codex'),
  role_mode: z.string().default('claude_implements'),
  launchers: z.record(z.string(), launcherSchema).default({}),
  implementer_actor: z.string().optional(),
  reviewer_actor: z.string().optional(),
  max_consecutive_failures: z.number().optional(),
  seed_claude_session_id: z.string().optional(),
  seed_codex_thread_id: z.string().optional(),
  seed_cursor_session_id: z.string().optional(),
  seed_agy_session_id: z.string().optional(),
  seed_opencode_session_id: z.string().optional(),
  seed_kimi_session_id: z.string().optional(),
  seed_dsh_session_id: z.string().optional(),
  seed_wecode_claude_session_id: z.string().optional(),
  seed_wecode_codex_thread_id: z.string().optional(),
  seed_wecode_opencode_session_id: z.string().optional(),
  max_compact_retries: z.number().optional()
})

export const globalSettingsSchema = z.object({
  agent_management: z.record(z.string(), z.object({ contract: z.boolean().optional(), enabled: z.boolean().optional(), protocol: z.enum(['cli','acp']).optional(), cli: launcherSchema.optional(), acp: launcherSchema.optional() })).optional(),
  protocol_version: z.string().default('1'),
  countdown_seconds: z.number().default(30),
  max_rounds: z.number().default(9999),
  max_consecutive_failures: z.number().default(10),
  launchers: z.record(z.string(), launcherSchema).default({}),
  seed_claude_session_id: z.string().optional(),
  seed_codex_thread_id: z.string().optional(),
  seed_cursor_session_id: z.string().optional(),
  seed_agy_session_id: z.string().optional(),
  seed_opencode_session_id: z.string().optional(),
  seed_kimi_session_id: z.string().optional(),
  seed_dsh_session_id: z.string().optional(),
  seed_wecode_claude_session_id: z.string().optional(),
  seed_wecode_codex_thread_id: z.string().optional(),
  seed_wecode_opencode_session_id: z.string().optional(),
  max_compact_retries: z.number().optional(),
  auto_generate_commit_message: z.boolean().default(true),
  system_notifications_enabled: z.boolean().default(true),
  max_upgrade_retries: z.number().optional(),
  custom_prompt: optionalNonEmptyString
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

export const agentUpdateJobsSchema=z.array(z.object({id:z.string(),agentId:z.string(),status:z.enum(['queued','updating','verifying','success','failed','skipped','cancelled','interrupted']),before:z.string().optional(),after:z.string().optional(),error:z.string().optional()}))

export const kimiProviderModelListSchema = z.object({
  models: z.record(z.string(), z.object({ display_name: z.string().optional() }))
})

export const agentUpdateItemSchema = z.object({
  id: z.string(), agentId: z.string(), name: z.string(), installationId: z.string().optional(), targetKey: z.string().optional(),
  target:z.enum(['agent','wecode']).optional(),source:z.enum(['npm','pnpm','bun','brew','uv','pipx','self','unknown']).optional(),
  status: z.enum(['queued','preparing','installing','verifying','updated','up_to_date','failed','skipped','cancelled','interrupted']),
  before: z.string().optional(), after: z.string().optional(), startedAt: z.string().optional(), finishedAt: z.string().optional(), error: z.string().optional(),
  process: z.object({pid:z.number().int().positive(),started:z.string(),command:z.string()}).optional()
})
export const agentUpdateBatchSchema = z.object({
  id:z.string(),requestId:z.string(),createdAt:z.string().optional(),finishedAt:z.string().optional(),
  status:z.enum(['queued','preparing','waiting','running','cancelling','completed','interrupted']),cancelRequested:z.boolean(),
  items:z.array(agentUpdateItemSchema),error:z.string().optional()
})
export const agentUpdateSnapshotSchema = z.object({schemaVersion:z.literal(2),revision:z.number(),activeBatch:agentUpdateBatchSchema.optional(),lastCompletedBatch:agentUpdateBatchSchema.optional()})
export const agentInventoryCacheSchema = z.object({
  schemaVersion:z.literal(2),scannedAt:z.string().optional(),configurationHash:z.string(),
  agents:z.array(z.object({
    id:z.string(),name:z.string(),installationId:z.string(),path:z.string(),realPath:z.string(),
    version:z.string().optional(),appVersion:z.string().optional(),source:z.enum(['npm','pnpm','bun','brew','uv','pipx','self','unknown']),
    prefix:z.string().optional(),manager:z.string().optional(),package:z.string().optional(),runnable:z.boolean(),enabled:z.boolean(),
    selectedProtocol:z.enum(['cli','acp']).optional(),modelFlag:z.string().optional(),error:z.string().optional(),acpError:z.string().optional(),
    acpStatus:z.enum(['verified','unverified','missing','incompatible','failed']).optional(),
    installations:z.array(z.object({id:z.string(),path:z.string(),realPath:z.string(),version:z.string().optional()})).optional(),
    latest:z.string().optional(),checkedAt:z.string().optional(),updateError:z.string().optional(),
    nativeUpdate:z.object({command:z.string(),args:z.array(z.string()),versionArgs:z.array(z.string()),version:z.string(),target:z.enum(['agent','wecode'])}).optional(),
    nativeAcpArgs:z.array(z.enum(['acp','--acp','--experimental-acp','opencode'])).optional()
  }))
})
