import { TaskSettings } from '../../shared/types'

export const ACTOR_TEXT: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  kimi: 'Kimi',
  human: '你',
  system: '系统'
}

export const ACTOR_DISPLAY_NAME: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  kimi: 'Kimi'
}

export type Actor = 'claude' | 'codex' | 'opencode' | 'kimi'

export function taskActors(settings: TaskSettings | null | undefined): {
  impl: Actor
  rev: Actor
  participants: Actor[]
} {
  const s = settings || ({} as TaskSettings)
  const impl = (s.implementer_actor as Actor) || (s.role_mode === 'codex_implements' ? 'codex' : 'claude')
  const rev = (s.reviewer_actor as Actor) || (s.role_mode === 'codex_implements' ? 'claude' : 'codex')
  return { impl, rev, participants: [impl, rev] }
}

export function shortId(value: string | undefined | null): string {
  if (!value) return ''
  return value.length > 20 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds <= 600) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}m${secs}s`
}

export function elapsedText(startedAt: string | undefined | null): string {
  if (!startedAt) return '-'
  const ms = Date.now() - new Date(startedAt).getTime()
  return formatDuration(Math.max(0, ms))
}

export function formatTime(value: string | undefined | null): string {
  if (!value) return '-'
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}
