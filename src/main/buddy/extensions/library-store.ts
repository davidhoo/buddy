import { lstat, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { DiscoveredInstance, LibraryData, LibrarySnapshot } from '../../../shared/extensions'
import { atomicWriteJson } from '../store'
import { extensionLibraryPreferencesSchema } from '../schemas'

const itemSchema = z.object({
  repositoryPath: z.string().optional(),
  repositoryRef: z.string().optional(),
  treeHash: z.string().optional(),
  updateAvailable: z.string().nullable().optional(),
  locallyEdited: z.boolean().optional(),
  id: z.string().min(1),
  kind: z.enum(['skill', 'mcp', 'instruction', 'hook', 'subagent']),
  name: z.string(),
  description: z.string().default(''),
  originActor: z.string().default(''),
  originPath: z.string().default(''),
  shareKey: z.string().nullable().default(null),
  repository: z.string().nullable().default(null),
  pluginId: z.string().nullable().default(null),
  version: z.string().nullable().default(null),
  contentHash: z.string().nullable().default(null),
  libraryPath: z.string().nullable().default(null),
  externalPath: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string()
}).passthrough()

const bindingSchema = z.object({
  id: z.string().min(1),
  libraryItemId: z.string(),
  actor: z.string(),
  targetFingerprint: z.string(),
  scope: z.enum(['user', 'project']),
  nativePath: z.string().nullable().default(null),
  nativeId: z.string().nullable().default(null),
  desired: z.enum(['on', 'off']),
  observed: z.string().default(''),
  appliedVersion: z.string().nullable().default(null),
  appliedEntry: z.string().nullable().default(null),
  shareKey: z.string().nullable().default(null),
  management: z.enum(['link', 'copy', 'reference', 'none'])
}).passthrough()

const recordSchema = z.object({
  id: z.string().min(1),
  at: z.string(),
  action: z.string(),
  libraryItemId: z.string().nullable().default(null),
  summary: z.string().default(''),
  results: z.array(z.object({
    actor: z.string(),
    status: z.enum(['changed', 'skipped', 'failed']),
    message: z.string()
  })).default([])
}).passthrough()

const fileSchema = extensionLibraryPreferencesSchema.extend({
  version: z.literal(1),
  items: z.array(itemSchema),
  bindings: z.array(bindingSchema),
  records: z.array(recordSchema)
}).passthrough()

export function extensionPaths(dataRoot: string): { dir: string; file: string; contentDir: string; backupDir: string } {
  const dir = join(dataRoot, 'extensions')
  return {
    dir,
    file: join(dir, 'library.json'),
    contentDir: join(dir, 'content'),
    backupDir: join(dir, 'backups')
  }
}

/** Read does not create the library. A missing file is an empty library, not a failed read. */
export async function readLibrary(dataRoot: string): Promise<LibrarySnapshot> {
  const paths = extensionPaths(dataRoot)
  const base = { ...paths, items: [], bindings: [], records: [], version: 1 as const }
  try {
    await lstat(paths.file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ...base, status: 'absent' }
    return { ...base, status: 'read_failed' }
  }
  try {
    const parsed = fileSchema.parse(JSON.parse(await readFile(paths.file, 'utf8')))
    // Old libraries recorded mode on bindings only. Preserve those copy choices.
    const modes = { ...parsed.skillAgentModes }
    if (!parsed.skillDefaultMode) for (const binding of parsed.bindings) {
      if (binding.management === 'copy' && !(binding.actor in modes)) modes[binding.actor] = 'copy'
    }
    return {
      ...base,
      ...parsed,
      skillDefaultMode: parsed.skillDefaultMode,
      skillAgentModes: modes,
      version: 1,
      status: parsed.items.length ? 'ok' : 'empty'
    }
  } catch {
    return { ...base, status: 'read_failed' }
  }
}

export async function writeLibrary(dataRoot: string, data: LibraryData): Promise<void> {
  const paths = extensionPaths(dataRoot)
  await atomicWriteJson(paths.file, data)
}

export async function ensureLibraryDirs(dataRoot: string): Promise<{ dir: string; contentDir: string; backupDir: string; backupCount: number }> {
  const paths = extensionPaths(dataRoot)
  await mkdir(paths.contentDir, { recursive: true })
  await mkdir(paths.backupDir, { recursive: true })
  let backupCount = 0
  try {
    backupCount = (await readdir(paths.backupDir)).length
  } catch {
    backupCount = 0
  }
  return { dir: paths.dir, contentDir: paths.contentDir, backupDir: paths.backupDir, backupCount }
}

/** null means the library file itself could not be read, so nothing may be treated as unmanaged. */
export function managedKeys(snapshot: LibrarySnapshot): Set<string> | null {
  if (snapshot.status === 'read_failed') return null
  const keys = new Set<string>()
  for (const item of snapshot.items) {
    for (const value of [item.originPath, item.externalPath, item.libraryPath, item.shareKey]) {
      if (value) keys.add(value)
    }
  }
  for (const binding of snapshot.bindings) {
    if (binding.desired === 'on' && binding.nativePath) keys.add(binding.nativePath)
  }
  return keys
}

export function isManagedInstance(instance: DiscoveredInstance, keys: Set<string>): boolean {
  return [instance.path, instance.realpath, instance.shareKey].some((value) => keys.has(value))
}
