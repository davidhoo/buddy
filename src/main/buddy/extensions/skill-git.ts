import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ExtensionActionResult, LibraryData, LibraryItem, LibrarySnapshot } from '../../../shared/extensions'
import { hashTree } from './skill-copy'
import { readSkillFrontmatter } from './parse'
import { extensionPaths, writeLibrary } from './library-store'

const NAME = /^[A-Za-z0-9_.-]{1,120}$/
const REF = /^[A-Za-z0-9._/-]{1,200}$/
const HOST = /^[a-z0-9.-]{1,253}$/

export function parseGitSource(raw: string): { url: string; ref: string | null; subdir: string | null } | null {
  const text = raw.trim()
  if (!text || text.length > 2000 || /[\0\r\n\s'"`$|&;<>\\]/.test(text) || text.includes('..') || text.includes('@')) return null
  const hash = text.indexOf('#')
  let body = text
  let ref: string | null = null
  if (hash >= 0) {
    body = text.slice(0, hash)
    ref = text.slice(hash + 1)
    if (!safeRef(ref)) return null
  }
  if (NAME.test(body.split('/')[0] ?? '') && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(body)) {
    return { url: `https://github.com/${body}.git`, ref, subdir: null }
  }
  let parsed: URL
  try {
    parsed = new URL(body)
  } catch {
    return null
  }
  if (parsed.username || parsed.password || parsed.search) return null
  if (parsed.protocol === 'file:') {
    if (!parsed.pathname.startsWith('/') || parsed.hash) return null
    return { url: body, ref, subdir: null }
  }
  if (parsed.protocol !== 'https:' || parsed.port) return null
  const host = parsed.hostname.toLowerCase()
  if (!HOST.test(host) || host.startsWith('.') || host.endsWith('.')) return null
  const parts = parsed.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
  if (parts.length < 2 || parts.some((part) => part === '..' || part.startsWith('-') || part.includes('\\'))) return null
  let repoParts = parts
  let subdir: string | null = null
  const treeAt = parts.indexOf('tree')
  if (treeAt >= 2) {
    repoParts = parts.slice(0, treeAt)
    const rest = parts.slice(treeAt + 1)
    if (rest.length === 0 || !safeRef(rest[0])) return null
    if (!ref) ref = rest[0]
    if (rest.length > 1) subdir = rest.slice(1).join('/')
  }
  if (repoParts.length < 2) return null
  const last = repoParts[repoParts.length - 1].endsWith('.git') ? repoParts[repoParts.length - 1] : `${repoParts[repoParts.length - 1]}.git`
  const path = `/${[...repoParts.slice(0, -1), last].join('/')}`
  return { url: `https://${host}${path}`, ref, subdir }
}

export async function installGitSkills(dataRoot: string, source: string, library: LibrarySnapshot): Promise<ExtensionActionResult> {
  const parsed = parseGitSource(source)
  if (!parsed) return { accepted: false, code: 'find_not_ready', results: [] }
  const staging = join(extensionPaths(dataRoot).dir, 'staging', randomUUID())
  try {
    await mkdir(dirname(staging), { recursive: true })
    const cloned = await runGit(['clone', '--depth', '1', '--no-tags', ...(parsed.ref ? ['--branch', parsed.ref] : []), '--', parsed.url, staging], 20_000)
    if (!cloned.ok) return fail(cloned.code)
    const commit = await runGit(['-C', staging, 'rev-parse', 'HEAD'], 5_000)
    if (!commit.ok || !/^[0-9a-f]{7,64}$/i.test(commit.stdout.trim())) return fail('git_failed')
    const skills = await findSkillDirs(staging, parsed.subdir)
    if (skills.length === 0) return fail('missing_skill')
    const data: LibraryData = {
      version: 1,
      items: library.items.map((item) => ({ ...item })),
      bindings: library.bindings.map((binding) => ({ ...binding })),
      records: [...library.records],
      skillDefaultMode: library.skillDefaultMode,
      skillAgentModes: { ...library.skillAgentModes }
    }
    const results: ExtensionActionResult['results'] = []
    for (const skillDir of skills) {
      const text = await readFile(join(skillDir, 'SKILL.md'), 'utf8').catch(() => '')
      const front = readSkillFrontmatter(text)
      const name = front.name || basename(skillDir)
      const existing = data.items.find((item) => item.kind === 'skill' && item.repository === parsed.url && item.name === name)
      if (existing) {
        results.push({ actor: '', status: 'skipped', code: 'already', libraryItemId: existing.id })
        continue
      }
      const item = newItem(parsed.url, commit.stdout.trim(), skillDir, staging, name, front.description ?? '', digest(text))
      const dest = join(extensionPaths(dataRoot).contentDir, 'skills', item.id)
      try {
        await copySkill(skillDir, dest)
      } catch {
        await rm(dest, { recursive: true, force: true })
        results.push({ actor: '', status: 'failed', code: 'git_failed', libraryItemId: null })
        continue
      }
      item.repositoryPath = relative(staging, skillDir)
      item.repositoryRef = parsed.ref ?? undefined
      item.treeHash = await hashTree(dest)
      item.libraryPath = dest
      data.items.push(item)
      results.push({ actor: '', status: 'changed', code: 'installed', libraryItemId: item.id })
    }
    if (results.some((entry) => entry.status === 'changed')) await writeLibrary(dataRoot, data)
    return { accepted: results.some((entry) => entry.status !== 'failed'), code: 'ok', results }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

function newItem(url: string, commit: string, skillDir: string, staging: string, name: string, description: string, contentHash: string): LibraryItem {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    kind: 'skill',
    name,
    description,
    originActor: '',
    originPath: url,
    shareKey: digest(`${url}\0${relative(staging, skillDir)}`),
    repository: url,
    pluginId: null,
    version: commit,
    contentHash,
    libraryPath: null,
    externalPath: null,
    createdAt: now,
    updatedAt: now
  }
}

async function findSkillDirs(staging: string, subdir: string | null): Promise<string[]> {
  const start = subdir ? join(staging, subdir) : staging
  const rel = relative(staging, start)
  if (rel.startsWith('..') || isAbsolute(rel)) return []
  const found: string[] = []
  await walkSkills(start, 0, found)
  return found.slice(0, 20)
}

async function walkSkills(directory: string, depth: number, found: string[]): Promise<void> {
  if (found.length >= 20) return
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  const skill = entries.some((entry) => entry.name === 'SKILL.md')
  if (skill) {
    found.push(directory)
    return
  }
  if (depth >= 4) return
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue
    const path = join(directory, entry.name)
    const info = await lstat(path).catch(() => null)
    if (!info?.isDirectory() || info.isSymbolicLink()) continue
    await walkSkills(path, depth + 1, found)
  }
}

async function copySkill(src: string, dest: string): Promise<void> {
  const root = await realpath(src)
  await mkdir(dest, { recursive: true })
  await copyInside(src, dest, root)
}

async function copyInside(src: string, dest: string, root: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    const info = await lstat(from)
    if (info.isSymbolicLink()) {
      const target = await readlink(from)
      const resolved = resolve(dirname(from), target)
      const rel = relative(root, resolved)
      if (rel.startsWith('..') || isAbsolute(rel)) continue
      await symlink(target, to)
      continue
    }
    if (info.isDirectory()) {
      await mkdir(to)
      await copyInside(from, destJoin(dest, entry.name), root)
      continue
    }
    if (info.isFile()) await copyFile(from, to)
  }
}

function destJoin(dest: string, name: string): string {
  return join(dest, name)
}

function fail(code: string): ExtensionActionResult {
  return { accepted: false, code: 'ok', results: [{ actor: '', status: 'failed', code, libraryItemId: null }] }
}

function safeRef(ref: string): boolean {
  return REF.test(ref) && !ref.startsWith('-') && !ref.includes('..')
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function runGit(args: string[], timeoutMs: number): Promise<{ ok: true; stdout: string } | { ok: false; code: 'git_missing' | 'git_failed' | 'timeout' }> {
  return new Promise((resolvePromise) => {
    const child = spawn('git', args, {
      shell: false,
      detached: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let settled = false
    const finish = (result: { ok: true; stdout: string } | { ok: false; code: 'git_missing' | 'git_failed' | 'timeout' }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killGroup(child)
      resolvePromise(result)
    }
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.on('error', (error) => finish({ ok: false, code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'git_missing' : 'git_failed' }))
    child.on('close', (code) => finish(code === 0 ? { ok: true, stdout } : { ok: false, code: 'git_failed' }))
  })
}

function killGroup(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return
  try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

/** Fetch into staging; never overwrite local edits without an explicit replacement. */
export async function refreshGitSkills(dataRoot: string, library: LibrarySnapshot, itemId?: string, replace = false): Promise<ExtensionActionResult> {
  const data: LibraryData = { ...library, items: library.items.map(i => ({ ...i })), records: [...library.records] }
  const results: ExtensionActionResult['results'] = []
  for (const item of data.items.filter(i => i.kind === 'skill' && i.repository && (!itemId || i.id === itemId))) {
    const parsed = parseGitSource(item.repository!)
    if (!parsed || !item.libraryPath) continue
    const staging = join(extensionPaths(dataRoot).dir, 'staging', randomUUID())
    const add = (status: 'changed' | 'failed' | 'skipped', code: string) => results.push({ actor: '', status, code, libraryItemId: item.id })
    try {
      await mkdir(dirname(staging), { recursive: true })
      const clone = await runGit(['clone', '--depth', '1', '--no-tags', ...(item.repositoryRef ? ['--branch', item.repositoryRef] : []), '--', parsed.url, staging], 20_000)
      if (!clone.ok) { add('failed', clone.code); continue }
      const revision = await runGit(['-C', staging, 'rev-parse', 'HEAD'], 5_000)
      if (!revision.ok) { add('failed', 'git_failed'); continue }
      const dirs = await findSkillDirs(staging, null)
      const source = dirs.find(dir => item.repositoryPath !== undefined ? relative(staging, dir) === item.repositoryPath : basename(dir) === item.name)
      if (!source) { add('failed', 'missing_skill'); continue }
      const hash = await hashTree(item.libraryPath)
      item.locallyEdited = item.treeHash ? hash !== item.treeHash : digest(await readFile(join(item.libraryPath, 'SKILL.md'), 'utf8')) !== item.contentHash
      item.updateAvailable = revision.stdout.trim() !== item.version ? revision.stdout.trim() : null
      if (!itemId) { add('changed', 'checked'); continue }
      if (item.locallyEdited && !replace) { add('failed', 'changed_externally'); continue }
      if (!item.updateAvailable) { add('skipped', 'already'); continue }
      const next = join(dirname(staging), randomUUID())
      try {
        await copySkill(source, next)
        // Refuse symlink/external roots; only content owned by this library is updated.
        const owned = relative(extensionPaths(dataRoot).contentDir, item.libraryPath)
        if (owned.startsWith('..') || isAbsolute(owned) || (await lstat(item.libraryPath)).isSymbolicLink()) { add('failed', 'conflict'); continue }
        const backup = join(extensionPaths(dataRoot).backupDir, randomUUID(), 'skills', item.id)
        await mkdir(dirname(backup), { recursive: true })
        await rename(item.libraryPath, backup)
        try { await rename(next, item.libraryPath) } catch (error) { await rename(backup, item.libraryPath); throw error }
        item.version = revision.stdout.trim()
        item.treeHash = await hashTree(item.libraryPath)
        item.contentHash = digest(await readFile(join(item.libraryPath, 'SKILL.md'), 'utf8'))
        item.updateAvailable = null
        item.locallyEdited = false
        item.updatedAt = new Date().toISOString()
        add('changed', 'updated')
      } finally { await rm(next, { recursive: true, force: true }) }
    } catch { add('failed', 'git_failed') }
    finally { await rm(staging, { recursive: true, force: true }) }
  }
  await writeLibrary(dataRoot, data)
  return { accepted: results.every(r => r.status !== 'failed'), code: 'ok', results }
}
