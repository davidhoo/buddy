import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

// Copy only bootstrap configuration. Never share session directories or state DBs
// with the desktop app; WeCode can also rewrite its private configuration safely.
const bootstrapFiles = ['config.toml', 'auth.json', 'AGENTS.md', 'AGENTS.override.md']
const pending = new Map<string, Promise<void>>()

/** CLI overrides take precedence over sqlite_home copied from desktop config. */
export async function codexIsolationWrapper(dataRoot: string): Promise<string> {
  const directory = join(dataRoot, 'bin')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const wrapper = join(directory, 'buddy-codex-acp')
  const temporary = `${wrapper}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, '#!/bin/bash\nexec "$BUDDY_CODEX_EXECUTABLE" -c "$BUDDY_CODEX_SQLITE_CONFIG" "$@"\n', { mode: 0o700 })
    await rename(temporary, wrapper)
  } finally {
    await rm(temporary, { force: true })
  }
  return wrapper
}

async function copyPrivateFile(source: string, target: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, await readFile(source), { mode: 0o600, flag: 'wx' })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Stable per-actor home, shared by runs, probes and launcher checks. */
export async function prepareCodexHome(
  actor: string,
  dataRoot: string,
  env: Record<string, string>,
  sessionId?: string,
  sourceHome = process.env.CODEX_HOME || join(homedir(), '.codex')
): Promise<string> {
  // An explicitly configured launcher home remains under the user's control.
  if (env.CODEX_HOME) return env.CODEX_HOME
  const home = join(dataRoot, 'acp', actor, 'codex-home')
  if (resolve(home) === resolve(sourceHome)) throw new Error('Buddy Codex home must be isolated')
  const previous = pending.get(home) ?? Promise.resolve()
  const work = previous.catch(() => {}).then(async () => {
    await mkdir(home, { recursive: true, mode: 0o700 })
    const existing = new Set(await readdir(home))
    for (const name of bootstrapFiles) {
      if (existing.has(name)) continue
      try {
        await copyPrivateFile(join(sourceHome, name), join(home, name))
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
    // Skills and rules retain their original relative resources. Runtime state
    // and credentials are deliberately not linked.
    for (const name of ['skills', 'rules']) {
      if (!existing.has(name)) await symlink(join(sourceHome, name), join(home, name))
    }
    if (sessionId && /^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      await importSession(sourceHome, home, sessionId)
    }
  })
  pending.set(home, work)
  try {
    await work
  } finally {
    if (pending.get(home) === work) pending.delete(home)
  }
  return home
}

async function importSession(sourceHome: string, home: string, sessionId: string): Promise<void> {
  // Codex resumes by finding the rollout under sessions. Import just the selected
  // legacy thread, never the shared SQLite index or another user's history.
  const suffix = `-${sessionId}.jsonl`
  async function walk(relative: string): Promise<void> {
    let entries
    try {
      entries = await readdir(join(sourceHome, relative), { withFileTypes: true })
    } catch (error) {
      if (missing(error)) return
      throw error
    }
    for (const entry of entries) {
      const path = join(relative, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith(suffix)) {
        const destination = join(home, relative)
        await mkdir(destination, { recursive: true, mode: 0o700 })
        if ((await readdir(destination)).includes(entry.name)) continue
        await copyPrivateFile(join(sourceHome, path), join(home, path))
      }
    }
  }
  await walk('sessions')
}
