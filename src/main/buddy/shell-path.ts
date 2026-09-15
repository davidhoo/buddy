import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const INSTALL_HINTS: Record<string, string> = {
  kimi: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  'cursor-agent': 'curl -fsS https://cursor.com/install | bash',
  agent: 'curl -fsS https://cursor.com/install | bash',
  agy: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  opencode: 'go install github.com/sst/opencode@latest'
}

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

const SHELL_ENV_SCRIPT = [
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

export function parseShellEnvOutput(output: string): { path?: string; proxyEnv: Record<string, string> } {
  let path: string | undefined
  const proxyEnv: Record<string, string> = {}

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const match = /^__BUDDY_ENV__:([A-Za-z_]+)=(.*)$/.exec(line)
    if (!match) continue
    const [, key, val] = match
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
  const shellToRun = shell || process.env.SHELL || '/bin/zsh'
  try {
    const output = execFileSync(shellToRun, ['-il', '-c', SHELL_ENV_SCRIPT], {
      encoding: 'utf8',
      timeout: options?.timeoutMs ?? 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: options?.env ?? process.env
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

export function fixShellPath(): void {
  if (process.platform !== 'darwin') return
  if (process.env.NODE_ENV === 'test') return

  const home = homedir()
  const extras = [
    join(home, '.kimi-code/bin'),
    join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.npm-global/bin'),
    join(home, '.cargo/bin')
  ]

  const shell = process.env.SHELL || '/bin/zsh'
  const extracted = extractShellEnv(shell)

  const basePath = extracted.path || process.env.PATH || ''
  process.env.PATH = mergePathEntries(basePath, extras)

  applyShellProxyEnv(process.env, extracted.proxyEnv)
}
