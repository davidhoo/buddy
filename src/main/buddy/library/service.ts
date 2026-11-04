import type { AgentManagementService } from '../agents/service'
import type {
  LibraryBatchResult,
  LibraryOpResult,
  LibrarySnapshot
} from '../../../shared/library'
import { discoverMcpServers, discoverSkills } from './discovery'
import { addServer, assignServerToTarget, importDiscoveredServer } from './mcp'
import { authGuidance, openTerminalGuidance, probeAuth } from './native-auth'
import { assignSkillToTarget, ejectSkill, importDiscoveredSkill } from './skills'
import { LibraryStore } from './store'
import { resolveLibraryTargets } from './targets'
import { ensureCodexAcpHome } from './ensure-codex-acp-home'

export class LibraryService {
  private readonly store: LibraryStore
  private queue: Promise<unknown> = Promise.resolve()
  private cache?: LibrarySnapshot
  private refreshing = false

  constructor(
    dataRoot: string,
    private readonly agents: AgentManagementService
  ) {
    this.store = new LibraryStore(dataRoot)
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  async getSnapshot(force = false): Promise<LibrarySnapshot> {
    if (!force && this.cache && !this.refreshing) return this.cache
    return this.refresh(force)
  }

  async refresh(force = false): Promise<LibrarySnapshot> {
    if (this.refreshing && this.cache && !force) {
      return { ...this.cache, refreshing: true }
    }
    this.refreshing = true
    try {
      await this.store.ensureLayout()
      const inventory = await this.agents.getInventory()
      const meta = await this.store.readMeta()
      const targets = await resolveLibraryTargets(inventory.agents, this.store.dataRoot)
      const [discoveredSkills, discoveredServers] = await Promise.all([
        discoverSkills(targets, meta.skills),
        discoverMcpServers(targets, meta.servers)
      ])
      // Auth probes only for already-assigned Claude servers (static, no network).
      const auth = []
      for (const server of meta.servers) {
        for (const targetId of server.assignedTargetIds) {
          const target = targets.find((t) => t.targetId === targetId)
          if (!target?.capabilities.authProbe) continue
          auth.push(await probeAuth(target, server.name))
        }
      }
      this.cache = {
        schemaVersion: 1,
        scannedAt: new Date().toISOString(),
        refreshing: false,
        targets,
        skills: meta.skills,
        discoveredSkills: discoveredSkills.filter((d) => !d.alreadyImported),
        servers: meta.servers,
        discoveredServers: discoveredServers.filter((d) => !d.alreadyImported),
        auth
      }
      return this.cache
    } catch (error) {
      const fallback: LibrarySnapshot = this.cache || {
        schemaVersion: 1,
        refreshing: false,
        targets: [],
        skills: [],
        discoveredSkills: [],
        servers: [],
        discoveredServers: [],
        auth: []
      }
      this.cache = { ...fallback, refreshing: false, error: (error as Error).message }
      return this.cache
    } finally {
      this.refreshing = false
      if (this.cache) this.cache.refreshing = false
    }
  }

  importSkills(discoveryIds: string[]): Promise<LibraryBatchResult> {
    return this.enqueue(async () => {
      const snap = await this.getSnapshot(true)
      const results: LibraryOpResult[] = []
      for (const id of discoveryIds) {
        const discovered = (await discoverSkills(snap.targets, snap.skills)).find((d) => d.discoveryId === id)
        if (!discovered) {
          results.push({ status: 'failed', message: `not found: ${id}` })
          continue
        }
        results.push(await importDiscoveredSkill(this.store, discovered, snap.targets))
      }
      await this.refresh(true)
      return { results }
    })
  }

  setSkillAssignment(skillId: string, targetId: string, enabled: boolean): Promise<LibraryOpResult> {
    return this.enqueue(async () => {
      const snap = await this.getSnapshot(true)
      const target = snap.targets.find((t) => t.targetId === targetId)
      if (!target) return { status: 'failed', message: 'target not found' }
      const result = await assignSkillToTarget(this.store, skillId, target, enabled)
      await this.refresh(true)
      return result
    })
  }

  ejectSkill(skillId: string): Promise<LibraryOpResult> {
    return this.enqueue(async () => {
      const result = await ejectSkill(this.store, skillId)
      await this.refresh(true)
      return result
    })
  }

  addServer(name: string, raw: Record<string, unknown>): Promise<LibraryOpResult> {
    return this.enqueue(async () => {
      const result = await addServer(this.store, name, raw)
      if (result.status === 'ok') await this.refresh(true)
      return result
    })
  }

  importServers(discoveryIds: string[]): Promise<LibraryBatchResult> {
    return this.enqueue(async () => {
      const snap = await this.getSnapshot(true)
      const all = await discoverMcpServers(snap.targets, snap.servers)
      const results: LibraryOpResult[] = []
      for (const id of discoveryIds) {
        const discovered = all.find((d) => d.discoveryId === id) || snap.discoveredServers.find((d) => d.discoveryId === id)
        if (!discovered) {
          results.push({ status: 'failed', message: `not found: ${id}` })
          continue
        }
        results.push(await importDiscoveredServer(this.store, discovered))
      }
      await this.refresh(true)
      return { results }
    })
  }

  setServerAssignment(serverId: string, targetId: string, enabled: boolean): Promise<LibraryOpResult> {
    return this.enqueue(async () => {
      const snap = await this.getSnapshot(true)
      const target = snap.targets.find((t) => t.targetId === targetId)
      if (!target) return { status: 'failed', message: 'target not found' }
      const result = await assignServerToTarget(this.store, this.store.dataRoot, serverId, target, enabled)
      await this.refresh(true)
      return result
    })
  }

  async openAuthGuidance(targetId: string, serverName: string): Promise<{ title: string; steps: string[] }> {
    const snap = await this.getSnapshot()
    const target = snap.targets.find((t) => t.targetId === targetId)
    if (!target) return { title: '未知目标', steps: ['目标不存在'] }
    const guide = authGuidance(target, serverName)
    openTerminalGuidance(guide.cwd, `${guide.title}\n${guide.steps.join('\n')}`)
    return { title: guide.title, steps: guide.steps }
  }

  async openLibraryDir(): Promise<string> {
    await this.store.ensureLayout()
    return this.store.root()
  }

  async openBackupsDir(): Promise<string> {
    await this.store.ensureLayout()
    return this.store.backupsDir()
  }

  ensureAcpHome(agentId: string): Promise<{ home: string; notes: string[] }> {
    return this.enqueue(async () => {
      const result = await ensureCodexAcpHome(this.store.dataRoot, agentId)
      await this.refresh(true)
      return { home: result.home, notes: result.notes }
    })
  }
}
