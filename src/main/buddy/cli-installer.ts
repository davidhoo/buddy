import { constants, existsSync } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { CliInstallStatus } from '../../shared/types'
import { defaultCliDataRoot } from './cli-client'

export const BUDDY_CLI_WRAPPER_MARKER = '# buddy-cli-managed-wrapper'

export interface CliInstallerOptions {
  dataRoot?: string
  /** Path to the packaged Electron binary (Contents/MacOS/Buddy) when running from packaged app */
  appExecPath?: string
  /** Path to development repository root (containing out/main/cli.js) when running in dev/repo mode */
  repoRoot?: string
  homeDir?: string
  pathEnv?: string
  /** Optional explicit target bin directory (used by tests or --bin-dir) */
  targetBinDirs?: string[]
  updateShellProfile?: boolean
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function deriveAppBundlePath(appExecPath?: string): string | null {
  if (!appExecPath) return null
  const match = appExecPath.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/)
  if (match) return match[1]
  return null
}

export function buildCliWrapperScript(options: CliInstallerOptions = {}): string {
  const repoCliPath = options.repoRoot ? join(resolve(options.repoRoot), 'out', 'main', 'cli.js') : ''
  const appBundlePath = deriveAppBundlePath(options.appExecPath) ?? ''

  return [
    '#!/usr/bin/env sh',
    BUDDY_CLI_WRAPPER_MARKER,
    'set -eu',
    '',
    `REPO_CLI=${shellQuote(repoCliPath)}`,
    `CONFIGURED_APP=${shellQuote(appBundlePath)}`,
    '',
    'if [ -n "$REPO_CLI" ] && [ -f "$REPO_CLI" ] && command -v node >/dev/null 2>&1; then',
    '  exec node "$REPO_CLI" "$@"',
    'fi',
    '',
    'APP_PATH=""',
    'for candidate in "${BUDDY_APP_PATH:-}" "$CONFIGURED_APP" "/Applications/Buddy.app" "$HOME/Applications/Buddy.app"; do',
    '  if [ -n "$candidate" ] && [ -d "$candidate" ]; then',
    '    APP_PATH="$candidate"',
    '    break',
    '  fi',
    'done',
    '',
    'if [ -n "$APP_PATH" ]; then',
    '  APP_EXEC="$APP_PATH/Contents/MacOS/Buddy"',
    '  if [ -x "$APP_EXEC" ]; then',
    '    if [ -f "$APP_PATH/Contents/Resources/app.asar" ]; then',
    '      ELECTRON_RUN_AS_NODE=1 exec "$APP_EXEC" "$APP_PATH/Contents/Resources/app.asar/out/main/cli.js" "$@"',
    '    fi',
    '    if [ -f "$APP_PATH/Contents/Resources/app/out/main/cli.js" ]; then',
    '      ELECTRON_RUN_AS_NODE=1 exec "$APP_EXEC" "$APP_PATH/Contents/Resources/app/out/main/cli.js" "$@"',
    '    fi',
    '    if [ -n "$REPO_CLI" ] && [ -f "$REPO_CLI" ]; then',
    '      ELECTRON_RUN_AS_NODE=1 exec "$APP_EXEC" "$REPO_CLI" "$@"',
    '    fi',
    '  fi',
    'fi',
    '',
    'echo "Buddy CLI runtime not found. Open Buddy.app or run \'pnpm build\' in the Buddy repository." >&2',
    'exit 1',
    ''
  ].join('\n')
}

function wrapperPathForDataRoot(dataRoot: string): string {
  return join(dataRoot, 'bin', 'buddy')
}

function parsePathEntries(pathEnv?: string): string[] {
  return (pathEnv ?? process.env.PATH ?? '')
    .split(':')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function isDirInPath(dir: string, pathEntries: string[]): boolean {
  const resolved = resolve(dir)
  return pathEntries.some((entry) => {
    try {
      return resolve(entry) === resolved
    } catch {
      return false
    }
  })
}

async function isWritableDir(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

async function isManagedBuddyTarget(targetPath: string, wrapperPath: string): Promise<boolean> {
  try {
    const stat = await lstat(targetPath)
    if (stat.isSymbolicLink()) {
      const linkTarget = await readlink(targetPath)
      const resolvedLink = resolve(dirname(targetPath), linkTarget)
      if (resolvedLink === resolve(wrapperPath)) {
        return true
      }
      try {
        const content = await readFile(targetPath, 'utf8')
        return content.includes(BUDDY_CLI_WRAPPER_MARKER)
      } catch {
        return false
      }
    }
    if (stat.isFile()) {
      const content = await readFile(targetPath, 'utf8')
      return content.includes(BUDDY_CLI_WRAPPER_MARKER)
    }
    return false
  } catch {
    return false
  }
}

function defaultInspectDirs(homeDir: string): string[] {
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homeDir, '.local', 'bin'),
    join(homeDir, 'bin')
  ]
}

async function resolveInstallCandidateDirs(
  homeDir: string,
  pathEntries: string[],
  targetBinDirs?: string[]
): Promise<string[]> {
  if (targetBinDirs && targetBinDirs.length > 0) {
    return [...new Set(targetBinDirs.map((dir) => resolve(dir)))]
  }

  const localBin = join(homeDir, '.local', 'bin')
  const standard = ['/usr/local/bin', '/opt/homebrew/bin', localBin, join(homeDir, 'bin')]

  const inPathCandidates: string[] = []
  const fallbackCandidates: string[] = []

  for (const dir of standard) {
    if (dir === '/opt/homebrew/bin' && !isDirInPath(dir, pathEntries)) {
      continue
    }
    if (existsSync(dir) && await isWritableDir(dir)) {
      if (isDirInPath(dir, pathEntries)) {
        inPathCandidates.push(dir)
      } else {
        fallbackCandidates.push(dir)
      }
    }
  }

  // Always include ~/.local/bin as a guaranteed user-writable fallback (mkdir if missing).
  const ordered = [...inPathCandidates, ...fallbackCandidates]
  if (!ordered.some((dir) => resolve(dir) === resolve(localBin))) {
    ordered.push(localBin)
  }
  return [...new Set(ordered)]
}

async function maybeUpdateShellProfile(
  homeDir: string,
  installedDir: string
): Promise<{ updated: boolean; profilePath: string | null }> {
  const shellName = basename(process.env.SHELL || '/bin/zsh').toLowerCase()
  const profileName = shellName.includes('bash') ? '.bashrc' : '.zshrc'
  const profilePath = join(homeDir, profileName)

  const localBin = join(homeDir, '.local', 'bin')
  const exportDir = resolve(installedDir) === resolve(localBin)
    ? '$HOME/.local/bin'
    : installedDir

  let existing = ''
  try {
    existing = await readFile(profilePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return { updated: false, profilePath: null }
    }
  }

  if (existing.includes(exportDir) || existing.includes(installedDir)) {
    return { updated: false, profilePath }
  }

  const snippet = `${existing && !existing.endsWith('\n') ? '\n' : ''}\n# Added by Buddy\nexport PATH="${exportDir}:$PATH"\n`
  await mkdir(homeDir, { recursive: true })
  await writeFile(profilePath, existing + snippet, 'utf8')
  return { updated: true, profilePath }
}

export async function getCliInstallStatus(options: CliInstallerOptions = {}): Promise<CliInstallStatus> {
  const dataRoot = options.dataRoot ?? defaultCliDataRoot()
  const homeDir = options.homeDir ?? homedir()
  const pathEntries = parsePathEntries(options.pathEnv)
  const wrapperPath = wrapperPathForDataRoot(dataRoot)

  const dirs = options.targetBinDirs && options.targetBinDirs.length > 0
    ? options.targetBinDirs.map((dir) => resolve(dir))
    : defaultInspectDirs(homeDir)

  for (const dir of dirs) {
    const candidate = join(dir, 'buddy')
    if (await isManagedBuddyTarget(candidate, wrapperPath)) {
      return {
        installed: true,
        commandPath: candidate,
        wrapperPath,
        inPath: isDirInPath(dir, pathEntries)
      }
    }
  }

  return {
    installed: false,
    commandPath: null,
    wrapperPath,
    inPath: false
  }
}

export async function installBuddyCli(options: CliInstallerOptions = {}): Promise<CliInstallStatus> {
  const dataRoot = options.dataRoot ?? defaultCliDataRoot()
  const homeDir = options.homeDir ?? homedir()
  const pathEntries = parsePathEntries(options.pathEnv)
  const wrapperPath = wrapperPathForDataRoot(dataRoot)

  await mkdir(dirname(wrapperPath), { recursive: true })
  await writeFile(wrapperPath, buildCliWrapperScript(options), 'utf8')
  await chmod(wrapperPath, 0o755)

  const candidates = await resolveInstallCandidateDirs(homeDir, pathEntries, options.targetBinDirs)
  let installedPath: string | null = null

  for (const dir of candidates) {
    await mkdir(dir, { recursive: true })
    const targetPath = join(dir, 'buddy')

    let exists = false
    try {
      await lstat(targetPath)
      exists = true
    } catch {
      exists = false
    }

    if (exists) {
      const managed = await isManagedBuddyTarget(targetPath, wrapperPath)
      if (!managed) {
        // Never clobber an unrelated binary with the same name.
        continue
      }
      await unlink(targetPath)
    }

    try {
      await symlink(wrapperPath, targetPath)
      installedPath = targetPath
      break
    } catch {
      try {
        await writeFile(targetPath, buildCliWrapperScript(options), 'utf8')
        await chmod(targetPath, 0o755)
        installedPath = targetPath
        break
      } catch {
        // Try next candidate directory
      }
    }
  }

  if (!installedPath) {
    throw new Error('Could not install buddy command into any writable bin directory (an unrelated "buddy" binary may already exist).')
  }

  const installedDir = dirname(installedPath)
  const inPath = isDirInPath(installedDir, pathEntries)
  let shellProfileUpdated = false
  let shellProfilePath: string | null = null

  if (!inPath && options.updateShellProfile !== false) {
    const profileResult = await maybeUpdateShellProfile(homeDir, installedDir)
    shellProfileUpdated = profileResult.updated
    shellProfilePath = profileResult.profilePath
  }

  return {
    installed: true,
    commandPath: installedPath,
    wrapperPath,
    inPath,
    shellProfileUpdated,
    shellProfilePath
  }
}

export async function uninstallBuddyCli(options: CliInstallerOptions = {}): Promise<CliInstallStatus> {
  const dataRoot = options.dataRoot ?? defaultCliDataRoot()
  const homeDir = options.homeDir ?? homedir()
  const wrapperPath = wrapperPathForDataRoot(dataRoot)

  const dirs = options.targetBinDirs && options.targetBinDirs.length > 0
    ? options.targetBinDirs.map((dir) => resolve(dir))
    : defaultInspectDirs(homeDir)

  for (const dir of dirs) {
    const candidate = join(dir, 'buddy')
    if (await isManagedBuddyTarget(candidate, wrapperPath)) {
      await rm(candidate, { force: true })
    }
  }

  if (await isManagedBuddyTarget(wrapperPath, wrapperPath)) {
    await rm(wrapperPath, { force: true })
  }

  return {
    installed: false,
    commandPath: null,
    wrapperPath,
    inPath: false
  }
}
