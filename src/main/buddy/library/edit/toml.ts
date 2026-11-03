/**
 * TOML local table editor modeled on Magpie internal/edit TOML semantics (MIT).
 * Replaces / deletes ordinary tables like [mcp_servers.name] as units while
 * leaving every other line (comments, unknown keys, other tables) untouched.
 * Do NOT use parse→stringify libraries that drop comments.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type TomlScalar = string | number | boolean

interface TableSpan {
  name: string
  /** Inclusive start line index. */
  from: number
  /** Exclusive end line index. */
  to: number
}

function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function joinLines(lines: string[]): string {
  return lines.length ? `${lines.join('\n')}\n` : ''
}

/** Parse header like `[mcp_servers.foo]` or `[ mcp_servers . "bar" ]` → dotted name. */
function parseHeader(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('[') || trimmed.startsWith('[[') || !trimmed.endsWith(']')) return null
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return null
  const parts: string[] = []
  let i = 0
  while (i < inner.length) {
    while (i < inner.length && /\s/.test(inner[i])) i++
    if (i >= inner.length) break
    if (inner[i] === '"' || inner[i] === "'") {
      const q = inner[i++]
      let value = ''
      while (i < inner.length && inner[i] !== q) {
        if (inner[i] === '\\' && i + 1 < inner.length) {
          value += inner[i + 1]
          i += 2
          continue
        }
        value += inner[i++]
      }
      if (inner[i] === q) i++
      parts.push(value)
    } else {
      let start = i
      while (i < inner.length && inner[i] !== '.' && !/\s/.test(inner[i])) i++
      parts.push(inner.slice(start, i))
    }
    while (i < inner.length && /\s/.test(inner[i])) i++
    if (inner[i] === '.') i++
  }
  return parts.filter(Boolean).join('.')
}

function findTables(lines: string[]): TableSpan[] {
  const headers: { name: string; from: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    const name = parseHeader(lines[i])
    if (name) headers.push({ name, from: i })
  }
  return headers.map((h, index) => ({
    name: h.name,
    from: h.from,
    to: index + 1 < headers.length ? headers[index + 1].from : lines.length
  }))
}

function findTable(lines: string[], name: string): TableSpan | undefined {
  return findTables(lines).find((t) => t.name === name)
}

function quoteKey(part: string): string {
  return /^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part)
}

function headerLine(name: string): string {
  return `[${name.split('.').map(quoteKey).join('.')}]`
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `[${value.map(formatValue).join(', ')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${quoteKey(k)} = ${formatValue(v)}`)
      .join(', ')
    return `{ ${entries} }`
  }
  return JSON.stringify(String(value))
}

function renderTable(name: string, kvs: Record<string, unknown>): string[] {
  const lines = [headerLine(name)]
  for (const [key, value] of Object.entries(kvs)) {
    if (value === undefined) continue
    lines.push(`${quoteKey(key)} = ${formatValue(value)}`)
  }
  return lines
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

export async function readTomlText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/** List `[mcp_servers.<name>]` ordinary tables. */
export function listMcpServerTables(text: string): string[] {
  const lines = splitLines(text)
  return findTables(lines)
    .map((t) => t.name)
    .filter((name) => name.startsWith('mcp_servers.') && !name.slice('mcp_servers.'.length).includes('.'))
    .map((name) => name.slice('mcp_servers.'.length))
}

/** Best-effort scalar extraction for discovery (ignores inline tables/arrays depth). */
export function getMcpServerTable(text: string, name: string): Record<string, unknown> | undefined {
  const lines = splitLines(text)
  const table = findTable(lines, `mcp_servers.${name}`)
  if (!table) return undefined
  const out: Record<string, unknown> = {}
  for (let i = table.from + 1; i < table.to; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line)
    if (!m) continue
    const raw = m[2].trim()
    if (raw.startsWith('"') || raw.startsWith("'")) {
      try {
        out[m[1]] = JSON.parse(raw.startsWith("'") ? `"${raw.slice(1, -1)}"` : raw)
      } catch {
        out[m[1]] = raw.slice(1, -1)
      }
    } else if (raw === 'true' || raw === 'false') out[m[1]] = raw === 'true'
    else if (/^-?\d+(\.\d+)?$/.test(raw)) out[m[1]] = Number(raw)
    else if (raw.startsWith('[')) {
      try {
        out[m[1]] = JSON.parse(raw.replace(/'/g, '"'))
      } catch {
        out[m[1]] = raw
      }
    } else out[m[1]] = raw
  }
  return out
}

export async function setMcpServerToml(path: string, name: string, kvs: Record<string, unknown>): Promise<void> {
  const text = await readTomlText(path)
  const lines = splitLines(text)
  const tableName = `mcp_servers.${name}`
  // Also drop child tables like mcp_servers.name.env that Magpie clears.
  const tables = findTables(lines)
  const keep: string[] = []
  let i = 0
  while (i < lines.length) {
    const at = tables.find((t) => t.from === i)
    if (at && (at.name === tableName || at.name.startsWith(`${tableName}.`))) {
      i = at.to
      continue
    }
    keep.push(lines[i])
    i++
  }
  while (keep.length && keep[keep.length - 1].trim() === '') keep.pop()
  if (keep.length) keep.push('')
  keep.push(...renderTable(tableName, kvs))
  await atomicWrite(path, joinLines(keep))
}

export async function deleteMcpServerToml(path: string, name: string): Promise<void> {
  const text = await readTomlText(path)
  const lines = splitLines(text)
  const tableName = `mcp_servers.${name}`
  const tables = findTables(lines)
  const keep: string[] = []
  let i = 0
  while (i < lines.length) {
    const at = tables.find((t) => t.from === i)
    if (at && (at.name === tableName || at.name.startsWith(`${tableName}.`))) {
      i = at.to
      continue
    }
    keep.push(lines[i])
    i++
  }
  await atomicWrite(path, joinLines(keep))
}
