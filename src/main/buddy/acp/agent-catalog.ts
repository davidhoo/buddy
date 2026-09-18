import { basename, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { mkdir, writeFile, chmod } from 'node:fs/promises'
import { splitCommand } from '../launchers'

/**
 * Locate the wecode executable on the system.
 */
export function findWecodePath(): string {
  const home = homedir()
  const defaultWecode = join(home, '.wecode-cli', 'bin', 'wecode')
  if (existsSync(defaultWecode)) {
    return defaultWecode
  }

  const pathEnv = process.env.PATH || ''
  for (const dir of pathEnv.split(':').filter(Boolean)) {
    const candidate = join(dir, 'wecode')
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return 'wecode'
}

/**
 * Ensure an executable wrapper script exists for codex-acp to drive 'wecode codex app-server'.
 */
export async function ensureWecodeCodexWrapper(dataRoot?: string): Promise<string> {
  const binDir = join(dataRoot || tmpdir(), 'bin')
  await mkdir(binDir, { recursive: true })
  const wrapperPath = join(binDir, 'wecode-codex')
  const scriptContent = `#!/bin/bash
WECODE_BIN="\${WECODE_BIN:-$(which wecode 2>/dev/null || echo "$HOME/.wecode-cli/bin/wecode")}"
exec "$WECODE_BIN" codex "$@"
`
  await writeFile(wrapperPath, scriptContent, { mode: 0o755 })
  await chmod(wrapperPath, 0o755).catch(() => {})
  return wrapperPath
}

/**
 * Prepare environment variables required by specific ACP agents (e.g. WeCode Claude & Codex adapters).
 */
export async function prepareAcpEnvironment(
  actor: string,
  baseEnv?: Record<string, string>,
  dataRoot?: string
): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...(baseEnv ?? {}) }

  if (actor === 'wecode_claude') {
    if (!env.CLAUDE_CODE_EXECUTABLE) {
      env.CLAUDE_CODE_EXECUTABLE = findWecodePath()
    }
  } else if (actor === 'wecode_codex') {
    if (!env.CODEX_PATH) {
      env.CODEX_PATH = await ensureWecodeCodexWrapper(dataRoot)
    }
  }

  return env
}

/**
 * Return default ACP arguments for known CLI commands if not explicitly provided.
 */
export function defaultAcpArgs(command: string, actor?: string): string[] {
  const rawTokens = splitCommand(command)
  const exe = basename(rawTokens[0] || '').toLowerCase()
  const secondToken = rawTokens[1]?.toLowerCase()

  // If command already contains 'acp' argument anywhere, do not duplicate
  if (rawTokens.some((t) => t.toLowerCase() === 'acp')) {
    return []
  }

  // If invoking an adapter package directly
  if (exe.includes('codex-acp') || exe.includes('claude-agent-acp')) {
    return []
  }

  if (exe === 'wecode') {
    if (secondToken === 'opencode') {
      return ['acp']
    }
    if (actor === 'opencode' || actor === 'wecode_opencode') {
      return ['opencode', 'acp']
    }
    return ['acp']
  }

  if (exe === 'opencode') {
    return ['acp']
  }

  if (exe === 'agent' || exe === 'cursor-agent') {
    return ['acp']
  }

  return ['acp']
}

/**
 * Locate a globally installed executable across PATH and standard user bin directories.
 */
export function findGlobalExecutable(name: string): string | null {
  const pathEnv = process.env.PATH || ''
  const searchDirs = [
    ...pathEnv.split(':').filter(Boolean),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.nvm', 'versions', 'node', process.version, 'bin'),
    join(homedir(), '.npm-global', 'bin'),
    join(homedir(), 'bin'),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.wecode-cli', 'bin')
  ]

  const seen = new Set<string>()
  for (const dir of searchDirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    const candidate = join(dir, name)
    try {
      if (existsSync(candidate)) {
        return candidate
      }
    } catch {
      // ignore access error
    }
  }

  return null
}

export interface ResolvedAcpBinary {
  command: string
  args: string[]
  isGlobal: boolean
  adapterName?: string
}

/**
 * Resolve whether to run via direct global binary or npx fallback.
 */
export function resolveAcpBinary(command: string, args?: string[]): ResolvedAcpBinary {
  const rawArgs = args ?? []
  const joinedArgs = rawArgs.join(' ')
  const isNpx = command === 'npx' || command.endsWith('/npx')

  // Case 1: npx with claude-agent-acp
  if (isNpx && joinedArgs.includes('claude-agent-acp')) {
    const globalBin = findGlobalExecutable('claude-agent-acp')
    if (globalBin) {
      return { command: globalBin, args: [], isGlobal: true, adapterName: 'claude-agent-acp' }
    }
    return { command, args: rawArgs, isGlobal: false, adapterName: 'claude-agent-acp' }
  }

  // Case 2: npx with codex-acp
  if (isNpx && joinedArgs.includes('codex-acp')) {
    const globalBin = findGlobalExecutable('codex-acp')
    if (globalBin) {
      return { command: globalBin, args: [], isGlobal: true, adapterName: 'codex-acp' }
    }
    return { command, args: rawArgs, isGlobal: false, adapterName: 'codex-acp' }
  }

  // Case 3: command is claude-agent-acp
  if (command === 'claude-agent-acp' || command.endsWith('/claude-agent-acp')) {
    const globalBin = findGlobalExecutable('claude-agent-acp')
    if (globalBin) {
      return { command: globalBin, args: rawArgs, isGlobal: true, adapterName: 'claude-agent-acp' }
    }
    return {
      command: 'npx',
      args: ['-y', '@agentclientprotocol/claude-agent-acp', ...rawArgs],
      isGlobal: false,
      adapterName: 'claude-agent-acp'
    }
  }

  // Case 4: command is codex-acp
  if (command === 'codex-acp' || command.endsWith('/codex-acp')) {
    const globalBin = findGlobalExecutable('codex-acp')
    if (globalBin) {
      return { command: globalBin, args: rawArgs, isGlobal: true, adapterName: 'codex-acp' }
    }
    return {
      command: 'npx',
      args: ['-y', '@agentclientprotocol/codex-acp', ...rawArgs],
      isGlobal: false,
      adapterName: 'codex-acp'
    }
  }

  return {
    command,
    args: rawArgs,
    isGlobal: false
  }
}

export interface GlobalAcpAdaptersStatus {
  claude: {
    installed: boolean
    binaryPath: string | null
    installCommand: string
  }
  codex: {
    installed: boolean
    binaryPath: string | null
    installCommand: string
  }
}

/**
 * Check the installation status of global ACP adapters.
 */
export function checkGlobalAcpAdapters(): GlobalAcpAdaptersStatus {
  const claudeBin = findGlobalExecutable('claude-agent-acp')
  const codexBin = findGlobalExecutable('codex-acp')

  return {
    claude: {
      installed: Boolean(claudeBin),
      binaryPath: claudeBin,
      installCommand: 'npm install -g @agentclientprotocol/claude-agent-acp'
    },
    codex: {
      installed: Boolean(codexBin),
      binaryPath: codexBin,
      installCommand: 'npm install -g @agentclientprotocol/codex-acp'
    }
  }
}
