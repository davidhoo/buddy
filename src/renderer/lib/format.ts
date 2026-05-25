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

/** Decode \\uXXXX Unicode escape sequences (e.g. \\u7f51\\u7edc → 网络错误) */
export function decodeUnicodeEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  )
}

/** Unescape JSON string escapes: \\", \\\\, \\n, \\t, \\r, \\uXXXX, etc. */
function unescapeJsonString(text: string): string {
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
        const prefix = unescapeJsonString(text.slice(0, start)).trim()
        return prefix ? `${prefix}\n${formatted}` : formatted
      } catch { /* JSON parse failed */ }
    }
  }

  // No JSON found, unescape all JSON string escapes
  return unescapeJsonString(text)
}

export function formatTime(value: string | undefined | null): string {
  if (!value) return '-'
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}
