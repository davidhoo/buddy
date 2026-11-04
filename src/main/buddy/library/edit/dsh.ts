import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'
import { toCanonical } from '../convert'

async function document(path: string) {
  const text = await readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '[]\n'
    throw error
  })
  const doc = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (doc.errors.length || !isSeq(doc.contents)) throw new Error('Unsupported dsh patch document')
  return doc
}

export async function readDshServers(path: string): Promise<Array<{ name: string; raw: Record<string, unknown> }>> {
  const doc = await document(path)
  const out: Array<{ name: string; raw: Record<string, unknown> }> = []
  for (const patch of (doc.contents as import('yaml').YAMLSeq).items) {
    if (!isMap(patch)) continue
    const insert = patch.get('insert', true)
    if (!isSeq(insert)) continue
    for (const entry of insert.items) {
      if (!isMap(entry) || entry.get('name') !== '@deepseek-ai/dsh-mcp-client') continue
      const config = entry.get('config', true)
      if (!isMap(config)) continue
      const raw = config.toJSON() as Record<string, unknown>
      if (typeof raw.serverName !== 'string') continue
      const { serverName, ...connection } = raw
      out.push({ name: serverName, raw: connection })
    }
  }
  return out
}

export async function writeDshServer(path: string, name: string, raw?: Record<string, unknown>): Promise<void> {
  const doc = await document(path)
  const patches = doc.contents as import('yaml').YAMLSeq
  const id = `buddy-mcp-${name}`
  for (const patch of patches.items) {
    if (!isMap(patch)) continue
    const insert = patch.get('insert', true)
    if (!isSeq(insert)) continue
    for (let i = insert.items.length - 1; i >= 0; i--) {
      const entry = insert.items[i]
      if (!isMap(entry) || entry.get('name') !== '@deepseek-ai/dsh-mcp-client') continue
      const config = entry.get('config', true)
      if (!isMap(config) || config.get('serverName') !== name) continue
      if (entry.get('id') !== id) throw new Error('Existing dsh MCP entry is not managed by Buddy')
      insert.items.splice(i, 1)
    }
  }
  if (raw) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error('dsh MCP names require 1–32 letters, digits, hyphens or underscores')
    const canonical = toCanonical(raw)
    if (canonical.transport === 'sse') throw new Error('dsh does not support SSE MCP')
    const { transport, ...connection } = canonical
    patches.add(doc.createNode({ insert: [{ id, name: '@deepseek-ai/dsh-mcp-client', config: {
      serverName: name, ...connection, transport: transport === 'http' ? 'streamable-http' : 'stdio',
      ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {})
    } }] }))
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(`${path}.tmp`, doc.toString(), 'utf8')
  await rename(`${path}.tmp`, path)
}
