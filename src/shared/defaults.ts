import type { GlobalSettings, Launcher } from './types'

export const DEFAULT_LAUNCHER_ORDER = ['claude', 'codex'] as const

export const DEFAULT_LAUNCHER_TIMEOUT_SECONDS = 7200

const DEFAULT_LAUNCHER_COMMANDS: Record<string, string> = {
  claude: 'claude',
  codex: 'codex'
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
    command: typeof launcher?.command === 'string' ? launcher.command : fallback.command,
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
    max_rounds: settings?.max_rounds ?? 10,
    max_consecutive_failures: settings?.max_consecutive_failures ?? 3,
    launchers: normalizeLaunchers(settings?.launchers),
    seed_claude_session_id: settings?.seed_claude_session_id ?? '',
    seed_codex_thread_id: settings?.seed_codex_thread_id ?? ''
  }
}
