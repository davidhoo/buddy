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
  remaining: z.number().default(0),
  default_next_actor: z.string(),
  deadline: z.string().optional()
})

function optionalLegacyNullable<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => value === null ? undefined : value, schema.optional())
}

const failureSchema = z.object({
  message: z.string(),
  actor: z.string().optional(),
  ts: z.string().optional()
})

export const taskStateSchema = z.object({
  status: taskStatusSchema,
  round: z.number(),
  next_actor: z.string(),
  countdown: optionalLegacyNullable(countdownSchema),
  active_run: activeRunSchema.nullable().optional(),
  claude_session_id: optionalLegacyNullable(z.string()),
  codex_thread_id: optionalLegacyNullable(z.string()),
  opencode_session_id: optionalLegacyNullable(z.string()),
  kimi_session_id: optionalLegacyNullable(z.string()),
  updated_at: z.string().optional(),
  repo_root: z.string().optional(),
  pending_break: z.object({ actor: z.string().optional(), round: z.number().optional() }).nullable().optional(),
  latest_failure: failureSchema.nullable().optional()
})

export const launcherSchema = z.object({
  command: z.string(),
  env: z.record(z.string(), z.string()).default({}),
  timeout_seconds: z.number().default(600)
})

export const taskSettingsSchema = z.object({
  protocol_version: z.string().default('1'),
  countdown_seconds: z.number().default(30),
  flow_policy: z.string().default('claude_then_codex'),
  role_mode: z.string().default('claude_implements'),
  launchers: z.record(z.string(), launcherSchema).default({}),
  implementer_actor: z.string().optional(),
  reviewer_actor: z.string().optional(),
  max_rounds: z.number().optional(),
  max_consecutive_failures: z.number().optional()
})

export const globalSettingsSchema = z.object({
  protocol_version: z.string().default('1'),
  countdown_seconds: z.number().default(30),
  max_rounds: z.number().default(10),
  max_consecutive_failures: z.number().default(3),
  launchers: z.record(z.string(), launcherSchema).default({})
})

export const eventSchema = z.object({
  seq: z.number(),
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
