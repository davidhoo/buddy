import { redactSensitiveText } from '../redact'

export interface SkillFrontmatter {
  name?: string
  description?: string
}

export interface McpEntry {
  name: string
  command: string | null
  args: string[]
  url: string | null
  envKeys: string[]
}

/** Read the leading YAML block. Unknown fields stay unread; this is not a general YAML writer. */
export function readSkillFrontmatter(markdown: string): SkillFrontmatter {
  const text = markdown.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return {}
  const end = text.slice(3).search(/\r?\n---\s*(?:\r?\n|$)/)
  if (end < 0) return {}
  const block = text.slice(3, end + 3).replace(/^\r?\n/, '')
  const name = scalar(block, 'name')
  const description = scalar(block, 'description')
  return {
    name: name ? oneLine(name, 120) : undefined,
    description: description ? oneLine(description, 240) : undefined
  }
}

export function mcpServersFromJson(text: string, keys: string[]): { entries: McpEntry[]; invalid: boolean } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return { entries: [], invalid: true }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { entries: [], invalid: true }
  const record = parsed as Record<string, unknown>
  let block: unknown
  let sawKey = false
  for (const key of keys) {
    if (key in record) {
      block = record[key]
      sawKey = true
      break
    }
  }
  if (!sawKey) return { entries: [], invalid: false }
  return entriesFromBlock(block)
}

export function mcpServersFromToml(text: string): { entries: McpEntry[]; invalid: boolean } {
  const found = new Map<string, McpEntry>()
  let section: string | null = null
  let invalid = false
  for (const raw of joinTomlLines(text)) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const header = trimmed.match(/^\[mcp_servers(?:\.([^.\]]+))?(?:\.[^\]]+)?\]$/)
    if (header) {
      section = header[1] ?? ''
      if (section) ensure(found, section)
      continue
    }
    if (trimmed.startsWith('[')) {
      section = null
      continue
    }
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/)
    if (!kv) continue
    const [, key, rawValue] = kv
    if (section === null) {
      const rooted = key.match(/^mcp_servers\.([A-Za-z0-9_-]+)\.(command|url|args)$/)
      if (!rooted) continue
      if (!assignMcpField(ensure(found, rooted[1]), rooted[2], rawValue)) invalid = true
      continue
    }
    if (section === '') {
      const nested = key.match(/^([A-Za-z0-9_-]+)\.(command|url|args)$/)
      if (!nested) continue
      const entry = ensure(found, nested[1])
      if (!assignMcpField(entry, nested[2], rawValue)) invalid = true
      continue
    }
    if (key === 'command' || key === 'url' || key === 'args') {
      if (!assignMcpField(ensure(found, section), key, rawValue)) invalid = true
    }
  }
  const mentionsServer = text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim()
    return trimmed.length > 0 && !trimmed.startsWith('#') && trimmed.includes('mcp_servers')
  })
  const hasSection = /^\[mcp_servers(?:\.[^\]]+)?\]/m.test(text)
  if (mentionsServer && !hasSection && found.size === 0) invalid = true
  return { entries: [...found.values()], invalid }
}

function entriesFromBlock(block: unknown): { entries: McpEntry[]; invalid: boolean } {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return { entries: [], invalid: true }
  const entries: McpEntry[] = []
  for (const [name, value] of Object.entries(block)) {
    if (!name.trim()) continue
    const entry: McpEntry = { name, command: null, args: [], url: null, envKeys: [] }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      entry.command = publicCommand(record.command)
      entry.args = publicArgs(record.args)
      entry.url = typeof record.url === 'string' ? redactSensitiveText(record.url).slice(0, 500) : null
      if (record.env && typeof record.env === 'object' && !Array.isArray(record.env)) {
        entry.envKeys = Object.keys(record.env as Record<string, unknown>).sort()
      }
    }
    entries.push(entry)
  }
  return { entries, invalid: false }
}

function ensure(found: Map<string, McpEntry>, name: string): McpEntry {
  const existing = found.get(name)
  if (existing) return existing
  const created: McpEntry = { name, command: null, args: [], url: null, envKeys: [] }
  found.set(name, created)
  return created
}

function assignMcpField(entry: McpEntry, key: string, rawValue: string): boolean {
  if (key === 'command') entry.command = redactSensitiveText(unquote(rawValue)).slice(0, 500)
  else if (key === 'url') entry.url = redactSensitiveText(unquote(rawValue)).slice(0, 500)
  else if (key === 'args') {
    const parsed = argsFromToml(rawValue)
    entry.args = parsed.args
    return parsed.ok
  }
  return true
}

function argsFromToml(rawValue: string): { args: string[]; ok: boolean } {
  const trimmed = stripTomlComment(rawValue).trim()
  if (!trimmed.startsWith('[')) {
    const single = unquote(trimmed)
    return { args: single ? [redactSensitiveText(single).slice(0, 200)] : [], ok: true }
  }
  const parsed = parseTomlStringArray(trimmed)
  if (!parsed) return { args: [], ok: false }
  return { args: publicArgs(parsed), ok: true }
}

/** Join physical lines while an array or a quoted string is still open. */
function joinTomlLines(text: string): string[] {
  const logical: string[] = []
  let buffer = ''
  let depth = 0
  let quote: '"' | "'" | null = null
  for (const line of text.split(/\r?\n/)) {
    if (!buffer && depth === 0 && quote === null) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) {
        logical.push(line)
        continue
      }
    }
    buffer = buffer ? `${buffer} ${line.trim()}` : line
    const state = scanTomlLine(line, quote)
    quote = state.quote
    depth += state.depth
    if (depth < 0) depth = 0
    if (depth === 0 && quote === null) {
      logical.push(buffer)
      buffer = ''
    }
  }
  if (buffer) logical.push(buffer)
  return logical
}

function scanTomlLine(line: string, quote: '"' | "'" | null): { quote: '"' | "'" | null; depth: number } {
  let depth = 0
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (quote === '"' && char === '\\') {
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#') break
    if (char === '[') depth += 1
    else if (char === ']') depth -= 1
  }
  return { quote, depth }
}

function parseTomlStringArray(text: string): string[] | null {
  let index = 0
  const skip = () => {
    while (index < text.length) {
      const char = text[index]
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
        index += 1
        continue
      }
      if (char === '#') {
        while (index < text.length && text[index] !== '\n') index += 1
        continue
      }
      break
    }
  }
  skip()
  if (text[index] !== '[') return null
  index += 1
  const items: string[] = []
  skip()
  if (text[index] === ']') return items
  while (index < text.length) {
    skip()
    if (text[index] === ']') return items
    const value = readTomlScalar(text, index)
    if (!value) return null
    items.push(value.value)
    index = value.next
    skip()
    if (text[index] === ',') {
      index += 1
      continue
    }
    if (text[index] === ']') return items
    return null
  }
  return null
}

function readTomlScalar(text: string, start: number): { value: string; next: number } | null {
  const quote = text[start]
  if (quote === '"' || quote === "'") {
    let value = ''
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index]
      if (quote === '"' && char === '\\') {
        const next = text[index + 1]
        if (next === undefined) return null
        const escaped: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" }
        value += escaped[next] ?? next
        index += 1
        continue
      }
      if (char === quote) return { value, next: index + 1 }
      value += char
    }
    return null
  }
  let index = start
  while (index < text.length && text[index] !== ',' && text[index] !== ']' && text[index] !== '#' && !/\s/.test(text[index])) index += 1
  if (index === start) return null
  return { value: text.slice(start, index), next: index }
}

function stripTomlComment(value: string): string {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote) {
      if (quote === '"' && char === '\\') {
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#') return value.slice(0, index)
  }
  return value
}

function publicCommand(value: unknown): string | null {
  if (typeof value === 'string') return redactSensitiveText(value).slice(0, 500)
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === 'string').map((item) => redactSensitiveText(item))
    return parts.length ? parts.join(' ').slice(0, 500) : null
  }
  return null
}

function publicArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => redactSensitiveText(item).slice(0, 200))
}

function unquote(value: string): string {
  const trimmed = stripTomlComment(value).trim()
  const scalar = readTomlScalar(trimmed, 0)
  if (scalar && (trimmed[0] === '"' || trimmed[0] === "'") && scalar.next >= trimmed.length) return scalar.value
  return trimmed
}

function scalar(block: string, key: string): string | undefined {
  const lines = block.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(new RegExp(`^${key}:\\s*(.*)$`))
    if (!match) continue
    const raw = match[1].trim()
    if (raw === '>' || raw === '|' || raw === '>-' || raw === '|-') {
      const folded: string[] = []
      for (let next = index + 1; next < lines.length; next += 1) {
        if (!/^\s+/.test(lines[next])) break
        folded.push(lines[next].trim())
      }
      return folded.join(raw.startsWith('|') ? '\n' : ' ').trim()
    }
    return raw.replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

function oneLine(value: string, max: number): string {
  return redactSensitiveText(value.replace(/\s+/g, ' ').trim()).slice(0, max)
}
