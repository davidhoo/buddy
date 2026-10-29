import { realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { LibraryItem, ResolvedTarget } from '../../../shared/extensions'

/** A native shared folder is visible independently of library assignment. */
export async function sharedSkillPath(item: LibraryItem, target: ResolvedTarget): Promise<string | null> {
  const source = item.libraryPath || item.externalPath
  if (!source || item.kind !== 'skill') return null
  const expected = await realpath(source).catch(() => null)
  if (!expected) return null
  const name = basename(item.repository ? item.name : item.originPath)
  if (!name || name === '.' || name === '..') return null
  for (const root of target.locations.filter(l => l.kind === 'skills' && l.scope === 'shared' && !l.error)) {
    const path = join(root.path, name)
    if (await realpath(path).catch(() => null) === expected) return path
  }
  return null
}
