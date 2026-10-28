import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ExtensionActionResult, LibraryData, LibraryItem } from '../../../shared/extensions'
import { FEATURED_SKILLS, catalogRepositoryKey, findFeaturedSkill } from '../../../shared/skill-catalog'
import { extensionPaths, writeLibrary } from './library-store'

export { FEATURED_SKILLS, findFeaturedSkill }

/** Materialize a built-in curated skill into the library. Does not assign agents. */
export async function installFeaturedSkill(
  dataRoot: string,
  data: LibraryData,
  catalogId: string
): Promise<ExtensionActionResult> {
  const entry = findFeaturedSkill(catalogId)
  if (!entry) {
    return { accepted: false, code: 'missing_target', results: [{ actor: '', status: 'failed', code: 'not_found', libraryItemId: null }] }
  }
  if (!entry.files['SKILL.md']) {
    return { accepted: false, code: 'missing_target', results: [{ actor: '', status: 'failed', code: 'missing_skill', libraryItemId: null }] }
  }
  const key = catalogRepositoryKey(entry.id)
  const existing = data.items.find((item) => item.kind === 'skill' && item.repository === key)
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
    kind: 'skill',
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
  const dest = join(paths.contentDir, 'skills', item.id)
  await mkdir(dest, { recursive: true })
  for (const [rel, body] of Object.entries(entry.files)) {
    if (!rel || rel.includes('\0') || rel.startsWith('/') || rel.includes('..')) {
      await rmSkillDir(dest)
      return { accepted: false, code: 'missing_target', results: [{ actor: '', status: 'failed', code: 'unsupported', libraryItemId: null }] }
    }
    const target = join(dest, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body.endsWith('\n') ? body : `${body}\n`, 'utf8')
  }
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

async function rmSkillDir(dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true }).catch(() => undefined)
}
