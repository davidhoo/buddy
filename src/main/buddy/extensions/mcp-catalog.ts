import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExtensionActionResult, LibraryData, LibraryItem } from '../../../shared/extensions'
import { catalogRepositoryKey, findFeaturedMcp } from '../../../shared/mcp-catalog'
import { extensionPaths, writeLibrary } from './library-store'

/** Materialize a built-in curated MCP into the library. Does not assign agents. */
export async function installFeaturedMcp(
  dataRoot: string,
  data: LibraryData,
  catalogId: string
): Promise<ExtensionActionResult> {
  const entry = findFeaturedMcp(catalogId)
  if (!entry) {
    return { accepted: false, code: 'missing_target', results: [{ actor: '', status: 'failed', code: 'not_found', libraryItemId: null }] }
  }
  const key = catalogRepositoryKey(entry.id)
  const existing = data.items.find((item) => item.kind === 'mcp' && item.repository === key)
  if (existing) {
    return {
      accepted: true,
      code: 'ok',
      results: [{ actor: '', status: 'skipped', code: 'already', libraryItemId: existing.id }],
      name: existing.name
    }
  }
  const now = new Date().toISOString()
  const item: LibraryItem = {
    id: randomUUID(),
    kind: 'mcp',
    name: entry.name,
    description: entry.description,
    originActor: 'catalog',
    originPath: key,
    shareKey: null,
    repository: key,
    pluginId: null,
    version: entry.version,
    contentHash: null,
    libraryPath: null,
    externalPath: null,
    createdAt: now,
    updatedAt: now
  }
  const paths = extensionPaths(dataRoot)
  const dest = join(paths.contentDir, 'mcp', `${item.id}.json`)
  await mkdir(join(paths.contentDir, 'mcp'), { recursive: true })
  const saved = {
    kind: 'mcp' as const,
    format: 'json' as const,
    serverName: entry.name,
    server: {
      command: entry.server.command,
      ...(entry.server.args ? { args: entry.server.args } : {}),
      ...(entry.server.env ? { env: entry.server.env } : {})
    }
  }
  await writeFile(dest, `${JSON.stringify(saved, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  item.libraryPath = dest
  data.items.push(item)
  data.records.push({
    id: randomUUID(),
    at: now,
    action: 'save',
    libraryItemId: item.id,
    summary: `catalog:${entry.id}`,
    results: [{ actor: '', status: 'changed', message: 'installed' }]
  })
  data.records = data.records.slice(-100)
  await writeLibrary(dataRoot, data)
  return {
    accepted: true,
    code: 'ok',
    results: [{ actor: '', status: 'changed', code: 'installed', libraryItemId: item.id }],
    name: item.name
  }
}
