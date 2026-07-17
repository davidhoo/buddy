import type { GlobalSettings, Launcher, PromptPreset } from './types'

export const DEFAULT_LAUNCHER_ORDER = ['claude', 'codex', 'opencode', 'kimi', 'cursor-agent'] as const

export const DEFAULT_LAUNCHER_TIMEOUT_SECONDS = 7200

const DEFAULT_LAUNCHER_COMMANDS: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  kimi: 'kimi',
  'cursor-agent': 'agent'
}

const DEFAULT_LAUNCHER_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  kimi: 'Kimi Code',
  'cursor-agent': 'Cursor Agent'
}

export function defaultLauncherFor(actor: string): Launcher {
  const isCursorProfile = actor === 'cursor-agent' || actor.startsWith('cursor-agent-')
  return {
    command: isCursorProfile ? 'agent' : (DEFAULT_LAUNCHER_COMMANDS[actor] ?? actor),
    env: {},
    timeout_seconds: DEFAULT_LAUNCHER_TIMEOUT_SECONDS,
    backend: isCursorProfile ? 'cursor' : 'auto',
    display_name: isCursorProfile
      ? (actor === 'cursor-agent' ? 'Cursor Agent' : cursorProfileName(actor))
      : DEFAULT_LAUNCHER_NAMES[actor],
    ...(isCursorProfile
      ? {
          cursor: {
            mode: 'agent' as const,
            force: true,
            trust: true,
            approve_mcps: false,
            sandbox: 'default' as const,
            stream_partial_output: false,
            extra_args: []
          }
        }
      : {})
  }
}

export function normalizeLauncher(actor: string, launcher?: Partial<Launcher> | null): Launcher {
  const fallback = defaultLauncherFor(actor)
  const backend = launcher?.backend ?? fallback.backend
  const cursor = backend === 'cursor'
    ? {
        ...(fallback.cursor ?? {}),
        ...(launcher?.cursor ?? {}),
        extra_args: [...(launcher?.cursor?.extra_args ?? fallback.cursor?.extra_args ?? [])]
      }
    : launcher?.cursor
  return {
    command: typeof launcher?.command === 'string' && launcher.command.trim() !== '' ? launcher.command : fallback.command,
    env: launcher?.env ? { ...launcher.env } : { ...fallback.env },
    timeout_seconds:
      typeof launcher?.timeout_seconds === 'number'
        ? launcher.timeout_seconds
        : fallback.timeout_seconds,
    backend,
    display_name: nonEmpty(launcher?.display_name) ?? fallback.display_name,
    model: nonEmpty(launcher?.model),
    prompt_preset_id: nonEmpty(launcher?.prompt_preset_id),
    custom_prompt: nonEmpty(launcher?.custom_prompt),
    ...(cursor ? { cursor } : {})
  }
}

export function normalizeLaunchers(
  launchers?: Record<string, Partial<Launcher>> | null
): Record<string, Launcher> {
  const normalized: Record<string, Launcher> = {}

  for (const actor of DEFAULT_LAUNCHER_ORDER) {
    normalized[actor] = normalizeLauncher(actor, launchers?.[actor])
  }

  for (const [actor, launcher] of Object.entries(launchers ?? {})) {
    if (!normalized[actor]) {
      normalized[actor] = normalizeLauncher(actor, launcher)
    }
  }

  return normalized
}

export function normalizeGlobalSettings(settings?: GlobalSettings | null): GlobalSettings {
  return {
    protocol_version: settings?.protocol_version ?? '1',
    countdown_seconds: settings?.countdown_seconds ?? 30,
    max_rounds: settings?.max_rounds ?? 9999,
    max_consecutive_failures: settings?.max_consecutive_failures ?? 10,
    launchers: normalizeLaunchers(settings?.launchers),
    seed_claude_session_id: settings?.seed_claude_session_id ?? '',
    seed_codex_thread_id: settings?.seed_codex_thread_id ?? '',
    seed_opencode_session_id: settings?.seed_opencode_session_id ?? '',
    seed_kimi_session_id: settings?.seed_kimi_session_id ?? '',
    max_compact_retries: settings?.max_compact_retries ?? 3,
    auto_generate_commit_message: settings?.auto_generate_commit_message ?? true,
    system_notifications_enabled: settings?.system_notifications_enabled ?? true,
    max_upgrade_retries: settings?.max_upgrade_retries ?? 3,
    custom_prompt: settings?.custom_prompt ?? undefined,
    prompt_presets: normalizePromptPresets(settings?.prompt_presets)
  }
}

export function normalizePromptPresets(presets?: PromptPreset[] | null): PromptPreset[] {
  const seen = new Set<string>()
  const normalized: PromptPreset[] = []
  for (const preset of presets ?? []) {
    const id = nonEmpty(preset?.id)
    const name = nonEmpty(preset?.name)
    const prompt = nonEmpty(preset?.prompt)
    if (!id || !name || !prompt || seen.has(id)) continue
    seen.add(id)
    normalized.push({ id, name, prompt })
  }
  return normalized
}

function cursorProfileName(actor: string): string {
  const suffix = actor.slice('cursor-agent-'.length)
  return suffix ? `Cursor Agent ${suffix}` : 'Cursor Agent'
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
