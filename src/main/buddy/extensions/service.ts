import { readFile, realpath } from 'node:fs/promises'
import { join, isAbsolute, relative } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { DEFAULT_LAUNCHER_ORDER, normalizeGlobalSettings, normalizeLaunchers } from '../../../shared/defaults'
import type { GlobalSettings, Launcher } from '../../../shared/types'
import type {
  DiscoveredInstance,
  ExtensionActionRequest,
  ExtensionActionResult,
  ExtensionLibraryDir,
  ExtensionPage,
  ExtensionQuery,
  LibrarySnapshot,
  ResolvedTarget
} from '../../../shared/extensions'
import { sameTree } from './skill-copy'
import { describeLocalSkill, scanTarget } from './discover'
import { applyLibraryAction } from './library-apply'
import { probeSavedMcp } from './mcp-probe'
import { installFeaturedMcp } from './mcp-catalog'
import { installFeaturedSkill } from './skill-catalog'
import { installGitSkills, parseGitSource, refreshGitSkills } from './skill-git'
import { ensureLibraryDirs, isManagedInstance, managedKeys, readLibrary } from './library-store'
import { resolveExtensionTarget } from './target-resolver'

const querySchema = z.object({
  kind: z.enum(['skill', 'mcp']).optional(),
  cwd: z.string().max(4096).optional(),
  taskId: z.string().max(200).optional(),
  workspaceKey: z.string().max(200).optional()
})

const actionNameSchema = z.enum(['import', 'import_all', 'find', 'assign', 'remove', 'probe', 'save', 'read', 'sync', 'skill_mode', 'check_updates', 'update'])
const managedKind = z.enum(['instruction', 'subagent', 'hook'])
const actionRequestSchema = z.object({
  action: actionNameSchema,
  kind: z.enum(['skill', 'mcp', 'instruction', 'subagent', 'hook']).optional(),
  instanceId: z.string().max(200).optional(),
  instanceIds: z.array(z.string().max(200)).max(200).optional(),
  libraryItemId: z.string().max(200).optional(),
  actor: z.string().max(80).optional(),
  desired: z.enum(['on', 'off']).optional(),
  mode: z.enum(['link', 'copy']).optional(),
  inherit: z.boolean().optional(),
  replace: z.boolean().optional(),
  source: z.string().max(4096).optional(),
  name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  content: z.string().max(300_000).optional(),
  event: z.string().max(80).optional(),
  matcher: z.string().max(80).optional(),
  command: z.string().max(4096).optional(),
  timeoutSeconds: z.number().int().min(0).max(86400).optional(),
  cwd: z.string().max(4096).optional(),
  taskId: z.string().max(200).optional(),
  workspaceKey: z.string().max(200).optional()
})

export class ExtensionQueryError extends Error {
  constructor(public readonly code: 'invalid_query' | 'task_unreadable') {
    super(code)
  }
}

export interface ExtensionSettingsSource {
  dataRoot: string
  homeDir?: string
  processEnv?: Record<string, string | undefined>
  readGlobalSettings(): Promise<GlobalSettings>
  readTaskContext?(taskId: string, workspaceKey: string): Promise<{ launchers: Record<string, Launcher>; repoRoot: string }>
}

/**
 * Extension page and library actions. This must not call prepareCodexHome or create an agent home.
 * GitHub, GitLab, and owner/repo skills are cloned without a shell. An absolute skill folder can still be found.
 */
export class ExtensionService {
  constructor(private readonly source: ExtensionSettingsSource) {}

  async listTargets(query: ExtensionQuery = {}): Promise<ResolvedTarget[]> {
    const { launchers, cwd } = await this.context(parseQuery(query))
    return this.resolveAll(launchers, cwd)
  }

  async discover(query: ExtensionQuery): Promise<ExtensionPage> {
    const parsed = parseQuery(query)
    if (!parsed.kind) throw new ExtensionQueryError('invalid_query')
    const { launchers, cwd, cwdRejected } = await this.context(parsed)
    const targets = await this.resolveAll(launchers, cwd)
    const scans = []
    for (const target of targets) scans.push(await scanTarget(target, parsed.kind))
    const instances = scans.flatMap((scan) => scan.instances)
    const shared = new Map<string, string[]>()
    for (const instance of instances) {
      const actors = shared.get(instance.shareKey) ?? []
      if (!actors.includes(instance.actor)) actors.push(instance.actor)
      shared.set(instance.shareKey, actors)
    }
    for (const instance of instances) {
      instance.sharedWith = (shared.get(instance.shareKey) ?? []).filter((actor) => actor !== instance.actor)
    }
    const library = await readLibrary(this.source.dataRoot)
    const keys = managedKeys(library)
    const differences = await Promise.all(library.bindings.filter(b => b.management === 'copy' && b.desired === 'on' && b.nativePath).map(async b => {
      const item = library.items.find(i => i.id === b.libraryItemId)
      const source = item?.libraryPath || item?.externalPath
      return source && !(await sameTree(source, b.nativePath!)) ? { libraryItemId: b.libraryItemId, actor: b.actor } : null
    }))
    return {
      kind: parsed.kind,
      copyDifferences: differences.filter((d): d is NonNullable<typeof d> => d !== null),
      cwd,
      cwdRejected,
      readOnly: true,
      generatedAt: new Date().toISOString(),
      targets: scans,
      library,
      found: keys ? instances.filter((instance) => !isManagedInstance(instance, keys)) : instances
    }
  }

  async readLibrary(): Promise<LibrarySnapshot> {
    return readLibrary(this.source.dataRoot)
  }

  async ensureLibraryDir(): Promise<ExtensionLibraryDir> {
    return ensureLibraryDirs(this.source.dataRoot)
  }

  private pending: Promise<unknown> = Promise.resolve()
  private initialized?: Promise<ExtensionActionResult>

  initialize(): Promise<ExtensionActionResult> {
    return this.initialized ??= this.apply({ action: 'sync', kind: 'skill' })
  }

  apply(action: unknown): Promise<ExtensionActionResult> {
    const next = this.pending.then(async () => {
      const result = await this.applyAction(action)
      const request = parseAction(action)
      if (request?.kind === 'skill' && ['import', 'import_all', 'find', 'save'].includes(request.action) && result.results.some(r => r.status === 'changed')) {
        const synced = await this.applyAction({ action: 'sync', kind: 'skill', cwd: request.cwd, taskId: request.taskId, workspaceKey: request.workspaceKey })
        result.results.push(...synced.results)
        result.accepted = result.accepted && synced.accepted
      }
      return result
    })
    this.pending = next.catch(() => undefined)
    return next
  }

  private async applyAction(action: unknown): Promise<ExtensionActionResult> {
    const request = parseAction(action)
    if (!request) return { accepted: false, code: 'unknown_action', results: [] }
    if (request.action === 'check_updates' || request.action === 'update') {
      if (request.kind !== 'skill' || (request.action === 'update' && !request.libraryItemId)) return { accepted: false, code: 'missing_target', results: [] }
      const sync = await this.applyAction({ action: 'sync', kind: 'skill', libraryItemId: request.libraryItemId, cwd: request.cwd, taskId: request.taskId, workspaceKey: request.workspaceKey })
      if (sync.results.some(r => r.status === 'failed')) return sync
      const library = await readLibrary(this.source.dataRoot)
      if (library.status === 'read_failed') return { accepted: false, code: 'library_unreadable', results: [] }
      if (request.libraryItemId && !library.items.some(i => i.id === request.libraryItemId && i.kind === 'skill' && i.repository)) return { accepted: false, code: 'missing_target', results: [] }
      const result = await refreshGitSkills(this.source.dataRoot, library, request.action === 'update' ? request.libraryItemId : undefined, request.replace)
      if (request.action === 'update' && result.accepted) await this.applyAction({ action: 'sync', kind: 'skill', libraryItemId: request.libraryItemId })
      return result
    }
    if (request.action === 'probe') return this.probe(request)
    if (request.action === 'read') return this.readManagedItem(request)
    if (request.action === 'sync' || request.action === 'skill_mode') {
      if (request.kind && request.kind !== 'skill') return { accepted: false, code: 'missing_target', results: [] }
      const library = await readLibrary(this.source.dataRoot)
      if (library.status === 'read_failed') return { accepted: false, code: 'library_unreadable', results: [] }
      const { launchers, cwd } = await this.context(queryFromAction(request))
      const targets = await this.resolveAll(launchers, cwd)
      return applyLibraryAction({
        dataRoot: this.source.dataRoot,
        targets,
        instances: [],
        library,
        request: { ...request, kind: request.kind ?? 'skill' }
      })
    }
    if (request.action === 'find' && request.kind === 'skill' && parseGitSource(request.source ?? '')) {
      const library = await readLibrary(this.source.dataRoot)
      if (library.status === 'read_failed') return { accepted: false, code: 'library_unreadable', results: [] }
      return installGitSkills(this.source.dataRoot, request.source ?? '', library)
    }
    if (request.action === 'save' && request.source?.startsWith('buddy-catalog:')) {
      const library = await readLibrary(this.source.dataRoot)
      if (library.status === 'read_failed') return { accepted: false, code: 'library_unreadable', results: [] }
      const data = {
        version: 1 as const,
        items: library.items.map((item) => ({ ...item })),
        bindings: library.bindings.map((binding) => ({ ...binding })),
        records: [...library.records],
      skillDefaultMode: library.skillDefaultMode,
      skillAgentModes: { ...library.skillAgentModes }
      }
      const catalogId = request.source.slice('buddy-catalog:'.length)
      if (request.kind === 'skill') return installFeaturedSkill(this.source.dataRoot, data, catalogId)
      if (request.kind === 'mcp') return installFeaturedMcp(this.source.dataRoot, data, catalogId)
    }
    if (!request.kind) return { accepted: false, code: 'missing_target', results: [] }
    if (managedKind.safeParse(request.kind).success) {
      if (request.action !== 'save' && request.action !== 'assign' && request.action !== 'remove') {
        return { accepted: false, code: 'unknown_action', results: [] }
      }
      const library = await readLibrary(this.source.dataRoot)
      if (library.status === 'read_failed') return { accepted: false, code: 'library_unreadable', results: [] }
      const { launchers, cwd } = await this.context(queryFromAction(request))
      const targets = await this.resolveAll(launchers, cwd)
      return applyLibraryAction({ dataRoot: this.source.dataRoot, targets, instances: [], library, request })
    }
    if (request.kind !== 'skill' && request.kind !== 'mcp') {
      return { accepted: false, code: 'unknown_action', results: [] }
    }
    const scanKind = request.kind
    const { launchers, cwd } = await this.context(queryFromAction(request))
    const targets = await this.resolveAll(launchers, cwd)
    const instances: DiscoveredInstance[] = []
    for (const target of targets) instances.push(...(await scanTarget(target, scanKind)).instances)
    if (request.action === 'find') return this.findSkill(request, instances, targets)
    const library = await readLibrary(this.source.dataRoot)
    if (library.status === 'read_failed') return { accepted: false, code: 'library_unreadable', results: [] }
    let next = request
    let known = instances
    if (request.action === 'import' && request.source && !request.instanceId && !(request.instanceIds?.length)) {
      const located = await this.locateSkill(request.source, instances, targets)
      if (!located.ok) return located.result
      next = { ...request, instanceId: located.instance.id }
      if (!known.some((item) => item.id === located.instance.id)) known = [...known, located.instance]
    }
    return applyLibraryAction({ dataRoot: this.source.dataRoot, targets, instances: known, library, request: next })
  }

  private async readManagedItem(request: ExtensionActionRequest): Promise<ExtensionActionResult> {
    const kind = z.enum(['skill', 'instruction', 'hook', 'subagent']).safeParse(request.kind)
    if (!kind.success || !request.libraryItemId) {
      return { accepted: false, code: 'missing_target', results: [] }
    }
    const library = await readLibrary(this.source.dataRoot)
    if (library.status === 'read_failed') return { accepted: false, code: 'library_unreadable', results: [] }
    const item = library.items.find((entry) => entry.id === request.libraryItemId && entry.kind === kind.data)
    const source = item?.libraryPath || item?.externalPath
    if (!item || !source) {
      return { accepted: false, code: 'ok', results: [{ actor: '', status: 'failed', code: 'not_found', libraryItemId: request.libraryItemId }] }
    }
    try {
      const content = await readFile(item.kind === 'skill' ? join(source, 'SKILL.md') : source, 'utf8')
      return {
        accepted: true,
        code: 'ok',
        results: [{ actor: '', status: 'skipped', code: 'already', libraryItemId: item.id }],
        content,
        name: item.name
      }
    } catch {
      return { accepted: false, code: 'ok', results: [{ actor: '', status: 'failed', code: 'not_found', libraryItemId: item.id }] }
    }
  }

  private async probe(request: ExtensionActionRequest): Promise<ExtensionActionResult> {
    if (!request.libraryItemId) return { accepted: false, code: 'missing_target', results: [] }
    const library = await readLibrary(this.source.dataRoot)
    if (library.status === 'read_failed') return { accepted: false, code: 'library_unreadable', results: [] }
    const item = library.items.find((entry) => entry.id === request.libraryItemId && entry.kind === 'mcp')
    if (!item?.libraryPath) return { accepted: false, code: 'ok', results: [{ actor: '', status: 'failed', code: 'not_found', libraryItemId: request.libraryItemId }] }
    const cwd = request.cwd && isAbsolute(request.cwd) && !request.cwd.includes('\0') ? request.cwd : undefined
    const result = await probeSavedMcp(item.libraryPath, cwd)
    return { ...result, results: result.results.map((entry) => ({ ...entry, libraryItemId: item.id })) }
  }

  private async findSkill(request: ExtensionActionRequest, instances: DiscoveredInstance[], targets: ResolvedTarget[]): Promise<ExtensionActionResult> {
    if (request.kind !== 'skill') return { accepted: false, code: 'find_not_ready', results: [] }
    const located = await this.locateSkill(request.source ?? '', instances, targets)
    if (!located.ok) return { ...located.result, found: [] }
    return { accepted: true, code: 'ok', results: [], found: [located.instance] }
  }

  private async locateSkill(source: string, instances: DiscoveredInstance[], targets: ResolvedTarget[]): Promise<{ ok: true; instance: DiscoveredInstance } | { ok: false; result: ExtensionActionResult }> {
    const path = localPath(source, this.source.homeDir ?? homedir())
    if (!path) return { ok: false, result: { accepted: false, code: 'find_not_ready', results: [] } }
    const described = await describeLocalSkill(path)
    if (!described.ok) {
      return { ok: false, result: { accepted: true, code: 'ok', results: [{ actor: '', status: 'failed', code: described.code, libraryItemId: null }] } }
    }
    if (insideContent(this.source.dataRoot, described.instance.realpath)) {
      return { ok: false, result: { accepted: true, code: 'ok', results: [{ actor: '', status: 'failed', code: 'unsupported', libraryItemId: null }] } }
    }
    const scanned = instances.find((item) => item.kind === 'skill' && (item.realpath === described.instance.realpath || item.path === described.instance.path))
    return { ok: true, instance: scanned ?? await placeLocalSkill(described.instance, targets) }
  }

  private async resolveAll(launchers: Record<string, Launcher>, cwd: string): Promise<ResolvedTarget[]> {
    const actors: string[] = [...DEFAULT_LAUNCHER_ORDER]
    for (const actor of Object.keys(launchers)) {
      if (!actors.includes(actor)) actors.push(actor)
    }
    const targets: ResolvedTarget[] = []
    for (const actor of actors) {
      targets.push(await resolveExtensionTarget({
        actor,
        launcher: launchers[actor] ?? { command: actor, env: {}, timeout_seconds: 0 },
        cwd,
        homeDir: this.source.homeDir ?? homedir(),
        dataRoot: this.source.dataRoot,
        processEnv: this.source.processEnv ?? process.env
      }))
    }
    return targets
  }

  private async context(query: ExtensionQuery): Promise<{ launchers: Record<string, Launcher>; cwd: string; cwdRejected: boolean }> {
    if ((query.taskId && !query.workspaceKey) || (!query.taskId && query.workspaceKey)) {
      throw new ExtensionQueryError('invalid_query')
    }
    const globalSettings = normalizeGlobalSettings(await this.source.readGlobalSettings())
    let launchers = globalSettings.launchers ?? {}
    let cwd = ''
    let cwdRejected = false
    if (query.cwd) {
      if (!isAbsolute(query.cwd) || query.cwd.includes('\0')) cwdRejected = true
      else cwd = query.cwd
    }
    if (query.taskId && query.workspaceKey) {
      if (!this.source.readTaskContext) throw new ExtensionQueryError('task_unreadable')
      try {
        const task = await this.source.readTaskContext(query.taskId, query.workspaceKey)
        launchers = normalizeLaunchers(task.launchers)
        if (!query.cwd && task.repoRoot && isAbsolute(task.repoRoot)) cwd = task.repoRoot
      } catch (error) {
        if (error instanceof ExtensionQueryError) throw error
        throw new ExtensionQueryError('task_unreadable')
      }
    }
    return { launchers, cwd, cwdRejected }
  }
}

async function placeLocalSkill(instance: DiscoveredInstance, targets: ResolvedTarget[]): Promise<DiscoveredInstance> {
  let homeMatch: DiscoveredInstance | null = null
  for (const target of targets) {
    for (const location of target.locations) {
      if (location.kind !== 'skills' || !location.path) continue
      const root = await realRoot(location.path)
      if (!root || !isStrictChild(root, instance.realpath)) continue
      const system = relative(root, instance.realpath).split(/[\\/]/).includes('.system')
      if (location.scope === 'plugin' || system) {
        return { ...instance, actor: target.actor, scope: 'plugin', ownership: 'plugin', readOnly: true }
      }
      if (!homeMatch && (location.scope === 'user' || location.scope === 'project')) {
        homeMatch = { ...instance, actor: target.actor, scope: location.scope, ownership: 'user', readOnly: false }
      }
    }
  }
  return homeMatch ?? { ...instance, scope: 'shared', ownership: 'shared', readOnly: false }
}

async function realRoot(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

function isStrictChild(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function insideContent(dataRoot: string, physical: string): boolean {
  const rel = relative(join(dataRoot, 'extensions', 'content'), physical)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function localPath(source: string, home: string): string | null {
  const trimmed = source.trim()
  if (!trimmed || trimmed.includes('\0')) return null
  const expanded = trimmed === '~' ? home : trimmed.startsWith('~/') ? join(home, trimmed.slice(2)) : trimmed
  return isAbsolute(expanded) ? expanded : null
}

function parseQuery(query: ExtensionQuery): ExtensionQuery {
  const parsed = querySchema.safeParse(query ?? {})
  if (!parsed.success) throw new ExtensionQueryError('invalid_query')
  return parsed.data
}

function queryFromAction(request: ExtensionActionRequest): ExtensionQuery {
  return {
    kind: request.kind === 'skill' || request.kind === 'mcp' ? request.kind : undefined,
    cwd: request.cwd,
    taskId: request.taskId,
    workspaceKey: request.workspaceKey
  }
}

function parseAction(action: unknown): ExtensionActionRequest | null {
  if (typeof action === 'string') {
    const name = actionNameSchema.safeParse(action)
    return name.success ? { action: name.data } : null
  }
  const parsed = actionRequestSchema.safeParse(action)
  return parsed.success ? parsed.data : null
}
