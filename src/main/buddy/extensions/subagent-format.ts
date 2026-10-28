import { createHash } from 'node:crypto'
import type { ExtensionAdapter } from '../../../shared/extensions'

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/
const RESERVED = new Set(['self', 'system', 'user', 'model', 'tool', 'config', 'default', 'main'])

export interface SubagentSpec {
  name: string
  description: string
  prompt: string
}

export function validateSubagentName(name: string): string | null {
  if (!NAME_RE.test(name)) return 'unsupported'
  if (RESERVED.has(name)) return 'unsupported'
  return null
}

export function parseSubagentLibrary(text: string): SubagentSpec | null {
  const normalized = text.replace(/\r\n/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return null
  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const key = line.slice(0, i).trim()
    let value = line.slice(i + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      try {
        value = JSON.parse(value.startsWith("'") ? `"${value.slice(1, -1).replace(/"/g, '\\"')}"` : value) as string
      } catch {
        value = value.slice(1, -1)
      }
    }
    fields[key] = value
  }
  const name = fields.name?.trim() ?? ''
  const description = fields.description?.trim() ?? ''
  const prompt = match[2].replace(/^\n+/, '').replace(/\n+$/, '')
  if (!name || !description || !prompt) return null
  return { name, description, prompt }
}

export function serializeSubagentLibrary(spec: SubagentSpec): string {
  return `---\nname: ${yamlScalar(spec.name)}\ndescription: ${yamlScalar(spec.description)}\n---\n\n${spec.prompt.replace(/\n+$/, '')}\n`
}

export function renderSubagentNative(adapter: ExtensionAdapter, spec: SubagentSpec): { fileName: string; body: string } | null {
  if (adapter === 'claude') {
    return {
      fileName: `${spec.name}.md`,
      body: `---\nname: ${yamlScalar(spec.name)}\ndescription: ${yamlScalar(spec.description)}\n---\n\n${spec.prompt.replace(/\n+$/, '')}\n`
    }
  }
  if (adapter === 'opencode') {
    return {
      fileName: `${spec.name}.md`,
      body: `---\ndescription: ${yamlScalar(spec.description)}\nmode: subagent\n---\n\n${spec.prompt.replace(/\n+$/, '')}\n`
    }
  }
  if (adapter === 'codex') {
    return {
      fileName: `${spec.name}.toml`,
      body: [
        `name = ${tomlString(spec.name)}`,
        `description = ${tomlString(spec.description)}`,
        `developer_instructions = ${tomlMultiline(spec.prompt)}`,
        ''
      ].join('\n')
    }
  }
  return null
}

export function contentHash(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

function yamlScalar(value: string): string {
  return JSON.stringify(value)
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlMultiline(value: string): string {
  const body = value.replace(/\n+$/, '') + '\n'
  if (body.includes('"""')) {
    return JSON.stringify(body)
  }
  return `"""\n${body}"""`
}
