import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, rm, stat, symlink, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { LibraryMetaFile, LibraryMcpServer, LibrarySkillRecord } from '../../../shared/library'
import { libraryMetaSchema } from '../schemas'
import { atomicWriteJson } from '../store'

export class LibraryStore {
  constructor(readonly dataRoot: string) {}

  root(): string {
    return join(this.dataRoot, 'library')
  }

  skillsDir(): string {
    return join(this.root(), 'skills')
  }

  backupsDir(): string {
    return join(this.root(), 'backups')
  }

  metaPath(): string {
    return join(this.root(), 'library.json')
  }

  async ensureLayout(): Promise<void> {
    await mkdir(this.skillsDir(), { recursive: true })
    await mkdir(this.backupsDir(), { recursive: true })
  }

  async readMeta(): Promise<LibraryMetaFile> {
    await this.ensureLayout()
    try {
      const raw = JSON.parse(await readFile(this.metaPath(), 'utf8'))
      const parsed = libraryMetaSchema.safeParse(raw)
      if (!parsed.success) {
        return { schemaVersion: 1, skills: [], servers: [], applied: {} }
      }
      return parsed.data
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, skills: [], servers: [], applied: {} }
      }
      throw error
    }
  }

  async writeMeta(meta: LibraryMetaFile): Promise<void> {
    await this.ensureLayout()
    await atomicWriteJson(this.metaPath(), meta)
  }

  async backupPath(label: string): Promise<string> {
    const stamp = `${Date.now()}-${label.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40)}`
    const dir = join(this.backupsDir(), stamp)
    await mkdir(dir, { recursive: true })
    return dir
  }

  async backupTree(source: string, label: string): Promise<string> {
    const dir = await this.backupPath(label)
    const target = join(dir, 'content')
    await cp(source, target, { recursive: true, dereference: false })
    return target
  }
}

export async function hashTree(root: string): Promise<string> {
  const hash = createHash('sha256')
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, rel)
      else if (entry.isSymbolicLink()) {
        hash.update(`link:${rel}\n`)
      } else if (entry.isFile()) {
        const buf = await readFile(full)
        hash.update(`file:${rel}:${buf.length}\n`)
        hash.update(buf)
      }
    }
  }
  await walk(root, '')
  return hash.digest('hex')
}

export async function pathKind(path: string): Promise<'missing' | 'dir' | 'file' | 'symlink'> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return 'symlink'
    if (info.isDirectory()) return 'dir'
    return 'file'
  } catch {
    return 'missing'
  }
}

export async function isGitRoot(path: string): Promise<boolean> {
  try {
    const info = await stat(join(path, '.git'))
    return info.isDirectory() || info.isFile()
  } catch {
    return false
  }
}

export async function replaceWithSymlink(linkPath: string, target: string): Promise<void> {
  await rm(linkPath, { recursive: true, force: true })
  await symlink(target, linkPath)
}

export async function moveDir(from: string, to: string): Promise<void> {
  await mkdir(dirnameSafe(to), { recursive: true })
  try {
    await rename(from, to)
  } catch {
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
}

function dirnameSafe(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(0, i) : '.'
}

export function upsertSkill(meta: LibraryMetaFile, skill: LibrarySkillRecord): LibraryMetaFile {
  const skills = meta.skills.filter((s) => s.id !== skill.id && s.name !== skill.name)
  skills.push(skill)
  return { ...meta, skills }
}

export function upsertServer(meta: LibraryMetaFile, server: LibraryMcpServer): LibraryMetaFile {
  const servers = meta.servers.filter((s) => s.id !== server.id && !(s.name === server.name && s.sourceTargetId === server.sourceTargetId))
  servers.push(server)
  return { ...meta, servers }
}
