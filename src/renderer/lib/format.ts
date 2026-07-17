import { Event, TaskSettings } from '../../shared/types'
import { Language, TranslationKey, localeTagFor, translate } from './i18n'

/**
 * Mapping of actor identifier → translation key for the short label.
 * Look up via i18n: `t(ACTOR_LABEL_KEY[actor])`.
 */
export const ACTOR_LABEL_KEY: Record<string, TranslationKey> = {
  claude: 'actor.claude',
  codex: 'actor.codex',
  opencode: 'actor.opencode',
  kimi: 'actor.kimi',
  cursor: 'actor.cursor',
  'cursor-agent': 'actor.cursor',
  human: 'actor.human',
  system: 'actor.system'
}

/**
 * Looks up the localized actor label.
 */
export function actorText(actor: string, lang: Language): string {
  const key = ACTOR_LABEL_KEY[actor]
  return key ? translate(lang, key) : actor
}

/**
 * Stable display names that are not translated (product/CLI names).
 */
export const ACTOR_DISPLAY_NAME: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  kimi: 'Kimi Code',
  cursor: 'Cursor Agent',
  'cursor-agent': 'Cursor Agent'
}

const EVENT_TYPE_KEY: Record<string, TranslationKey> = {
  'task.created': 'event.task.created',
  'task.done': 'event.task.done',
  'task.updated': 'event.task.updated',
  'actor.started': 'event.actor.started',
  'actor.completed': 'event.actor.completed',
  'actor.finished': 'event.actor.finished',
  'actor.failed': 'event.actor.failed',
  'actor.interrupted': 'event.actor.interrupted',
  'actor.stdout': 'event.actor.stdout',
  'actor.stderr': 'event.actor.stderr',
  'human.message': 'event.human.message',
  'countdown.paused': 'event.countdown.paused',
  'countdown.skipped': 'event.countdown.skipped',
  'break.pending': 'event.break.pending',
  'break.rejected': 'event.break.rejected',
  'round_window.paused': 'event.roundWindow.paused',
  'health_check.started': 'event.healthCheck.started',
  'health_check.actor_passed': 'event.healthCheck.actorPassed',
  'health_check.actor_failed': 'event.healthCheck.actorFailed',
  'health_check.passed': 'event.healthCheck.passed',
  'health_check.failed': 'event.healthCheck.failed',
  'health_check.actor_upgrade_retry': 'event.healthCheck.actorUpgradeRetry',
  'failure_threshold.reached': 'event.failureThreshold.reached',
  'permission.detected': 'event.permission.detected',
  'actor.context_limit_detected': 'event.actor.contextLimitDetected',
  'actor.session_reset': 'event.actor.sessionReset',
  'actor.summarize_succeeded': 'event.actor.summarizeSucceeded',
  'actor.summarize_failed': 'event.actor.summarizeFailed',
  'actor.summarize_skipped': 'event.actor.summarizeSkipped',
  'task.queued': 'event.task.queued',
  'queue.activated': 'event.queue.activated',
  'queue.blocked': 'event.queue.blocked',
  'queue.superseded': 'event.queue.superseded',
  'queue.reconciled': 'event.queue.reconciled'
}

export function eventTypeLabel(type: string, lang: Language): string {
  const key = EVENT_TYPE_KEY[type]
  return key ? translate(lang, key) : type
}

export type Actor = string

export function taskActors(settings: TaskSettings | null | undefined): {
  impl: Actor
  rev: Actor
  participants: Actor[]
} {
  const s = settings || ({} as TaskSettings)
  const impl = s.implementer_actor || (s.role_mode === 'codex_implements' ? 'codex' : 'claude')
  const rev = s.reviewer_actor || (s.role_mode === 'codex_implements' ? 'claude' : 'codex')
  return { impl, rev, participants: [impl, rev] }
}

export function actorDisplayName(actor: string, settings?: { launchers?: TaskSettings['launchers'] } | null): string {
  return settings?.launchers?.[actor]?.display_name?.trim()
    || ACTOR_DISPLAY_NAME[actor]
    || actor
}

export function actorBackend(actor: string, settings?: { launchers?: TaskSettings['launchers'] } | null): string {
  const configured = settings?.launchers?.[actor]?.backend
  if (configured && configured !== 'auto') return configured
  if (actor === 'cursor' || actor === 'cursor-agent' || actor.startsWith('cursor-agent-')) return 'cursor'
  return actor
}

export function actorColorVar(actor: string, settings?: { launchers?: TaskSettings['launchers'] } | null): string {
  const backend = actorBackend(actor, settings)
  return ['claude', 'codex', 'opencode', 'kimi', 'cursor'].includes(backend)
    ? `var(--actor-${backend})`
    : 'var(--fg-muted)'
}

export function shortId(value: string | undefined | null): string {
  if (!value) return ''
  return value.length > 20 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.floor(ms))}ms`
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (days > 0 || hours > 0) parts.push(`${hours}h`)
  if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join('')
}

export function elapsedText(startedAt: string | undefined | null): string {
  if (!startedAt) return '-'
  const ms = Date.now() - new Date(startedAt).getTime()
  return formatDuration(Math.max(0, ms))
}

/** Decode \\uXXXX Unicode escape sequences (e.g. \\u7f51\\u7edc → 网络错误) */
export function decodeUnicodeEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  )
}

/** Unescape JSON string escapes: \\", \\\\, \\n, \\t, \\r, \\uXXXX, etc. */
export function unescapeText(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|["\\/ntrbf])/g, (match, seq: string) => {
    if (seq.startsWith('u')) return String.fromCharCode(parseInt(seq.slice(1), 16))
    const map: Record<string, string> = {
      '"': '"', '\\': '\\', '/': '/',
      n: '\n', t: '\t', r: '\r', b: '\b', f: '\f'
    }
    return map[seq] ?? match
  })
}

/** Recursively decode \\uXXXX in all string values of a parsed JSON object */
function deepDecodeUnicode(obj: unknown): unknown {
  if (typeof obj === 'string') return decodeUnicodeEscapes(obj)
  if (Array.isArray(obj)) return obj.map(deepDecodeUnicode)
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = deepDecodeUnicode(value)
    }
    return result
  }
  return obj
}

/** Find the index of the matching closing brace for an opening brace at `start` */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (esc) { esc = false; continue }
    if (ch === '\\' && inStr) { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Recursively parse JSON string values into objects.
 * Only unwraps strings that parse to JSON objects (starting with `{`),
 * not arrays (which could be plain text with brackets).
 */
function deepParseJsonStrings(obj: unknown, depth = 0): unknown {
  if (depth > 10 || obj == null) return obj
  if (typeof obj === 'string') {
    const trimmed = obj.trimStart()
    if (trimmed[0] !== '{') return obj
    try {
      const inner = JSON.parse(obj)
      if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
        return deepParseJsonStrings(deepDecodeUnicode(inner), depth + 1)
      }
    } catch { /* not pure JSON, try extracting JSON portion */ }
    const s = obj.indexOf(trimmed[0])
    const e = findMatchingBrace(obj, s)
    if (e > s) {
      try {
        const inner = JSON.parse(obj.slice(s, e + 1))
        if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
          const trailing = obj.slice(e + 1).trim()
          if (!trailing) {
            return deepParseJsonStrings(deepDecodeUnicode(inner), depth + 1)
          }
          // Has trailing text — can't fully unwrap, return decoded string
          return obj
        }
      } catch { /* fall through */ }
    }
    return obj
  }
  if (Array.isArray(obj)) return obj.map(item => deepParseJsonStrings(deepDecodeUnicode(item), depth + 1))
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = deepParseJsonStrings(deepDecodeUnicode(value), depth + 1)
    }
    return result
  }
  return obj
}

/** Format a parsed value as readable indented key-value text */
function formatReadable(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  if (obj == null) return String(obj)
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj)
  if (typeof obj === 'string') return obj
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    return obj.map(item => pad + '- ' + formatReadable(item, indent + 1)).join('\n')
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    return entries.map(([key, value]) => {
      const isObj = value !== null && typeof value === 'object' && !Array.isArray(value)
      if (isObj) return pad + key + ':\n' + formatReadable(value, indent + 1)
      return pad + key + ': ' + formatReadable(value, indent + 1)
    }).join('\n')
  }
  return String(obj)
}

/**
 * Decode an error string for display.
 * - Parses JSON first (correctly handling \\" and \\\\uXXXX escapes)
 * - Preserves JSON structure as readable indented text
 * - Unwraps nested JSON object strings recursively
 * - Never shows \\" or \\uXXXX in the output
 */
export function decodeErrorText(text: string): string {
  // Try the whole text as JSON
  try {
    const obj = JSON.parse(text)
    const decoded = deepDecodeUnicode(obj)
    const expanded = deepParseJsonStrings(decoded)
    return formatReadable(expanded)
  } catch { /* not pure JSON */ }

  // Try finding a JSON portion after a prefix (e.g. "API Error: 400 {…}")
  const start = text.indexOf('{')
  if (start >= 0) {
    const end = findMatchingBrace(text, start)
    if (end > start) {
      try {
        const obj = JSON.parse(text.slice(start, end + 1))
        const decoded = deepDecodeUnicode(obj)
        const expanded = deepParseJsonStrings(decoded)
        const formatted = formatReadable(expanded)
        const prefix = unescapeText(text.slice(0, start)).trim()
        return prefix ? `${prefix}\n${formatted}` : formatted
      } catch { /* JSON parse failed */ }
    }
  }

  // No JSON found, unescape all JSON string escapes
  return unescapeText(text)
}

export function eventPayloadSummary(event: Event, lang?: Language): string {
  const payload = event.payload || {}
  const error = payload.error
  const textPayload = shouldSummarizeTextPayload(event.type) ? payload.text : undefined
  const value = error ?? textPayload ?? ''
  if (!value) return ''
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  const decoded = decodeErrorText(raw)
  if (decoded.length <= 1200) return decoded
  const tail =
    lang === 'en' ? '\n…(truncated)'
      : lang === 'zh-TW' ? '\n…（已截斷）'
        : '\n...（已截断）'
  return `${decoded.slice(0, 1200).trimEnd()}${tail}`
}

function shouldSummarizeTextPayload(type: string): boolean {
  return (
    type === 'actor.stderr' ||
    type === 'permission.detected' ||
    type.endsWith('.failed') ||
    type.endsWith('.error')
  )
}

export function formatTime(value: string | undefined | null, lang?: Language): string {
  if (!value) return '-'
  const locale = lang ? localeTagFor(lang) : undefined
  return new Date(value).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function formatTimeWithRelativeDate(value: string | undefined | null, lang?: Language): string {
  if (!value) return '-'
  const date = new Date(value)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.floor((today.getTime() - target.getTime()) / (24 * 60 * 60 * 1000))

  const time = date.toLocaleTimeString(lang ? localeTagFor(lang) : undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })

  if (diffDays <= 0) return time

  const relLabel =
    diffDays === 1 ? translate(lang ?? 'en', 'time.yesterday')
    : diffDays === 2 ? translate(lang ?? 'en', 'time.twoDaysAgo')
    : diffDays === 3 ? translate(lang ?? 'en', 'time.threeDaysAgo')
    : diffDays <= 6 ? translate(lang ?? 'en', 'time.daysAgo', { n: diffDays })
    : diffDays <= 13 ? translate(lang ?? 'en', 'time.lastWeek')
    : time

  if (typeof relLabel === 'string' && relLabel !== time) return `${relLabel} ${time}`
  return time
}
