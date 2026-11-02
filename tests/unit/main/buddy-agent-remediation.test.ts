import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BuddyStore } from '../../../src/main/buddy/store'
import { AgentManagementService } from '../../../src/main/buddy/agents/service'
import { BuddyCoreService } from '../../../src/main/buddy/service'
import {
  MODEL_CACHE_FILE,
  ModelCatalogDiskCache,
  modelCatalogCacheKey
} from '../../../src/main/buddy/model-cache'
import {
  resolveEffectiveAgentLaunch,
  resolveProtocolLauncher,
  agentTaskSelectable
} from '../../../src/shared/agents'
import { normalizeLauncher } from '../../../src/shared/defaults'
import { verifyAmbiguousAliasIdentity } from '../../../src/main/buddy/agents/discovery'
import type { AcpModelList } from '../../../src/shared/types'

const fakeAcp = (root: string, mode: 'ok' | 'init-fail' | 'auth-fail') => `#!${process.execPath}
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    if (${JSON.stringify(mode)} === 'init-fail') {
      console.log(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:'temporary initialize failure'}}))
      return
    }
    console.log(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:1}}))
    return
  }
  if (message.method === 'session/new') {
    if (${JSON.stringify(mode)} === 'auth-fail') {
      console.log(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'Authentication token has expired. Please run: qwen login'}}))
      return
    }
    console.log(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{sessionId:'s1'}}))
  }
})
`

describe('R1: discovered ACP flows into task launcher resolution', () => {
  it('uses inventory selectedProtocol/acp when no explicit user config exists', () => {
    const agent = {
      id: 'qwen', installationId: 'q', name: 'Qwen', path: '/tmp/qwen', realPath: '/tmp/qwen',
      source: 'unknown' as const, runnable: false, enabled: true, selectedProtocol: 'acp' as const,
      cli: { command: '/tmp/qwen', args: [], env: {}, timeout_seconds: 20 },
      acp: { command: '/tmp/qwen', args: ['--acp'], env: {}, timeout_seconds: 20, protocol: 'acp' as const },
      acpStatus: 'verified' as const
    }
    const { protocol, launcher } = resolveEffectiveAgentLaunch(agent)
    expect(protocol).toBe('acp')
    expect(launcher?.command).toBe('/tmp/qwen')
    expect(launcher?.args).toEqual(['--acp'])
    const normalized = normalizeLauncher('qwen', { ...launcher!, protocol })
    expect(normalized.protocol).toBe('acp')
    expect(normalized.command).toBe('/tmp/qwen')
    expect(normalized.args).toEqual(['--acp'])
  })

  it('keeps explicit CLI and does not let discovery override it', () => {
    const agent = {
      id: 'qwen', installationId: 'q', name: 'Qwen', path: '/tmp/qwen', realPath: '/tmp/qwen',
      source: 'unknown' as const, runnable: false, enabled: true, selectedProtocol: 'acp' as const,
      cli: { command: '/tmp/qwen', args: [], env: {}, timeout_seconds: 20 },
      acp: { command: '/tmp/qwen', args: ['--acp'], env: {}, timeout_seconds: 20, protocol: 'acp' as const },
      acpStatus: 'verified' as const
    }
    const { protocol } = resolveEffectiveAgentLaunch(agent, {
      agentConfig: { protocol: 'cli', cli: agent.cli },
      savedLauncher: { ...agent.cli, protocol: 'cli' }
    })
    expect(protocol).toBe('cli')
  })

  it('resolveProtocolLauncher returns ACP entry while selected protocol stays CLI', () => {
    const agent = {
      id: 'cursor', installationId: 'c', name: 'Cursor', path: '/tmp/cursor-agent', realPath: '/tmp/cursor-agent',
      source: 'unknown' as const, runnable: true, enabled: true, selectedProtocol: 'cli' as const,
      cli: { command: '/tmp/cursor-agent', args: [], env: {}, timeout_seconds: 20 },
      acp: { command: '/tmp/cursor-agent', args: ['acp'], env: {}, timeout_seconds: 20, protocol: 'acp' as const },
      acpStatus: 'verified' as const
    }
    const options = {
      agentConfig: { protocol: 'cli' as const, cli: agent.cli, acp: agent.acp },
      savedLauncher: { ...agent.cli, protocol: 'cli' as const }
    }
    expect(resolveEffectiveAgentLaunch(agent, options).protocol).toBe('cli')
    expect(resolveProtocolLauncher('acp', agent, options)?.args).toEqual(['acp'])
    expect(resolveProtocolLauncher('cli', agent, options)?.command).toBe('/tmp/cursor-agent')
  })

  it('discovers qwen ACP and configure(enabled) preserves ACP protocol', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-r1-qwen-'))
    try {
      const bin = join(root, 'bin')
      await mkdir(bin)
      const qwen = join(bin, 'qwen')
      await writeFile(qwen, fakeAcp(root, 'ok'), { mode: 0o755 })
      const store = new BuddyStore(join(root, 'data'))
      const service = new AgentManagementService(store, {
        dirs: [bin],
        appRoots: [],
        recipes: [{ id: 'qwen', name: 'Qwen Code', command: 'qwen', acp: ['--acp'], modelFlag: '--model' }],
        run: async () => '0.1.0'
      })
      const [agent] = await service.list()
      expect(agent.selectedProtocol).toBe('acp')
      expect(agent.acpStatus).toBe('verified')
      expect(agentTaskSelectable(agent)).toBe(true)
      await service.configure('qwen', { enabled: true })
      const settings = await store.readGlobalSettings()
      expect(settings.launchers?.qwen?.protocol).toBe('acp')
      expect(settings.agent_management?.qwen?.protocol).toBe('acp')
      expect(settings.launchers?.qwen?.args).toEqual(['--acp'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('R2: ACP handshake failures recover on rescan; auth needs re-verify', () => {
  it('clears a temporary handshake failure after the same target succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-r2-handshake-'))
    try {
      const command = join(root, 'qwen')
      await writeFile(command, fakeAcp(root, 'init-fail'), { mode: 0o755 })
      const store = new BuddyStore(join(root, 'data'))
      const service = new AgentManagementService(store, {
        dirs: [root],
        appRoots: [],
        recipes: [{ id: 'qwen', name: 'Qwen', command: 'qwen', acp: ['--acp'] }],
        run: async () => '1.0.0'
      })
      const [failed] = await service.list()
      expect(failed.acpStatus).toBe('failed')
      expect(failed.acpFailureStage).toBe('handshake')
      expect(agentTaskSelectable(failed)).toBe(false)

      await writeFile(command, fakeAcp(root, 'ok'), { mode: 0o755 })
      const [recovered] = await service.list(true)
      expect(recovered.acpStatus).toBe('verified')
      expect(recovered.acpFailureStage).toBeUndefined()
      expect(agentTaskSelectable(recovered)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps session auth failure after handshake-only rescan, then clears via probe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-r2-auth-'))
    try {
      const command = join(root, 'adapter')
      await writeFile(command, fakeAcp(root, 'auth-fail'), { mode: 0o755 })
      const store = new BuddyStore(join(root, 'data'))
      await store.updateGlobalSettings({
        agent_management: { qwen: { protocol: 'acp', acp: { command, args: [], env: {}, timeout_seconds: 20, protocol: 'acp' } } },
        launchers: { qwen: { command, args: [], env: {}, timeout_seconds: 20, protocol: 'acp' } }
      })
      const service = new AgentManagementService(store, {
        dirs: [root],
        appRoots: [],
        recipes: [{ id: 'qwen', name: 'Qwen', command: 'qwen', adapter: 'adapter' }],
        run: async () => '1.0.0'
      })
      const [scanned] = await service.list()
      expect(scanned.acpStatus).toBe('verified')
      const probed = await service.probe('qwen')
      expect(probed.acpStatus).toBe('failed')
      expect(probed.acpFailureStage).toBe('session')

      const [stillFailed] = await service.list(true)
      expect(stillFailed.acpStatus).toBe('failed')
      expect(stillFailed.acpFailureStage).toBe('session')

      await writeFile(command, fakeAcp(root, 'ok'), { mode: 0o755 })
      const recovered = await service.probe('qwen')
      expect(recovered.acpStatus).toBe('verified')
      expect(recovered.acpFailureStage).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('R3: model cache disk keys never store plaintext credentials', () => {
  it('writes digest keys and migrates away legacy plaintext cache files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-r3-cache-'))
    const dataRoot = join(root, 'data')
    const globalDir = join(dataRoot, 'global')
    await mkdir(globalDir, { recursive: true })
    const secret = 'sk-test-secret-DO-NOT-KEEP'
    const diskPath = join(globalDir, MODEL_CACHE_FILE)
    await writeFile(diskPath, JSON.stringify({
      schemaVersion: 1,
      entries: {
        [JSON.stringify(['agy', 'agy', [], { API_KEY: secret }])]: {
          models: [{ id: 'flash', name: 'Flash' }],
          fetchedAt: new Date().toISOString()
        }
      }
    }))

    try {
      const cache = new ModelCatalogDiskCache(dataRoot)
      await cache.ensureLoaded()
      expect(cache.didMigrate()).toBe(true)
      const afterMigrate = await readFile(diskPath, 'utf8')
      expect(afterMigrate).not.toContain(secret)
      expect(afterMigrate).not.toContain('API_KEY')
      expect(JSON.parse(afterMigrate).schemaVersion).toBe(2)

      const keyA = modelCatalogCacheKey({
        protocol: 'cli', actor: 'agy', command: 'agy', args: [], env: { API_KEY: secret }
      })
      const keyB = modelCatalogCacheKey({
        protocol: 'cli', actor: 'agy', command: 'agy', args: [], env: { API_KEY: 'other-secret' }
      })
      const keyOrder = modelCatalogCacheKey({
        protocol: 'cli', actor: 'agy', command: 'agy', args: [], env: { Z: '1', API_KEY: secret }
      })
      const keyOrder2 = modelCatalogCacheKey({
        protocol: 'cli', actor: 'agy', command: 'agy', args: [], env: { API_KEY: secret, Z: '1' }
      })
      expect(keyA).not.toEqual(keyB)
      expect(keyOrder).toEqual(keyOrder2)
      expect(keyA).toMatch(/^[a-f0-9]{64}$/)
      expect(keyA).not.toContain(secret)

      await cache.set(keyA, { models: [{ id: 'flash', name: 'Flash' }] })
      const written = await readFile(diskPath, 'utf8')
      expect(written).not.toContain(secret)
      expect(written).toContain(keyA)

      const service = new BuddyCoreService({ dataRoot })
      const agents = (service as unknown as {
        agents: {
          getInventory: () => Promise<unknown>
          models: (id: string) => Promise<AcpModelList>
        }
      }).agents
      vi.spyOn(agents, 'getInventory').mockResolvedValue({
        agents: [{
          id: 'agy',
          selectedProtocol: 'cli',
          runnable: true,
          cli: { command: 'agy', args: [], env: { API_KEY: secret }, timeout_seconds: 20 }
        }]
      })
      vi.spyOn(agents, 'models').mockResolvedValue({ models: [{ id: 'm', name: 'M' }] })
      await service.listCliModels('agy')
      await vi.waitFor(async () => {
        const raw = await readFile(diskPath, 'utf8')
        expect(raw).not.toContain(secret)
        expect(JSON.parse(raw).schemaVersion).toBe(2)
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('R4: ambiguous aliases require product identity', () => {
  it('rejects a same-named cbc without CodeBuddy package identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-r4-fake-cbc-'))
    try {
      const bin = join(root, 'bin')
      await mkdir(bin)
      await writeFile(join(bin, 'cbc'), '#!/bin/sh\necho 9.9.9\n', { mode: 0o755 })
      const store = new BuddyStore(join(root, 'data'))
      const service = new AgentManagementService(store, {
        dirs: [bin],
        appRoots: [],
        recipes: [{ id: 'codebuddy', name: 'CodeBuddy', command: 'codebuddy', aliases: ['cbc'], acp: ['--acp'], npm: '@tencent-ai/codebuddy-code' }],
        run: async () => '9.9.9'
      })
      vi.spyOn(service as unknown as { probeTarget(a: unknown): Promise<unknown> }, 'probeTarget')
        .mockImplementation(async (agent: { acpStatus?: string }) => agent)
      const agents = await service.list()
      expect(agents.find(a => a.id === 'codebuddy')).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts cbc when realpath basename is the primary command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-r4-real-cbc-'))
    try {
      const primary = join(root, 'primary'), aliasDir = join(root, 'alias')
      await mkdir(primary); await mkdir(aliasDir)
      const target = join(primary, 'codebuddy')
      await writeFile(target, '#!/bin/sh\necho 1.2.3\n', { mode: 0o755 })
      await symlink(target, join(aliasDir, 'cbc'))
      const identity = verifyAmbiguousAliasIdentity({
        recipe: { id: 'codebuddy', command: 'codebuddy', aliases: ['cbc'], npm: '@tencent-ai/codebuddy-code' },
        path: join(aliasDir, 'cbc'),
        realPath: target
      })
      expect(identity.ok).toBe(true)

      const store = new BuddyStore(join(root, 'data'))
      const service = new AgentManagementService(store, {
        dirs: [aliasDir],
        appRoots: [],
        recipes: [{ id: 'codebuddy', name: 'CodeBuddy', command: 'codebuddy', aliases: ['cbc'], acp: ['--acp'], npm: '@tencent-ai/codebuddy-code' }],
        run: async () => '1.2.3'
      })
      vi.spyOn(service as unknown as { probeTarget(a: unknown): Promise<unknown> }, 'probeTarget')
        .mockImplementation(async (agent: { acpStatus?: string }) => {
          agent.acpStatus = 'verified'
          return agent
        })
      const [agent] = await service.list()
      expect(agent.id).toBe('codebuddy')
      expect(agent.path).toBe(join(aliasDir, 'cbc'))
      expect(agent.runnable).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts cbc under the declared npm package layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-r4-npm-cbc-'))
    try {
      const pkg = join(root, 'node_modules/@tencent-ai/codebuddy-code')
      const bin = join(pkg, 'bin')
      await mkdir(bin, { recursive: true })
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@tencent-ai/codebuddy-code', version: '1.0.0' }))
      const binary = join(bin, 'cbc')
      await writeFile(binary, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 })
      const identity = verifyAmbiguousAliasIdentity({
        recipe: { id: 'codebuddy', command: 'codebuddy', aliases: ['cbc'], npm: '@tencent-ai/codebuddy-code' },
        path: binary,
        realPath: binary
      })
      expect(identity.ok).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a verified CodeBuddy install when a fake cbc also exists; fake never becomes update target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-r4-multi-cbc-'))
    try {
      const realDir = join(root, 'real'), fakeDir = join(root, 'fake')
      await mkdir(realDir); await mkdir(fakeDir)
      const realPrimary = join(realDir, 'codebuddy')
      await writeFile(realPrimary, '#!/bin/sh\necho 2.0.0\n', { mode: 0o755 })
      await symlink(realPrimary, join(realDir, 'cbc'))
      await writeFile(join(fakeDir, 'cbc'), '#!/bin/sh\necho 9.9.9\n', { mode: 0o755 })

      const store = new BuddyStore(join(root, 'data'))
      const service = new AgentManagementService(store, {
        // Fake dir first in PATH — must not win over the verified real install.
        dirs: [fakeDir, realDir],
        appRoots: [],
        recipes: [{ id: 'codebuddy', name: 'CodeBuddy', command: 'codebuddy', aliases: ['cbc'], acp: ['--acp'], npm: '@tencent-ai/codebuddy-code' }],
        run: async () => '2.0.0'
      })
      vi.spyOn(service as unknown as { probeTarget(a: unknown): Promise<unknown> }, 'probeTarget')
        .mockImplementation(async (agent: { acpStatus?: string }) => {
          agent.acpStatus = 'verified'
          return agent
        })
      const agents = await service.list()
      const agent = agents.find(a => a.id === 'codebuddy')
      expect(agent).toBeDefined()
      expect(agent!.runnable).toBe(true)
      expect(agent!.path).toBe(realPrimary)
      expect(agent!.installations?.every(i => !i.path.endsWith('/fake/cbc'))).toBe(true)
      expect(agentTaskSelectable(agent!)).toBe(true)
      // No nativeUpdate for unknown source without help-derived updater; package stays CodeBuddy's.
      expect(agent!.package).toBe('@tencent-ai/codebuddy-code')
      expect(agent!.installations?.some(i => i.path === join(fakeDir, 'cbc'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('blocking review regressions', () => {
  it('R2: legacy failed without fingerprint/stage is not washed to verified by handshake rescan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-r2-legacy-wash-'))
    try {
      const command = join(root, 'adapter')
      await writeFile(command, fakeAcp(root, 'ok'), { mode: 0o755 })
      const store = new BuddyStore(join(root, 'data'))
      await store.updateGlobalSettings({
        agent_management: { qwen: { protocol: 'acp', acp: { command, args: [], env: {}, timeout_seconds: 20, protocol: 'acp' } } },
        launchers: { qwen: { command, args: [], env: {}, timeout_seconds: 20, protocol: 'acp' } }
      })
      const service = new AgentManagementService(store, {
        dirs: [root],
        appRoots: [],
        recipes: [{ id: 'qwen', name: 'Qwen', command: 'qwen', adapter: 'adapter' }],
        run: async () => '1.0.0'
      })
      // Seed inventory with a legacy failed row (no stage / fingerprint), then rescan.
      const seeded = await service.list()
      expect(seeded[0]?.acp).toBeDefined()
      const inventory = (service as unknown as { inventory: Array<Record<string, unknown>> }).inventory
      inventory[0] = {
        ...inventory[0],
        acpStatus: 'failed',
        acpError: 'Authentication token has expired. Please run: qwen login'
      }
      delete inventory[0].acpFailureStage
      delete inventory[0].acpLaunchFingerprint

      const [afterScan] = await service.list(true)
      expect(afterScan.acpStatus).toBe('failed')
      expect(afterScan.acpFailureStage).toBe('unknown')
      expect(agentTaskSelectable(afterScan)).toBe(false)

      const recovered = await service.probe('qwen')
      expect(recovered.acpStatus).toBe('verified')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('R3: initializeAgents migrates plaintext model cache without any model query', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-r3-startup-'))
    const dataRoot = join(root, 'data')
    await mkdir(join(dataRoot, 'global'), { recursive: true })
    const secret = 'sk-startup-must-erase'
    const diskPath = join(dataRoot, 'global', MODEL_CACHE_FILE)
    await writeFile(diskPath, JSON.stringify({
      schemaVersion: 1,
      entries: {
        [JSON.stringify(['agy', 'agy', [], { API_KEY: secret }])]: {
          models: [{ id: 'x', name: 'X' }],
          fetchedAt: new Date().toISOString()
        }
      }
    }))
    try {
      const core = new BuddyCoreService({ dataRoot })
      await core.initializeAgents()
      const raw = await readFile(diskPath, 'utf8')
      expect(raw).not.toContain(secret)
      expect(raw).not.toContain('API_KEY')
      expect(JSON.parse(raw).schemaVersion).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('R1: model list uses task launcher context instead of guessing global settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-r1-task-ctx-'))
    const dataRoot = join(root, 'data')
    const repoRoot = join(root, 'repo')
    await mkdir(repoRoot)
    try {
      const store = new BuddyStore(dataRoot)
      // Global says CLI; task says ACP with a distinct command — query must follow the task.
      await store.updateGlobalSettings({
        launchers: {
          qwen: { command: '/global/qwen', args: [], env: { FROM: 'global' }, timeout_seconds: 20, protocol: 'cli' }
        }
      })
      const created = await store.createTask({
        task_id: 't-r1',
        task_text: 'x',
        repo_root: repoRoot,
        settings: {
          implementer_actor: 'qwen',
          reviewer_actor: 'qwen',
          launchers: {
            qwen: {
              command: '/task/qwen',
              args: ['--acp'],
              env: { FROM: 'task' },
              timeout_seconds: 20,
              protocol: 'acp'
            }
          }
        }
      })
      const core = new BuddyCoreService({ dataRoot })
      const resolved = await (core as unknown as {
        resolveModelListLauncher: (
          actor: string,
          protocol: 'cli' | 'acp',
          context?: { taskId?: string; workspaceKey?: string }
        ) => Promise<{ command: string; env?: Record<string, string>; protocol?: string } | undefined>
      }).resolveModelListLauncher('qwen', 'acp', {
        taskId: created.task,
        workspaceKey: created.workspace_key
      })
      expect(resolved?.command).toBe('/task/qwen')
      expect(resolved?.env?.FROM).toBe('task')
      expect(resolved?.protocol).toBe('acp')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

