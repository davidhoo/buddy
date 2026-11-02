import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cap how much of a shim/wrapper script we read — never execute unknown scripts. */
const SHIM_READ_LIMIT = 8192

export type LaunchRuntimeHint = {
  kind: 'node'
  binDir: string
  nodePath?: string
}

export type LaunchSourceHint = 'nvm' | 'fnm' | 'mise' | 'asdf' | 'volta' | 'npm' | 'unknown'

export type LaunchTargetInfo = {
  entryPath: string
  realPath: string
  broken?: boolean
  /** True when the entry is a known manager shim/wrapper script (not a binary). */
  shim?: boolean
  sourceHint?: LaunchSourceHint
  runtime?: LaunchRuntimeHint
}

const SYSTEM_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']
/** Cap per manager so a machine with dozens of Node installs cannot explode scan cost. */
const MAX_NODE_BINS = 8

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function sortVersionNames(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const pa = a.replace(/^v/, '').split(/[^\d]+/).map(n => Number(n) || 0)
    const pb = b.replace(/^v/, '').split(/[^\d]+/).map(n => Number(n) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pb[i] || 0) - (pa[i] || 0)
      if (d) return d
    }
    return b.localeCompare(a)
  })
}

function childBins(root: string, childToBin: (name: string) => string, limit = MAX_NODE_BINS): string[] {
  if (!isDir(root)) return []
  try {
    const names = sortVersionNames(readdirSync(root).filter(name => !name.startsWith('.')))
    const out: string[] = []
    for (const name of names) {
      const bin = childToBin(name)
      if (isDir(bin)) out.push(bin)
      if (out.length >= limit) break
    }
    return out
  } catch {
    return []
  }
}

/** Read `prefix=` from ~/.npmrc only — never spawn npm during discovery. */
export function npmPrefixBin(home = homedir()): string | undefined {
  try {
    const text = readFileSync(join(home, '.npmrc'), 'utf8')
    for (const line of text.split('\n')) {
      const cut = line.indexOf('=')
      if (cut < 0) continue
      if (line.slice(0, cut).trim() !== 'prefix') continue
      let value = line.slice(cut + 1).trim().replace(/^['"]|['"]$/g, '')
      if (value.startsWith('~/')) value = join(home, value.slice(2))
      if (!value.startsWith('/')) return undefined
      const bin = join(value, 'bin')
      return isDir(bin) ? bin : undefined
    }
  } catch { /* missing npmrc */ }
}

function nvmBins(home: string): string[] {
  const nvm = process.env.NVM_DIR && process.env.NVM_DIR.startsWith('/')
    ? process.env.NVM_DIR
    : join(home, '.nvm')
  return childBins(join(nvm, 'versions', 'node'), name => join(nvm, 'versions', 'node', name, 'bin'))
}

function fnmBins(home: string): string[] {
  const roots = [
    process.env.FNM_DIR,
    join(home, '.local/share/fnm'),
    join(home, 'Library/Application Support/fnm')
  ].filter((d): d is string => !!d && d.startsWith('/'))
  const out: string[] = []
  for (const root of roots) {
    out.push(...childBins(join(root, 'node-versions'), name => join(root, 'node-versions', name, 'installation', 'bin')))
    if (out.length >= MAX_NODE_BINS) break
  }
  return out.slice(0, MAX_NODE_BINS)
}

function miseBins(home: string): string[] {
  return childBins(join(home, '.local/share/mise/installs/node'), name => join(home, '.local/share/mise/installs/node', name, 'bin'))
}

/**
 * Bounded extra bin directories for agent discovery. Expands candidates only —
 * does not mutate process.env.PATH. Prefer shell PATH resolution for the
 * default entry; these dirs feed multi-install enumeration and alias lookup.
 */
export function extraDiscoveryBinDirs(home = homedir(), options?: { dirs?: string[] }): string[] {
  if (options?.dirs) return []
  const staticDirs = [
    join(home, 'bin'),
    join(home, '.local/bin'),
    join(home, '.npm-global/bin'),
    join(home, '.npm/bin'),
    join(home, '.bun/bin'),
    join(home, '.volta/bin'),
    join(home, '.asdf/shims'),
    join(home, '.local/share/mise/shims'),
    join(home, '.wecode-cli/bin'),
    join(home, '.cargo/bin'),
    join(home, 'Library/pnpm'),
    join(home, '.local/share/pnpm'),
    ...SYSTEM_BIN_DIRS
  ]
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('.') || entry.name === '.' || entry.name === '..') continue
      staticDirs.push(join(home, entry.name, 'bin'))
    }
  } catch { /* unreadable home */ }

  const prefix = npmPrefixBin(home)
  const versioned = [...nvmBins(home), ...fnmBins(home), ...miseBins(home)]
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of [...staticDirs, ...(prefix ? [prefix] : []), ...versioned]) {
    if (!dir || seen.has(dir) || !isDir(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out
}

export function pathHasExecutable(dir: string, name: string): boolean {
  const candidate = join(dir, name)
  try {
    return existsSync(candidate) && !statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve a known App-bundle CLI path. Only checks the declared relative paths —
 * never walks the whole Applications tree for arbitrary executables.
 */
export function findAppBundledCli(options: {
  appName: string
  relativePaths: string[]
  appRoots?: string[]
  home?: string
}): string | undefined {
  const home = options.home ?? homedir()
  const roots = options.appRoots || ['/Applications', join(home, 'Applications')]
  for (const root of roots) {
    const appRoot = join(root, `${options.appName}.app`)
    if (!isDir(appRoot)) continue
    for (const relative of options.relativePaths) {
      if (!relative || relative.includes('..')) continue
      const candidate = join(appRoot, relative)
      try {
        if (existsSync(candidate) && !statSync(candidate).isDirectory()) return candidate
      } catch { /* unreadable */ }
    }
  }
}

/**
 * Aliases that are too generic to accept by basename alone. Primary product
 * command names and product-specific aliases do not need this gate.
 */
const AMBIGUOUS_ALIASES = new Set(['cbc', 'agent', 'snow'])

/** True when `name` is an ambiguous alias for this recipe (not the primary command). */
export function isAmbiguousAgentAlias(recipe: { command: string; aliases?: string[] }, name: string): boolean {
  const primary = recipe.command.split(/\s+/)[0] || ''
  if (!name || name === primary || name.includes('/')) return false
  return (recipe.aliases || []).includes(name) && AMBIGUOUS_ALIASES.has(name)
}

/**
 * Verify that an ambiguous alias actually belongs to the product. Accepts:
 * - realpath basename matching the primary command (symlink / shim to real binary)
 * - npm/node layout containing the declared package name
 * - known native install path segments
 * Version output alone is never identity evidence.
 */
export function verifyAmbiguousAliasIdentity(options: {
  recipe: { id: string; command: string; aliases?: string[]; npm?: string }
  path: string
  realPath: string
}): { ok: true } | { ok: false; reason: string } {
  const { recipe, path, realPath } = options
  const name = path.split('/').pop() || ''
  if (!isAmbiguousAgentAlias(recipe, name)) return { ok: true }

  const primary = recipe.command.split(/\s+/)[0] || recipe.id
  const targetBase = realPath.split('/').pop() || ''
  if (targetBase === primary) return { ok: true }

  if (recipe.npm) {
    const marker = `/node_modules/${recipe.npm}/`
    if (realPath.includes(marker) || path.includes(marker)) return { ok: true }
    // Walk up from the binary looking for package.json that names the product.
    let dir = realPath.includes('/') ? realPath.slice(0, realPath.lastIndexOf('/')) : ''
    for (let i = 0; i < 8 && dir; i++) {
      const pkgFile = join(dir, 'package.json')
      if (existsSync(pkgFile)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { name?: string }
          if (pkg.name === recipe.npm) return { ok: true }
        } catch { /* unreadable package.json */ }
        break
      }
      const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
      if (!parent || parent === dir) break
      dir = parent
    }
  }

  // CodeBuddy native / app-adjacent layouts occasionally ship `cbc` without npm metadata.
  if (recipe.id === 'codebuddy') {
    if (/\/[Cc]ode[Bb]uddy\//.test(realPath) || /\/codebuddy-code\//.test(realPath)) return { ok: true }
  }
  // Cursor ships `agent` next to cursor-agent in known install trees.
  if (recipe.id === 'cursor') {
    if (/\/\.cursor\//.test(realPath) || /\/cursor-agent\//.test(realPath) || targetBase === 'cursor-agent') return { ok: true }
  }

  return {
    ok: false,
    reason: `Rejected ambiguous alias '${name}' without ${recipe.npm || primary} identity evidence`
  }
}

function isExecutableFile(path: string): boolean {
  try {
    return existsSync(path) && !statSync(path).isDirectory()
  } catch {
    return false
  }
}

function inferSourceHint(entryPath: string, realPath: string): LaunchSourceHint | undefined {
  const hay = `${entryPath}\n${realPath}`
  if (/\/\.nvm\//.test(hay) || /\/versions\/node\//.test(hay)) return 'nvm'
  if (/\/fnm\//.test(hay) || /\/node-versions\//.test(hay)) return 'fnm'
  if (/\/mise\//.test(hay)) return 'mise'
  if (/\/\.asdf\//.test(hay)) return 'asdf'
  if (/\/\.volta\//.test(hay) || /\/volta\//.test(hay)) return 'volta'
  if (/\/node_modules\//.test(hay)) return 'npm'
}

function findNodeRuntimeNear(path: string): LaunchRuntimeHint | undefined {
  let dir = dirname(path)
  for (let i = 0; i < 6 && dir; i++) {
    const nodePath = join(dir, 'node')
    if (isExecutableFile(nodePath)) return { kind: 'node', binDir: dir, nodePath }
    // nvm/fnm/mise layouts keep the CLI under …/bin; node is a sibling there.
    const parent = dirname(dir)
    if (!parent || parent === dir) break
    dir = parent
  }
}

function detectKnownShim(entryPath: string, head: string): { shim: boolean; sourceHint?: LaunchSourceHint } {
  const underShims = /\/(?:\.asdf\/shims|\.local\/share\/mise\/shims|mise\/shims|\.volta\/bin)\//.test(entryPath)
  if (underShims) {
    if (/\basdf\b/.test(head) || /\/\.asdf\/shims\//.test(entryPath)) return { shim: true, sourceHint: 'asdf' }
    if (/\bmise\b|\brtx\b/.test(head) || /mise\/shims/.test(entryPath)) return { shim: true, sourceHint: 'mise' }
    if (/\bvolta\b/.test(head) || /\/\.volta\//.test(entryPath)) return { shim: true, sourceHint: 'volta' }
    return { shim: true }
  }
  // Bounded signature only — never exec unknown wrappers to guess identity.
  if (/^\s*exec\s+asdf\b/m.test(head) || /\basdf\s+exec\b/.test(head)) return { shim: true, sourceHint: 'asdf' }
  if (/^\s*exec\s+(?:mise|rtx)\b/m.test(head)) return { shim: true, sourceHint: 'mise' }
  if (/\bvolta[-_]/.test(head) || /\bvolta\s+run\b/.test(head)) return { shim: true, sourceHint: 'volta' }
  return { shim: false }
}

/**
 * Bounded, read-only inspection of a launch entry. Resolves symlinks, detects
 * known manager shims from path + script head, and locates a sibling Node
 * runtime for `#!/usr/bin/env node` CLIs. Does not execute unknown scripts.
 */
export function inspectLaunchTarget(entryPath: string): LaunchTargetInfo {
  if (!entryPath) return { entryPath: '', realPath: '', broken: true }
  try {
    const st = lstatSync(entryPath)
    if (st.isSymbolicLink()) {
      try {
        realpathSync(entryPath)
      } catch {
        return { entryPath, realPath: entryPath, broken: true }
      }
    } else if (!st.isFile() && !st.isDirectory()) {
      // Unusual file types are not runnable agent entrypoints.
      return { entryPath, realPath: entryPath, broken: true }
    }
  } catch {
    return { entryPath, realPath: entryPath, broken: true }
  }

  let realPath = entryPath
  try {
    realPath = realpathSync(entryPath)
  } catch {
    return { entryPath, realPath: entryPath, broken: true }
  }

  let sourceHint = inferSourceHint(entryPath, realPath)
  let shim = false
  let runtime = findNodeRuntimeNear(realPath) || findNodeRuntimeNear(entryPath)

  try {
    const st = statSync(realPath)
    if (st.isFile() && st.size > 0) {
      const head = readFileHead(realPath, SHIM_READ_LIMIT)
      if (head.startsWith('#!')) {
        const detected = detectKnownShim(entryPath, head)
        if (detected.shim) {
          shim = true
          sourceHint = detected.sourceHint || sourceHint
        }
        const firstLine = head.split('\n', 1)[0] || ''
        if (/env\s+node\b|\/node(?:\s|$)/.test(firstLine)) {
          runtime = runtime || findNodeRuntimeNear(realPath) || findNodeRuntimeNear(entryPath)
        }
      } else if (detectKnownShim(entryPath, '').shim) {
        shim = true
        sourceHint = sourceHint || inferSourceHint(entryPath, realPath)
      }
    }
  } catch {
    /* unreadable target — still return path info; callers must not exec to probe */
  }

  return {
    entryPath,
    realPath,
    shim: shim || undefined,
    sourceHint: sourceHint || (shim ? 'unknown' : undefined),
    runtime
  }
}

function readFileHead(path: string, limit: number): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(limit)
    const n = readSync(fd, buf, 0, limit, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * Build an env overlay so discovery, version probes, ACP, and task launches share
 * a compatible runtime. Especially important for off-PATH Node installs where
 * `#!/usr/bin/env node` would otherwise pick Buddy's process Node.
 *
 * Does not mutate process.env. Paths may contain spaces — pass the resolved
 * absolute executable path (not a shell command string).
 */
export function withCompatibleRuntimeEnv(
  command: string,
  env?: Record<string, string>
): Record<string, string> {
  const base: Record<string, string> = { ...(env || {}) }
  // Bare names stay on PATH; only absolute/relative filesystem entries get runtime pinning.
  if (!command || !(command.startsWith('/') || command.startsWith('./') || command.startsWith('../'))) {
    return base
  }

  const info = inspectLaunchTarget(command)
  const prefixes: string[] = []
  const entryDir = dirname(command)
  if (entryDir && entryDir !== '.') prefixes.push(entryDir)
  if (info.runtime?.binDir) prefixes.push(info.runtime.binDir)
  if (info.realPath && info.realPath !== command) {
    const realDir = dirname(info.realPath)
    if (realDir && realDir !== '.') prefixes.push(realDir)
  }

  const existing = (base.PATH ?? process.env.PATH ?? '').split(':').filter(Boolean)
  const seen = new Set<string>()
  const PATH = [...prefixes, ...existing].filter(dir => {
    if (!dir || seen.has(dir)) return false
    seen.add(dir)
    return true
  }).join(':')
  return { ...base, PATH }
}

/** Prefer the shell/current entry; never auto-pick a numerically newer install. */
export function preferShellOrExplicitInstall<T extends { path: string }>(
  installs: T[],
  options?: { explicitPath?: string; shellPath?: string }
): T | undefined {
  if (!installs.length) return undefined
  if (options?.explicitPath) {
    const match = installs.find(item => item.path === options.explicitPath)
    if (match) return match
  }
  if (options?.shellPath) {
    const match = installs.find(item => item.path === options.shellPath)
    if (match) return match
  }
  return installs[0]
}
