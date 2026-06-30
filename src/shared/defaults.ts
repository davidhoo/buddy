import type { GlobalSettings, Launcher } from './types'

export const DEFAULT_LAUNCHER_ORDER = ['claude', 'codex', 'opencode', 'kimi'] as const

export const DEFAULT_LAUNCHER_TIMEOUT_SECONDS = 7200

const DEFAULT_LAUNCHER_COMMANDS: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  kimi: 'kimi'
}

export function defaultLauncherFor(actor: string): Launcher {
  return {
    command: DEFAULT_LAUNCHER_COMMANDS[actor] ?? actor,
    env: {},
    timeout_seconds: DEFAULT_LAUNCHER_TIMEOUT_SECONDS
  }
}

export function normalizeLauncher(actor: string, launcher?: Partial<Launcher> | null): Launcher {
  const fallback = defaultLauncherFor(actor)
  return {
    command: typeof launcher?.command === 'string' && launcher.command.trim() !== '' ? launcher.command : fallback.command,
    env: launcher?.env ? { ...launcher.env } : { ...fallback.env },
    timeout_seconds:
      typeof launcher?.timeout_seconds === 'number'
        ? launcher.timeout_seconds
        : fallback.timeout_seconds
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
    custom_prompt: settings?.custom_prompt ?? undefined
  }
}
