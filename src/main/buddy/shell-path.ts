import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename, join } from 'node:path'

const INSTALL_HINTS: Record<string, string> = {
  kimi: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  'cursor-agent': 'curl -fsS https://cursor.com/install | bash',
  agent: 'curl -fsS https://cursor.com/install | bash',
  agy: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  opencode: 'go install github.com/sst/opencode@latest'
}

const ENV_MARKER = '__BUDDY_ENV__:'
const SYSTEM_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

export function installHintFor(command: string): string | undefined {
  return INSTALL_HINTS[command]
}

export const PROXY_VARS = [
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY'
] as const

export const PROXY_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['http_proxy', 'HTTP_PROXY'],
  ['https_proxy', 'HTTPS_PROXY'],
  ['all_proxy', 'ALL_PROXY'],
  ['no_proxy', 'NO_PROXY']
]

export type ShellKind = 'posix' | 'fish' | 'csh'

const POSIX_ENV_SCRIPT = [
  '[ -n "${PATH+x}" ] && printf \'__BUDDY_ENV__:PATH=%s\\n\' "$PATH"',
  '[ -n "${http_proxy+x}" ] && printf \'__BUDDY_ENV__:http_proxy=%s\\n\' "$http_proxy"',
  '[ -n "${https_proxy+x}" ] && printf \'__BUDDY_ENV__:https_proxy=%s\\n\' "$https_proxy"',
  '[ -n "${all_proxy+x}" ] && printf \'__BUDDY_ENV__:all_proxy=%s\\n\' "$all_proxy"',
  '[ -n "${no_proxy+x}" ] && printf \'__BUDDY_ENV__:no_proxy=%s\\n\' "$no_proxy"',
  '[ -n "${HTTP_PROXY+x}" ] && printf \'__BUDDY_ENV__:HTTP_PROXY=%s\\n\' "$HTTP_PROXY"',
  '[ -n "${HTTPS_PROXY+x}" ] && printf \'__BUDDY_ENV__:HTTPS_PROXY=%s\\n\' "$HTTPS_PROXY"',
  '[ -n "${ALL_PROXY+x}" ] && printf \'__BUDDY_ENV__:ALL_PROXY=%s\\n\' "$ALL_PROXY"',
  '[ -n "${NO_PROXY+x}" ] && printf \'__BUDDY_ENV__:NO_PROXY=%s\\n\' "$NO_PROXY"',
  'true'
].join('\n')

const FISH_ENV_SCRIPT = ['PATH', ...PROXY_VARS]
  .map((name) => `if set -q ${name}; printf '${ENV_MARKER}${name}=%s\\n' (string join : $${name}); end`)
  .join('\n')

const CSH_ENV_SCRIPT = ['PATH', ...PROXY_VARS]
  .map((name) => `if ($?${name}) printf '${ENV_MARKER}${name}=%s\\n' "$${name}"`)
  .join('\n')

function accountLoginShell(): string | undefined {
  try {
    return userInfo().shell || undefined
  } catch {
    return undefined
  }
}

/**
 * The shell whose rc files actually define PATH: $SHELL if set (Finder/launchd
 * usually copies the account shell), otherwise Directory Services / passwd,
 * then the OS default. Never assume the user is on zsh.
 */
export function resolveUserShell(
  env: NodeJS.ProcessEnv = process.env,
  options?: { loginShell?: string | null }
): string {
  const fromEnv = env.SHELL?.trim()
  if (fromEnv) return fromEnv
  const fromAccount = options && 'loginShell' in options ? options.loginShell : accountLoginShell()
  if (fromAccount?.trim()) return fromAccount.trim()
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
}

export function shellKind(shellPath: string): ShellKind {
  const name = basename(shellPath).toLowerCase()
  if (name === 'fish' || name.startsWith('fish-') || name.startsWith('fish.')) return 'fish'
  if (name === 'csh' || name === 'tcsh' || name.startsWith('tcsh')) return 'csh'
  return 'posix'
}

export function loginShellArgs(kind: ShellKind, script: string): string[] {
  // -l loads login rc (PATH often lives there). -i also loads interactive rc
  // (.zshrc, .bashrc, fish interactive snippets). csh can stall on -i without a TTY.
  if (kind === 'csh') return ['-l', '-c', script]
  return ['-il', '-c', script]
}

export function envScriptFor(kind: ShellKind): string {
  if (kind === 'fish') return FISH_ENV_SCRIPT
  if (kind === 'csh') return CSH_ENV_SCRIPT
  return POSIX_ENV_SCRIPT
}

/**
 * Strip OSC/CSI sequences that login shells (iTerm2, Cursor, etc.) inject around
 * prompts. Those decorations often sit on the same line as our env markers and
 * would otherwise make a start-anchored parse miss PATH entirely.
 */
export function stripTerminalDecorations(text: string): string {
  return text
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;:<=>?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[PX^_][\s\S]*?\u001b\\/g, '')
}

export function parseShellEnvOutput(output: string): { path?: string; proxyEnv: Record<string, string> } {
  let path: string | undefined
  const proxyEnv: Record<string, string> = {}

  for (const rawLine of output.split('\n')) {
    const line = stripTerminalDecorations(rawLine.replace(/\r$/, ''))
    const markerAt = line.indexOf(ENV_MARKER)
    if (markerAt < 0) continue
    const rest = line.slice(markerAt + ENV_MARKER.length)
    const eq = rest.indexOf('=')
    if (eq < 0) continue
    const key = rest.slice(0, eq)
    const val = rest.slice(eq + 1)
    if (key === 'PATH') {
      path = val
    } else if (PROXY_VARS.includes(key as any)) {
      proxyEnv[key] = val
    }
  }

  return { path, proxyEnv }
}

export function extractShellEnv(
  shell?: string,
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }
): { path?: string; proxyEnv: Record<string, string> } {
  const env = options?.env ?? process.env
  const shellToRun = shell || resolveUserShell(env)
  const kind = shellKind(shellToRun)
  try {
    const output = execFileSync(shellToRun, loginShellArgs(kind, envScriptFor(kind)), {
      encoding: 'utf8',
      timeout: options?.timeoutMs ?? 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env
    })
    return parseShellEnvOutput(output)
  } catch {
    return { proxyEnv: {} }
  }
}

export function mergePathEntries(basePath: string | undefined, extraPaths: string[] = []): string {
  const current = (basePath ?? '').split(':').filter(Boolean)
  const merged = [...new Set([...extraPaths.filter(Boolean), ...current])]
  return merged.join(':')
}

export function resolveProxyPairs(
  sources: Array<Record<string, string | undefined>>
): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [lower, upper] of PROXY_PAIRS) {
    for (const src of sources) {
      if (!src) continue
      const hasLower = Object.prototype.hasOwnProperty.call(src, lower) && src[lower] !== undefined
      const hasUpper = Object.prototype.hasOwnProperty.call(src, upper) && src[upper] !== undefined

      if (hasLower && hasUpper) {
        result[lower] = src[lower]!
        result[upper] = src[upper]!
        break
      } else if (hasLower) {
        result[lower] = src[lower]!
        result[upper] = src[lower]!
        break
      } else if (hasUpper) {
        result[lower] = src[upper]!
        result[upper] = src[upper]!
        break
      }
    }
  }

  return result
}

export function applyShellProxyEnv(
  targetEnv: Record<string, string | undefined>,
  shellProxy: Record<string, string>
): void {
  const resolved = resolveProxyPairs([targetEnv, shellProxy])
  for (const [key, val] of Object.entries(resolved)) {
    targetEnv[key] = val
  }
}

export function mergeChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrideEnv?: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {}

  // 1. Copy non-proxy variables from baseEnv
  for (const [key, val] of Object.entries(baseEnv)) {
    if (val !== undefined && !PROXY_VARS.includes(key as any)) {
      result[key] = val
    }
  }

  // 2. Overlay non-proxy variables from overrideEnv
  if (overrideEnv) {
    for (const [key, val] of Object.entries(overrideEnv)) {
      if (val !== undefined && !PROXY_VARS.includes(key as any)) {
        result[key] = val
      }
    }
  }

  // 3. Resolve proxy pairs with priority: overrideEnv > baseEnv
  const proxyValues = resolveProxyPairs(overrideEnv ? [overrideEnv, baseEnv] : [baseEnv])
  for (const [key, val] of Object.entries(proxyValues)) {
    result[key] = val
  }

  return result
}

/**
 * Generic PATH fallbacks for GUI apps whose login-shell extraction failed.
 * Includes ~/bin, Homebrew/usr/local, and any existing `$HOME/.<name>/bin`
 * (the usual layout for user-installed CLIs). No per-tool directory names.
 */
export function discoverUserBinDirs(
  home: string,
  extraSystemDirs: string[] = SYSTEM_BIN_DIRS
): string[] {
  const candidates = [join(home, 'bin')]

  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.name.startsWith('.') || entry.name === '.' || entry.name === '..') continue
      candidates.push(join(home, entry.name, 'bin'))
    }
  } catch {
    /* unreadable home directory */
  }

  candidates.push(...extraSystemDirs)
  return [...new Set(candidates.filter((dir) => existsSync(dir)))]
}

export function fixShellPath(): void {
  if (process.platform !== 'darwin') return
  if (process.env.NODE_ENV === 'test') return

  const home = homedir()
  const fallbacks = discoverUserBinDirs(home)

  const shell = resolveUserShell()
  const extracted = extractShellEnv(shell)

  // Prefer the login-shell PATH; append discovered dirs only if they were missing.
  const basePath = extracted.path || process.env.PATH || ''
  process.env.PATH = mergePathEntries(fallbacks.join(':'), basePath.split(':').filter(Boolean))

  applyShellProxyEnv(process.env, extracted.proxyEnv)
}
