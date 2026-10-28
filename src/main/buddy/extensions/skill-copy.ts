/**
 * Managed skill copies, following Magpie skill_edits / skill_how (commit c3b0484):
 * marker file, take newest agent edit into the library, backup losers, never overwrite on read failure.
 */
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'

/** Buddy marker inside a managed copy (Magpie uses .magpie-library). */
export const BUDDY_SKILL_MARKER = '.buddy-library'

const SKIP = new Set([BUDDY_SKILL_MARKER, '.git', '.DS_Store'])

export async function isManagedCopy(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
    await stat(join(path, BUDDY_SKILL_MARKER))
    return true
  } catch {
    return false
  }
}

export async function copiedAt(path: string): Promise<Date | null> {
  try {
    const info = await stat(join(path, BUDDY_SKILL_MARKER))
    return info.mtime
  } catch {
    return null
  }
}

export async function changedAt(dir: string): Promise<{ ok: true; at: Date } | { ok: false; code: 'read_failed' }> {
  let newest = new Date(0)
  try {
    await walk(dir, async (path, isDir) => {
      if (path !== dir && SKIP.has(basename(path))) return isDir ? 'skip' : undefined
      const info = await stat(path)
      if (info.mtime > newest) newest = info.mtime
      return undefined
    })
    return { ok: true, at: newest }
  } catch {
    return { ok: false, code: 'read_failed' }
  }
}

export async function markCopy(path: string, from: string): Promise<void> {
  const hash = await hashTree(path)
  const body = `copied from ${from} by buddy\nhash ${hash}\n`
  await writeFile(join(path, BUDDY_SKILL_MARKER), body, 'utf8')
}

/** Install a managed copy of libraryPath at dest (atomic replace when dest exists). */
export async function installManagedCopy(libraryPath: string, dest: string): Promise<{ ok: true } | { ok: false; code: string }> {
  const parent = dirname(dest)
  const name = basename(dest)
  const next = join(parent, `.${name}.buddy-next`)
  try {
    await mkdir(parent, { recursive: true })
    await rm(next, { recursive: true, force: true })
    await cp(libraryPath, next, { recursive: true })
    await rm(join(next, BUDDY_SKILL_MARKER), { force: true })
    await markCopy(next, libraryPath)
    let existing: Awaited<ReturnType<typeof lstat>> | null = null
    try {
      existing = await lstat(dest)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!existing) {
      await rename(next, dest)
      return { ok: true }
    }
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      const old = await freeAsidePath(parent, name)
      await rename(dest, old)
      try { await rename(next, dest) } catch (error) { await rename(old, dest); throw error }
      await rm(old, { recursive: true, force: true })
      return { ok: true }
    }
    const old = await freeAsidePath(parent, name)
    await rename(dest, old)
    try {
      await rename(next, dest)
    } catch (error) {
      await rename(old, dest).catch(() => undefined)
      await rm(next, { recursive: true, force: true })
      throw error
    }
    await rm(old, { recursive: true, force: true }).catch(() => undefined)
    return { ok: true }
  } catch (error) {
    await rm(next, { recursive: true, force: true }).catch(() => undefined)
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return { ok: false, code: 'copy_failed' }
    return { ok: false, code: 'failed' }
  }
}

export async function removeManagedCopy(path: string): Promise<'removed' | 'absent' | 'not_ours'> {
  try {
    await lstat(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'not_ours'
  }
  if (!(await isManagedCopy(path))) return 'not_ours'
  await rm(path, { recursive: true, force: true })
  return 'removed'
}

export interface CopyEditCandidate {
  actor: string
  path: string
  at: Date
}

export interface TakeEditsResult {
  libraryUpdated: boolean
  winner: CopyEditCandidate | null
  blocked: Array<{ actor: string; path: string; code: string }>
  setAside: Array<{ actor: string; path: string; backup: string }>
}

/**
 * Magpie takeEdits: newest managed-copy edit newer than the library wins;
 * library previous version is backed up; losing edits are set aside; read failures block sync.
 */
export async function takeSkillEdits(input: {
  libraryPath: string
  backupDir: string
  copies: Array<{ actor: string; path: string }>
}): Promise<TakeEditsResult> {
  const blocked: TakeEditsResult['blocked'] = []
  const edits: CopyEditCandidate[] = []
  const seen = new Set<string>()

  for (const copy of input.copies) {
    try {
      await lstat(copy.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      blocked.push({ actor: copy.actor, path: copy.path, code: 'read_failed' })
      continue
    }
    let managed = false
    try {
      managed = await isManagedCopy(copy.path)
    } catch {
      blocked.push({ actor: copy.actor, path: copy.path, code: 'read_failed' })
      continue
    }
    if (!managed) {
      // Directory present but marker unreadable / missing: treat permission errors as blocked.
      try {
        await stat(join(copy.path, BUDDY_SKILL_MARKER))
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EACCES' || code === 'EPERM') {
          blocked.push({ actor: copy.actor, path: copy.path, code: 'read_failed' })
        }
      }
      continue
    }
    let real = copy.path
    try {
      real = await realpath(copy.path)
    } catch {
      blocked.push({ actor: copy.actor, path: copy.path, code: 'read_failed' })
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)
    const made = await copiedAt(copy.path)
    if (!made) {
      blocked.push({ actor: copy.actor, path: copy.path, code: 'read_failed' })
      continue
    }
    const changed = await changedAt(copy.path)
    if (!changed.ok) {
      blocked.push({ actor: copy.actor, path: copy.path, code: 'read_failed' })
      continue
    }
    if (changed.at.getTime() <= made.getTime()) continue
    if (await sameTree(copy.path, input.libraryPath)) continue
    edits.push({ actor: copy.actor, path: copy.path, at: changed.at })
  }

  const result: TakeEditsResult = { libraryUpdated: false, winner: null, blocked, setAside: [] }
  // Magpie blocks that skill on an incomplete walk; do not take edits or overwrite when a copy is unreadable.
  if (blocked.length > 0 || edits.length === 0) return result

  edits.sort((a, b) => b.at.getTime() - a.at.getTime())
  const libChanged = await changedAt(input.libraryPath)
  if (!libChanged.ok) {
    for (const edit of edits) blocked.push({ actor: edit.actor, path: edit.path, code: 'read_failed' })
    result.blocked = blocked
    return result
  }

  let won = -1
  if (edits[0].at.getTime() > libChanged.at.getTime()) won = 0

  if (won === 0) {
    const winner = edits[0]
    const backup = join(input.backupDir, stamp(), 'library', 'skills', basename(input.libraryPath))
    await mkdir(dirname(backup), { recursive: true })
    await cp(input.libraryPath, backup, { recursive: true })
    await mirrorDir(winner.path, input.libraryPath)
    await rm(join(input.libraryPath, BUDDY_SKILL_MARKER), { force: true })
    const reinstall = await installManagedCopy(input.libraryPath, winner.path)
    if (!reinstall.ok) {
      blocked.push({ actor: winner.actor, path: winner.path, code: reinstall.code })
      result.blocked = blocked
      return result
    }
    result.libraryUpdated = true
    result.winner = winner
  }

  for (let index = 0; index < edits.length; index += 1) {
    if (index === won) continue
    const edit = edits[index]
    const backup = join(input.backupDir, stamp(), edit.actor, 'skills', basename(edit.path))
    await mkdir(dirname(backup), { recursive: true })
    await rename(edit.path, backup)
    result.setAside.push({ actor: edit.actor, path: edit.path, backup })
  }
  return result
}

export async function syncManagedCopy(
  libraryPath: string,
  dest: string
): Promise<{ ok: true; changed: boolean } | { ok: false; code: string }> {
  if (await isManagedCopy(dest)) {
    const made = await copiedAt(dest)
    const changed = await changedAt(dest)
    if (made && changed.ok && changed.at.getTime() <= made.getTime() && (await sameTree(dest, libraryPath))) {
      return { ok: true, changed: false }
    }
  }
  const installed = await installManagedCopy(libraryPath, dest)
  if (!installed.ok) return installed
  return { ok: true, changed: true }
}

async function mirrorDir(from: string, to: string): Promise<void> {
  await walk(from, async (path, isDir) => {
    if (path !== from && SKIP.has(basename(path))) return isDir ? 'skip' : undefined
    const rel = relative(from, path)
    const dest = join(to, rel)
    if (isDir) {
      await mkdir(dest, { recursive: true })
      return undefined
    }
    await mkdir(dirname(dest), { recursive: true })
    const data = await readFile(path)
    await writeFile(dest, data)
    return undefined
  })
  await walk(to, async (path, isDir) => {
    if (path === to) return undefined
    if (SKIP.has(basename(path))) return isDir ? 'skip' : undefined
    const rel = relative(to, path)
    try {
      await lstat(join(from, rel))
      return undefined
    } catch {
      await rm(path, { recursive: true, force: true })
      return isDir ? 'skip' : undefined
    }
  })
}

export async function sameTree(a: string, b: string): Promise<boolean> {
  try {
    return (await hashTree(a)) === (await hashTree(b))
  } catch {
    return false
  }
}

export async function hashTree(dir: string): Promise<string> {
  const hash = createHash('sha256')
  const entries: string[] = []
  await walk(dir, async (path, isDir) => {
    if (path !== dir && SKIP.has(basename(path))) return isDir ? 'skip' : undefined
    if (isDir) return undefined
    const rel = relative(dir, path).split(/[\\/]/).join('/')
    entries.push(rel)
    return undefined
  })
  entries.sort()
  for (const rel of entries) {
    hash.update(rel)
    hash.update('\0')
    hash.update(await readFile(join(dir, rel)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function walk(
  dir: string,
  visit: (path: string, isDir: boolean) => Promise<'skip' | undefined>
): Promise<void> {
  const decision = await visit(dir, true)
  if (decision === 'skip') return
  const names = await readdir(dir)
  for (const name of names) {
    const path = join(dir, name)
    const info = await lstat(path)
    if (info.isDirectory() && !info.isSymbolicLink()) {
      await walk(path, visit)
      continue
    }
    await visit(path, false)
  }
}

async function freeAsidePath(parent: string, name: string): Promise<string> {
  const prefix = `.${name}.buddy-old`
  for (let index = 0; ; index += 1) {
    const candidate = join(parent, index === 0 ? prefix : `${prefix}-${index}`)
    try {
      await lstat(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
    }
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
