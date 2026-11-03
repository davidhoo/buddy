/**
 * JSONC lossless edits via VS Code jsonc-parser (modify / applyEdits).
 * Never parse → JSON.stringify whole files.
 */
import { applyEdits, modify, parse } from 'jsonc-parser'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'

export function parseJsonc<T = unknown>(text: string): T {
  const errors: { error: number; offset: number; length: number }[] = []
  const value = parse(text, errors, { allowTrailingComma: true }) as T
  if (errors.length) throw new Error(`JSONC parse error at offset ${errors[0].offset}`)
  return value
}

export async function readJsoncObject(path: string): Promise<{ text: string; value: Record<string, unknown> }> {
  const text = await readFile(path, 'utf8')
  const value = parseJsonc<Record<string, unknown>>(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected object`)
  return { text, value }
}

/** Set `mcpServers.<name>` (or create mcpServers) while keeping comments. */
export function setMcpServerInJsonc(text: string, name: string, server: Record<string, unknown>): string {
  const edits = modify(text, ['mcpServers', name], server, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
    isArrayInsertion: false
  })
  return applyEdits(text, edits)
}

export function deleteMcpServerInJsonc(text: string, name: string): string {
  const edits = modify(text, ['mcpServers', name], undefined, {
    formattingOptions: { tabSize: 2, insertSpaces: true }
  })
  return applyEdits(text, edits)
}

export function listMcpServersFromJsonc(value: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const raw = value.mcpServers
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) out[name] = entry as Record<string, unknown>
  }
  return out
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

export async function writeMcpServerJsonc(path: string, name: string, server: Record<string, unknown>): Promise<void> {
  let text = '{}'
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!text.trim()) text = '{\n}\n'
  await atomicWriteText(path, setMcpServerInJsonc(text, name, server))
}

export async function removeMcpServerJsonc(path: string, name: string): Promise<void> {
  const text = await readFile(path, 'utf8')
  await atomicWriteText(path, deleteMcpServerInJsonc(text, name))
}
