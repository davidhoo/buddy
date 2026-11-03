import { mkdir, readlink, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DiscoveredSkill, LibraryOpResult, LibrarySkillRecord, LibraryTarget } from '../../../shared/library'
import {
  hashTree,
  isGitRoot,
  LibraryStore,
  moveDir,
  pathKind,
  replaceWithSymlink,
  upsertSkill
} from './store'

function skillLibraryPath(store: LibraryStore, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill'
  return join(store.skillsDir(), safe)
}

export async function importDiscoveredSkill(
  store: LibraryStore,
  discovered: DiscoveredSkill,
  targets: LibraryTarget[]
): Promise<LibraryOpResult> {
  const meta = await store.readMeta()
  if (meta.skills.some((s) => s.name === discovered.name && s.managed)) {
    return { status: 'exists', name: discovered.name, message: 'already in library' }
  }
  if (discovered.isGitRoot || await isGitRoot(discovered.path)) {
    // External ref — do not mv a git root.
    const id = randomUUID()
    const record: LibrarySkillRecord = {
      id,
      name: discovered.name,
      description: discovered.description,
      libraryPath: discovered.path,
      sourceKind: 'external',
      originPath: discovered.path,
      assignedTargetIds: [discovered.targetId],
      importMode: 'external-ref',
      managed: true
    }
    await store.writeMeta(upsertSkill(meta, record))
    return { status: 'ok', id, name: discovered.name, message: 'imported as external reference (git root not moved)' }
  }
  if (discovered.isSymlink || (await pathKind(discovered.path)) === 'symlink') {
    let origin = discovered.path
    try {
      origin = await readlink(discovered.path)
    } catch { /* keep */ }
    const id = randomUUID()
    const record: LibrarySkillRecord = {
      id,
      name: discovered.name,
      description: discovered.description,
      libraryPath: discovered.physicalKey,
      sourceKind: 'external',
      originPath: origin,
      assignedTargetIds: [discovered.targetId],
      importMode: 'external-ref',
      managed: true
    }
    await store.writeMeta(upsertSkill(meta, record))
    return { status: 'ok', id, name: discovered.name, message: 'imported as external symlink reference' }
  }

  await store.backupTree(discovered.path, `import-${discovered.name}`)
  const dest = skillLibraryPath(store, discovered.name)
  if ((await pathKind(dest)) !== 'missing') {
    return { status: 'conflict', name: discovered.name, message: `library path exists: ${dest}` }
  }
  await mkdir(store.skillsDir(), { recursive: true })
  await moveDir(discovered.path, dest)
  try {
    await replaceWithSymlink(discovered.path, dest)
  } catch (error) {
    // Roll back move if link failed.
    await moveDir(dest, discovered.path)
    return { status: 'failed', name: discovered.name, message: `link failed: ${(error as Error).message}` }
  }

  const linked = new Set<string>([discovered.targetId])
  const sourceTarget = targets.find((t) => t.targetId === discovered.targetId)
  for (const id of sourceTarget?.linkedSkillTargetIds || []) linked.add(id)

  const id = randomUUID()
  const record: LibrarySkillRecord = {
    id,
    name: discovered.name,
    description: discovered.description,
    libraryPath: dest,
    sourceKind: 'migrated',
    originPath: discovered.path,
    contentHash: await hashTree(dest),
    assignedTargetIds: [...linked],
    importMode: 'migrate-link',
    managed: true
  }
  await store.writeMeta(upsertSkill(await store.readMeta(), record))
  return { status: 'ok', id, name: discovered.name, affectedTargetIds: [...linked] }
}

export async function assignSkillToTarget(
  store: LibraryStore,
  skillId: string,
  target: LibraryTarget,
  enabled: boolean
): Promise<LibraryOpResult> {
  if (!target.skillsDir) return { status: 'rejected', message: 'target has no skills dir' }
  if (target.pendingInit) return { status: 'rejected', message: 'target not initialized' }
  const meta = await store.readMeta()
  const skill = meta.skills.find((s) => s.id === skillId)
  if (!skill) return { status: 'failed', message: 'skill not found' }

  const affected = new Set<string>([target.targetId, ...(target.linkedSkillTargetIds || [])])
  const linkName = join(target.skillsDir, basename(skill.libraryPath))

  if (enabled) {
    if (skill.importMode === 'external-ref' || skill.importMode === 'shared-ref') {
      // Already lives where agents read it.
    } else {
      await mkdir(target.skillsDir, { recursive: true })
      const kind = await pathKind(linkName)
      if (kind === 'missing') await replaceWithSymlink(linkName, skill.libraryPath)
      else if (kind === 'symlink') await replaceWithSymlink(linkName, skill.libraryPath)
      else return { status: 'conflict', name: skill.name, message: `blocked by existing path ${linkName}` }
    }
    skill.assignedTargetIds = [...new Set([...skill.assignedTargetIds, ...affected])]
  } else {
    // Only remove managed symlinks pointing at library path.
    for (const targetId of affected) {
      const t = target.targetId === targetId ? target : undefined
      const dir = t?.skillsDir || target.skillsDir
      const path = join(dir!, basename(skill.libraryPath))
      try {
        const link = await readlink(path)
        if (link === skill.libraryPath || link.endsWith(basename(skill.libraryPath))) {
          await rm(path, { force: true })
        }
      } catch { /* not our link */ }
    }
    skill.assignedTargetIds = skill.assignedTargetIds.filter((id) => !affected.has(id))
  }
  await store.writeMeta(upsertSkill(meta, skill))
  return { status: 'ok', id: skill.id, name: skill.name, affectedTargetIds: [...affected] }
}

/** Eject: move library dir back over the managed symlink at originPath. */
export async function ejectSkill(store: LibraryStore, skillId: string): Promise<LibraryOpResult> {
  const meta = await store.readMeta()
  const skill = meta.skills.find((s) => s.id === skillId)
  if (!skill) return { status: 'failed', message: 'skill not found' }
  if (skill.importMode !== 'migrate-link') {
    meta.skills = meta.skills.filter((s) => s.id !== skillId)
    await store.writeMeta(meta)
    return { status: 'ok', id: skillId, name: skill.name, message: 'unmanaged reference removed from library metadata' }
  }
  const origin = skill.originPath
  if (!origin) return { status: 'failed', name: skill.name, message: 'missing origin path' }

  await store.backupTree(skill.libraryPath, `eject-${skill.name}`)
  const originKind = await pathKind(origin)
  if (originKind === 'symlink') {
    await rm(origin, { force: true })
  } else if (originKind !== 'missing') {
    return { status: 'conflict', name: skill.name, message: `origin is not a managed symlink: ${origin}` }
  }
  await moveDir(skill.libraryPath, origin)
  meta.skills = meta.skills.filter((s) => s.id !== skillId)
  await store.writeMeta(meta)
  return { status: 'ok', id: skillId, name: skill.name, message: 'ejected to origin' }
}
