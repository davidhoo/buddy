import { lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

// Copy only bootstrap configuration. Never share session directories or state DBs
// with the desktop app; WeCode can also rewrite its private configuration safely.
// auth.json is not copied as a snapshot: see shareAuthFile for why.
const bootstrapFiles = ['config.toml', 'AGENTS.md', 'AGENTS.override.md']
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

/** OAuth/ChatGPT token auth that rotates refresh tokens; only this kind may publish. */
type AuthKind = 'oauth' | 'apikey' | 'other'

interface AuthRecord {
  kind: AuthKind
  refresh: number | null
  account: string | null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Classify Codex auth.json. Missing auth_mode is inferred from structure only;
 * ambiguous or unsupported shapes are `other` and never trigger a write-back.
 */
function classifyAuth(parsed: {
  auth_mode?: unknown
  OPENAI_API_KEY?: unknown
  tokens?: unknown
}): AuthKind {
  const mode = typeof parsed.auth_mode === 'string' ? parsed.auth_mode : null
  if (mode === 'chatgpt' || mode === 'chatgptAuthTokens') return 'oauth'
  if (mode === 'apikey') return 'apikey'
  if (mode !== null) return 'other'

  const hasApiKey = nonEmptyString(parsed.OPENAI_API_KEY) !== null
  const tokens = parsed.tokens && typeof parsed.tokens === 'object' ? (parsed.tokens as Record<string, unknown>) : null
  const hasOAuthTokens = Boolean(
    tokens && (nonEmptyString(tokens.refresh_token) || nonEmptyString(tokens.access_token))
  )
  if (hasApiKey && !hasOAuthTokens) return 'apikey'
  if (hasOAuthTokens && !hasApiKey) return 'oauth'
  return 'other'
}

async function readAuthRecord(path: string): Promise<AuthRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      auth_mode?: unknown
      OPENAI_API_KEY?: unknown
      last_refresh?: unknown
      tokens?: { account_id?: unknown; access_token?: unknown; refresh_token?: unknown }
    }
    const refresh = typeof parsed.last_refresh === 'string' ? Date.parse(parsed.last_refresh) : NaN
    return {
      kind: classifyAuth(parsed),
      refresh: Number.isFinite(refresh) ? refresh : null,
      account: nonEmptyString(parsed.tokens?.account_id)
    }
  } catch {
    return null
  }
}

/**
 * Publish the private copy only when both sides are confirmed OAuth for the
 * same non-empty account and the private last_refresh is strictly newer.
 * Missing account, mode, or refresh timestamps never count as a match.
 */
function shouldPublishPrivateAuth(desktop: AuthRecord, privateCopy: AuthRecord): boolean {
  if (desktop.kind !== 'oauth' || privateCopy.kind !== 'oauth') return false
  if (!desktop.account || !privateCopy.account || desktop.account !== privateCopy.account) return false
  if (desktop.refresh === null || privateCopy.refresh === null) return false
  return privateCopy.refresh > desktop.refresh
}

async function writePrivateFile(target: string, content: Buffer | string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * Share the desktop auth file instead of copying it once.
 *
 * Codex rotates OAuth refresh tokens on every refresh, so a snapshot taken at
 * first use is invalidated as soon as either side refreshes. The stale copy
 * then fails with `refresh_token_reused`, which codex-acp reports as
 * "ACP Error -32000: Authentication required". A symlink keeps a single token
 * lineage: whoever refreshes writes the file both sides read.
 *
 * Existing installs may hold a private OAuth copy. Publish it to the desktop
 * file only when both sides are the same ChatGPT account and the private
 * last_refresh is strictly newer; otherwise keep the desktop credential and
 * point Buddy at it so an older OAuth snapshot cannot overwrite an API key.
 */
async function shareAuthFile(sourceHome: string, home: string): Promise<void> {
  const source = join(sourceHome, 'auth.json')
  const target = join(home, 'auth.json')
  const [sourceAuth, targetAuth] = await Promise.all([readAuthRecord(source), readAuthRecord(target)])
  if (!sourceAuth) return
  try {
    if ((await lstat(target)).isSymbolicLink()) return
  } catch (error) {
    if (!missing(error)) throw error
  }
  if (targetAuth && shouldPublishPrivateAuth(sourceAuth, targetAuth)) {
    // Preserve a symlinked desktop auth file rather than replacing the link itself.
    const destination = await realpath(source).catch(() => source)
    await writePrivateFile(destination, await readFile(target))
  }
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await symlink(source, temporary)
    await rename(temporary, target)
  } catch {
    // Filesystems without symlink support still get the freshest snapshot.
    await writePrivateFile(target, await readFile(source))
  } finally {
    await rm(temporary, { force: true })
  }
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
    // stays private; credentials are shared through a single rotating file.
    for (const name of ['skills', 'rules']) {
      if (!existing.has(name)) await symlink(join(sourceHome, name), join(home, name))
    }
    await shareAuthFile(sourceHome, home)
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
