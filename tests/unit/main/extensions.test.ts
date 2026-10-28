import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeGlobalSettings } from '../../../src/shared/defaults'
import type { Launcher } from '../../../src/shared/types'
import { aggregateScanStatus } from '../../../src/main/buddy/extensions/discover'
import { readLibrary, writeLibrary } from '../../../src/main/buddy/extensions/library-store'
import { mcpServersFromToml } from '../../../src/main/buddy/extensions/parse'
import { probeStdio } from '../../../src/main/buddy/extensions/mcp-probe'
import { parseGitSource } from '../../../src/main/buddy/extensions/skill-git'
import { ExtensionService } from '../../../src/main/buddy/extensions/service'
import { resolveExtensionTarget } from '../../../src/main/buddy/extensions/target-resolver'
import { isImportableFoundInstance } from '../../../src/shared/extensions'
import { FEATURED_MCPS, catalogRepositoryKey as mcpCatalogKey } from '../../../src/shared/mcp-catalog'
import { FEATURED_SKILLS, catalogRepositoryKey } from '../../../src/shared/skill-catalog'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('extension target resolver', () => {
  it('keeps task launcher home apart from the global launcher', async () => {
    const dataRoot = await tempDir()
    const globalHome = await tempDir()
    const taskHome = await tempDir()
    const globalTarget = await resolveExtensionTarget({
      actor: 'claude',
      launcher: launcher('claude', { HOME: globalHome }),
      homeDir: '/unused',
      dataRoot,
      processEnv: {}
    })
    const taskTarget = await resolveExtensionTarget({
      actor: 'claude',
      launcher: launcher('claude', { HOME: taskHome }),
      homeDir: '/unused',
      dataRoot,
      processEnv: {}
    })

    expect(globalTarget.fingerprint).not.toBe(taskTarget.fingerprint)
    expect(globalTarget.locations.some((location) => location.path === join(globalHome, '.claude', 'skills'))).toBe(true)
    expect(taskTarget.locations.some((location) => location.path === join(taskHome, '.claude', 'skills'))).toBe(true)
  })

  it('uses the private Codex ACP home without creating it', async () => {
    const dataRoot = await tempDir()
    const desktop = await tempDir()
    await mkdir(join(desktop, '.codex', 'skills', 'desktop-only'), { recursive: true })
    const target = await resolveExtensionTarget({
      actor: 'codex',
      launcher: launcher('npx', {}, { protocol: 'acp', args: ['-y', '@agentclientprotocol/codex-acp'] }),
      homeDir: desktop,
      dataRoot,
      processEnv: {}
    })
    const privateHome = join(dataRoot, 'acp', 'codex', 'codex-home')

    expect(target.resolution).toBe('ready')
    expect(target.locations.some((location) => location.path === join(privateHome, 'skills'))).toBe(true)
    expect(target.locations.some((location) => location.path.startsWith(join(desktop, '.codex', 'skills')))).toBe(false)
    expect(target.writesNativeConfig).toBe(true)
    await expect(stat(privateHome)).rejects.toThrow()
  })

  it('does not invent a directory for an unrecognized command', async () => {
    const target = await resolveExtensionTarget({
      actor: 'claude',
      launcher: launcher('my-agent'),
      homeDir: '/tmp/does-not-matter',
      dataRoot: '/tmp/buddy-data',
      processEnv: {}
    })

    expect(target.resolution).toBe('unrecognized')
    expect(target.locations).toEqual([])
  })

  it('does not treat an Antigravity actor with a custom command as agy', async () => {
    const target = await resolveExtensionTarget({
      actor: 'agy',
      launcher: launcher('custom-tool'),
      homeDir: '/tmp/home',
      dataRoot: '/tmp/data',
      processEnv: {}
    })

    expect(target.resolution).toBe('unrecognized')
    expect(target.locations).toEqual([])
  })

  it('follows the real program when the actor label differs', async () => {
    const home = await tempDir()
    const target = await resolveExtensionTarget({
      actor: 'kimi',
      launcher: launcher('opencode', { HOME: home }),
      homeDir: '/unused',
      dataRoot: await tempDir(),
      processEnv: {}
    })

    expect(target.actor).toBe('kimi')
    expect(target.adapter).toBe('opencode')
    expect(target.notes).toContain('program_differs_from_actor')
    expect(target.locations.some((location) => location.path === join(home, '.config', 'opencode', 'skills'))).toBe(true)
  })

  it('keeps WeCode Codex on the Codex family and its own ACP home', async () => {
    const dataRoot = await tempDir()
    const target = await resolveExtensionTarget({
      actor: 'wecode_codex',
      launcher: launcher('wecode codex', {}, { protocol: 'acp' }),
      homeDir: await tempDir(),
      dataRoot,
      processEnv: {}
    })

    expect(target.adapter).toBe('codex')
    expect(target.actor).toBe('wecode_codex')
    expect(target.locations.some((location) => location.path === join(dataRoot, 'acp', 'wecode_codex', 'codex-home', 'skills'))).toBe(true)
    expect(target.notes).toContain('wecode_family_unverified')
  })

  it('resolves Cursor, agy, Kimi, and dsh roots as read-only filesystem targets', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    const project = await tempDir()
    await writeSkill(join(home, '.cursor', 'skills', 'cursor-user'), 'cursor-user', 'cursor user skill')
    await writeSkill(join(home, '.cursor', 'skills-cursor', 'built-in'), 'built-in', 'cursor product skill')
    await writeSkill(join(home, '.gemini', 'config', 'skills', 'agy-user'), 'agy-user', 'agy user skill')
    await writeSkill(join(home, '.gemini', 'antigravity-cli', 'builtin', 'skills', 'agy-built'), 'agy-built', 'agy builtin')
    await mkdir(join(home, '.gemini', 'config'), { recursive: true })
    await writeFile(join(home, '.gemini', 'config', 'mcp_config.json'), '')
    await writeSkill(join(home, '.kimi-code', 'skills', 'kimi-user'), 'kimi-user', 'kimi user skill')
    await writeSkill(join(home, '.agents', 'skills', 'shared-skill'), 'shared-skill', 'shared')
    await mkdir(join(home, '.dsh', 'profiles', 'desktop'), { recursive: true })
    await writeSkill(join(project, '.cursor', 'skills', 'cursor-project'), 'cursor-project', 'project')
    await writeSkill(join(project, '.kimi-code', 'skills', 'kimi-project'), 'kimi-project', 'project')

    const cursor = await resolveExtensionTarget({
      actor: 'cursor',
      launcher: launcher('cursor-agent', { HOME: home }),
      cwd: project,
      homeDir: '/unused',
      dataRoot,
      processEnv: {}
    })
    const agy = await resolveExtensionTarget({
      actor: 'agy',
      launcher: launcher('agy', { HOME: home }),
      homeDir: '/unused',
      dataRoot,
      processEnv: {}
    })
    const kimi = await resolveExtensionTarget({
      actor: 'kimi',
      launcher: launcher('kimi', { HOME: home, KIMI_CODE_HOME: join(home, '.kimi-code') }),
      cwd: project,
      homeDir: '/unused',
      dataRoot,
      processEnv: {}
    })
    const dsh = await resolveExtensionTarget({
      actor: 'dsh',
      launcher: launcher('dsh', { HOME: home, DSH_HOME: join(home, '.dsh') }),
      homeDir: '/unused',
      dataRoot,
      processEnv: {}
    })
    const missing = await resolveExtensionTarget({
      actor: 'cursor',
      launcher: launcher('cursor-agent', { HOME: join(home, 'missing-home') }),
      homeDir: '/unused',
      dataRoot,
      processEnv: {}
    })

    for (const target of [cursor, agy, kimi, dsh]) {
      expect(target.resolution).toBe('ready')
      expect(target.discovery).toBe('filesystem')
      expect(target.writesNativeConfig).toBe(false)
    }
    expect(cursor.locations.some((location) => location.id === 'cursor-skills' && location.scan)).toBe(true)
    expect(cursor.locations.some((location) => location.id === 'cursor-skills-product' && location.scope === 'plugin')).toBe(true)
    expect(cursor.locations.some((location) => location.path === join(project, '.cursor', 'skills'))).toBe(true)
    expect(agy.locations.some((location) => location.path === join(home, '.gemini', 'config', 'skills') && location.scan)).toBe(true)
    expect(agy.locations.some((location) => location.scope === 'plugin' && location.path.includes('builtin'))).toBe(true)
    expect(kimi.locations.some((location) => location.path === join(home, '.kimi-code', 'skills') && location.scan)).toBe(true)
    expect(kimi.locations.some((location) => location.path === join(home, '.agents', 'skills'))).toBe(true)
    expect(dsh.locations.every((location) => location.kind === 'execution_env')).toBe(true)
    expect(dsh.locations.some((location) => location.path === join(home, '.dsh', 'profiles'))).toBe(true)
    expect(missing.locations.some((location) => location.missingMeans === 'uninitialized')).toBe(true)

    const service = new ExtensionService({
      dataRoot,
      homeDir: '/unused',
      processEnv: {},
      readGlobalSettings: async () => normalizeGlobalSettings({
        launchers: {
          cursor: launcher('cursor-agent', { HOME: home }),
          agy: launcher('agy', { HOME: home }),
          kimi: launcher('kimi', { HOME: home, KIMI_CODE_HOME: join(home, '.kimi-code') }),
          dsh: launcher('dsh', { HOME: home, DSH_HOME: join(home, '.dsh') }),
          claude: launcher('claude', { HOME: home })
        }
      })
    })
    const page = await service.discover({ kind: 'skill', cwd: project })
    expect(page.targets.find((target) => target.actor === 'cursor')?.assignBlock).toBe('unsupported')
    expect(page.targets.find((target) => target.actor === 'agy')?.assignBlock).toBe('unsupported')
    expect(page.targets.find((target) => target.actor === 'kimi')?.assignBlock).toBe('unsupported')
    expect(page.targets.find((target) => target.actor === 'dsh')?.assignBlock).toBe('unsupported')
    expect(page.found.some((item) => item.actor === 'cursor' && item.name === 'cursor-user')).toBe(true)
    expect(page.found.some((item) => item.actor === 'cursor' && item.name === 'built-in' && item.readOnly)).toBe(true)
    expect(page.found.some((item) => item.actor === 'agy' && item.name === 'agy-user')).toBe(true)
    expect(page.found.some((item) => item.actor === 'kimi' && item.name === 'kimi-user')).toBe(true)
    expect(page.found.some((item) => item.actor === 'dsh')).toBe(false)

    const cursorItem = page.found.find((item) => item.actor === 'cursor' && item.name === 'cursor-user')!
    const blockedImport = await service.apply({ action: 'import', kind: 'skill', instanceId: cursorItem.id, cwd: project })
    expect(blockedImport.results[0]?.code).toBe('unsupported')
    expect((await lstat(join(home, '.cursor', 'skills', 'cursor-user'))).isSymbolicLink()).toBe(false)

    await writeSkill(join(home, '.claude', 'skills', 'kept'), 'kept', 'claude')
    const claudePage = await service.discover({ kind: 'skill', cwd: project })
    const kept = claudePage.found.find((item) => item.actor === 'claude' && item.name === 'kept')!
    const imported = await service.apply({ action: 'import', kind: 'skill', instanceId: kept.id, cwd: project })
    const itemId = imported.results[0]!.libraryItemId!
    const blockedAssign = await service.apply({ action: 'assign', kind: 'skill', libraryItemId: itemId, actor: 'cursor', desired: 'on', cwd: project })
    expect(blockedAssign.results[0]?.code).toBe('unsupported')
    await expect(lstat(join(home, '.cursor', 'skills', 'kept'))).rejects.toThrow()
  })
})

describe('extension discovery', () => {
  it('separates empty, uninitialized, and read failures', () => {
    expect(aggregateScanStatus([], 0)).toBe('empty')
    expect(aggregateScanStatus([{ code: 'uninitialized', path: '/x' }], 0)).toBe('uninitialized')
    expect(aggregateScanStatus([{ code: 'read_failed', path: '/x' }], 0)).toBe('read_failed')
    expect(aggregateScanStatus([{ code: 'read_failed', path: '/x' }], 1)).toBe('partial')
  })

  it('reads skills without changing files and does not merge different copies', async () => {
    const home = await tempDir()
    const project = await tempDir()
    await writeSkill(join(home, '.claude', 'skills', 'review'), 'same name', 'from user')
    await writeSkill(join(project, '.claude', 'skills', 'review'), 'same name', 'from project')
    const userFile = join(home, '.claude', 'skills', 'review', 'SKILL.md')
    const before = await stat(userFile)
    const service = new ExtensionService({
      dataRoot: await tempDir(),
      homeDir: '/unused',
      processEnv: {},
      readGlobalSettings: async () => normalizeGlobalSettings({
        launchers: {
          claude: launcher('claude', { HOME: home })
        }
      })
    })

    const page = await service.discover({ kind: 'skill', cwd: project })
    const claude = page.targets.find((target) => target.actor === 'claude')
    const reviews = page.found.filter((item) => item.name === 'same name')

    expect(claude?.status).toBe('ok')
    expect(claude?.assignBlock).toBe('none')
    expect(page.targets.find((target) => target.actor === 'cursor')?.assignBlock).toBe('unsupported')
    const claudeReviews = reviews.filter((item) => item.actor === 'claude')
    expect(claudeReviews).toHaveLength(2)
    expect(new Set(claudeReviews.map((item) => item.shareKey)).size).toBe(2)
    const projectCopies = reviews.filter((item) => item.scope === 'project')
    expect(projectCopies.map((item) => item.actor).sort()).toEqual(['claude', 'wecode_claude'])
    expect(new Set(projectCopies.map((item) => item.shareKey)).size).toBe(1)
    const after = await stat(userFile)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
  })

  it('shares one physical skill across Claude and WeCode without listing it twice for one actor', async () => {
    const home = await tempDir()
    await writeSkill(join(home, '.claude', 'skills', 'shared-skill'), 'shared-skill', 'one copy')
    const service = serviceWith({
      claude: launcher('claude', { HOME: home }),
      wecode_claude: launcher('wecode', { HOME: home })
    })

    const page = await service.discover({ kind: 'skill' })
    const copies = page.found.filter((item) => item.name === 'shared-skill')

    expect(copies.map((item) => item.actor).sort()).toEqual(['claude', 'wecode_claude'])
    expect(copies[0].shareKey).toBe(copies[1].shareKey)
    expect(copies[0].sharedWith).toEqual(['wecode_claude'])
  })

  it('reports a skills path that is a file as a read failure, not an empty list', async () => {
    const home = await tempDir()
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', 'skills'), 'not a directory')
    const service = serviceWith({ claude: launcher('claude', { HOME: home }) })

    const page = await service.discover({ kind: 'skill' })
    const claude = page.targets.find((target) => target.actor === 'claude')

    expect(claude?.status).toBe('read_failed')
    expect(claude?.instances).toEqual([])
  })

  it('does not attribute desktop Codex skills to an uninitialized ACP target or create the private home', async () => {
    const desktop = await tempDir()
    const dataRoot = await tempDir()
    await writeSkill(join(desktop, '.codex', 'skills', 'desktop-skill'), 'desktop-skill', 'desktop')
    const service = new ExtensionService({
      dataRoot,
      homeDir: desktop,
      processEnv: {},
      readGlobalSettings: async () => normalizeGlobalSettings({
        launchers: {
          codex: launcher('npx', {}, { protocol: 'acp', args: ['-y', '@agentclientprotocol/codex-acp'] })
        }
      })
    })

    const page = await service.discover({ kind: 'skill' })
    const codex = page.targets.find((target) => target.actor === 'codex')

    expect(codex?.status).toBe('uninitialized')
    expect(codex?.assignBlock).toBe('uninitialized')
    expect(codex?.instances.some((item) => item.name === 'desktop-skill')).toBe(false)
    await expect(stat(join(dataRoot, 'acp'))).rejects.toThrow()
    await expect(stat(join(dataRoot, 'extensions'))).rejects.toThrow()
  })

  it('keeps same-name MCP servers in different files apart and hides env values', async () => {
    const home = await tempDir()
    const project = await tempDir()
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456'
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude.json'), JSON.stringify({
      mcpServers: { github: { command: 'npx', args: ['server-a'], env: { TOKEN: secret } } }
    }))
    await writeFile(join(project, '.mcp.json'), JSON.stringify({
      mcpServers: { github: { command: 'npx', args: ['server-b'], env: { TOKEN: secret } } }
    }))
    const service = serviceWith({ claude: launcher('claude', { HOME: home }) })

    const page = await service.discover({ kind: 'mcp', cwd: project })
    const servers = page.found.filter((item) => item.actor === 'claude' && item.name === 'github')
    const serialized = JSON.stringify(page)

    expect(servers).toHaveLength(2)
    expect(new Set(servers.map((item) => item.shareKey)).size).toBe(2)
    expect(servers.every((item) => item.envKeys.includes('TOKEN'))).toBe(true)
    expect(serialized).not.toContain(secret)
  })

  it('uses the task launcher instead of the global one', async () => {
    const globalHome = await tempDir()
    const taskHome = await tempDir()
    await writeSkill(join(globalHome, '.claude', 'skills', 'global-only'), 'global-only', 'global')
    await writeSkill(join(taskHome, '.claude', 'skills', 'task-only'), 'task-only', 'task')
    const service = new ExtensionService({
      dataRoot: await tempDir(),
      homeDir: '/unused',
      processEnv: {},
      readGlobalSettings: async () => normalizeGlobalSettings({
        launchers: { claude: launcher('claude', { HOME: globalHome }) }
      }),
      readTaskContext: async () => ({
        launchers: { claude: launcher('claude', { HOME: taskHome }) },
        repoRoot: ''
      })
    })

    const globalPage = await service.discover({ kind: 'skill' })
    const taskPage = await service.discover({ kind: 'skill', taskId: 'task', workspaceKey: 'workspace' })

    expect(globalPage.found.some((item) => item.name === 'global-only')).toBe(true)
    expect(globalPage.found.some((item) => item.name === 'task-only')).toBe(false)
    expect(taskPage.found.some((item) => item.name === 'task-only')).toBe(true)
    expect(taskPage.found.some((item) => item.name === 'global-only')).toBe(false)
  })

  it('refuses import without writing the library or agent files', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    await writeSkill(join(home, '.claude', 'skills', 'kept'), 'kept', 'stay')
    const service = new ExtensionService({
      dataRoot,
      homeDir: home,
      processEnv: {},
      readGlobalSettings: async () => normalizeGlobalSettings({})
    })

    expect(await service.apply('import')).toEqual({ accepted: false, code: 'missing_target', results: [] })
    expect(await service.apply('nope')).toEqual({ accepted: false, code: 'unknown_action', results: [] })
    await service.discover({ kind: 'skill' })
    await expect(stat(join(dataRoot, 'extensions'))).rejects.toThrow()
    expect(await readFile(join(home, '.claude', 'skills', 'kept', 'SKILL.md'), 'utf8')).toContain('kept')
  })
})

describe('extension library store', () => {
  it('distinguishes a missing library, an empty library, and a broken library', async () => {
    const dataRoot = await tempDir()
    expect((await readLibrary(dataRoot)).status).toBe('absent')

    await writeLibrary(dataRoot, { version: 1, items: [], bindings: [], records: [] })
    expect((await readLibrary(dataRoot)).status).toBe('empty')

    await writeFile(join(dataRoot, 'extensions', 'library.json'), '{')
    const broken = await readLibrary(dataRoot)
    expect(broken.status).toBe('read_failed')
    expect(broken.items).toEqual([])
    expect(await readFile(join(dataRoot, 'extensions', 'library.json'), 'utf8')).toBe('{')
  })

  it('moves a stored origin out of the unmanaged list', async () => {
    const home = await tempDir()
    const skillDir = join(home, '.claude', 'skills', 'stored')
    await writeSkill(skillDir, 'stored', 'already managed')
    const dataRoot = await tempDir()
    const service = serviceWith({ claude: launcher('claude', { HOME: home }) }, dataRoot)
    const first = await service.discover({ kind: 'skill' })
    const found = first.found.find((item) => item.name === 'stored')
    expect(found).toBeTruthy()
    await writeLibrary(dataRoot, {
      version: 1,
      items: [{
        id: 'item-1',
        kind: 'skill',
        name: 'stored',
        description: '',
        originActor: 'claude',
        originPath: found!.path,
        shareKey: found!.shareKey,
        repository: null,
        pluginId: null,
        version: null,
        contentHash: null,
        libraryPath: null,
        externalPath: null,
        createdAt: '2026-10-28T00:00:00.000Z',
        updatedAt: '2026-10-28T00:00:00.000Z'
      }],
      bindings: [],
      records: []
    })

    const second = await service.discover({ kind: 'skill' })
    expect(second.library.status).toBe('ok')
    expect(second.found.some((item) => item.name === 'stored')).toBe(false)
  })
})

describe('toml mcp args', () => {
  it('keeps apostrophes, spaces, and multiline arrays', () => {
    const parsed = mcpServersFromToml(`
[mcp_servers.github]
command = "npx"
args = ["don't", "can't", "has space"]

[mcp_servers.other]
command = 'tool # not a comment'
args = [
  "--flag",
  "value with spaces"
]
`)
    expect(parsed.invalid).toBe(false)
    expect(parsed.entries.find((entry) => entry.name === 'github')?.args).toEqual(["don't", "can't", "has space"])
    expect(parsed.entries.find((entry) => entry.name === 'other')?.args).toEqual(['--flag', 'value with spaces'])
    expect(parsed.entries.find((entry) => entry.name === 'other')?.command).toBe('tool # not a comment')
  })

  it('marks a broken args array instead of dropping it', () => {
    const parsed = mcpServersFromToml(`
[mcp_servers.bad]
command = "tool"
args = [ "unterminated
`)
    expect(parsed.invalid).toBe(true)
    expect(parsed.entries.find((entry) => entry.name === 'bad')?.command).toBe('tool')
    expect(parsed.entries.find((entry) => entry.name === 'bad')?.args).toEqual([])
  })

  it('reads a dotted mcp_servers key outside a table', () => {
    const parsed = mcpServersFromToml('mcp_servers.github.args = ["--flag", \'a b\']\n')
    expect(parsed.invalid).toBe(false)
    expect(parsed.entries[0]?.args).toEqual(['--flag', 'a b'])
  })
})

describe('library apply', () => {
  it('moves an independent skill into the library and links the old path', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    const skillDir = join(home, '.claude', 'skills', 'kept')
    await writeSkill(skillDir, 'kept', 'stay')
    await mkdir(join(skillDir, 'scripts'))
    await writeFile(join(skillDir, 'scripts', 'run.sh'), 'echo kept\n')
    const service = serviceWith({ claude: launcher('claude', { HOME: home }) }, dataRoot)
    const found = (await service.discover({ kind: 'skill' })).found.find((item) => item.actor === 'claude' && item.name === 'kept')
    expect(found).toBeTruthy()

    const imported = await service.apply({ action: 'import', kind: 'skill', instanceId: found!.id })
    expect(imported.results[0]?.code).toBe('imported')
    const again = await service.apply({ action: 'import', kind: 'skill', instanceId: found!.id })
    expect(again.results[0]?.code).toBe('already')
    const library = await readLibrary(dataRoot)
    expect(library.items).toHaveLength(1)
    expect(library.bindings[0]?.desired).toBe('on')
    expect((await lstat(skillDir)).isSymbolicLink()).toBe(true)
    expect(await readlink(skillDir)).toBe(library.items[0]?.libraryPath)
    expect(await readFile(join(library.items[0]!.libraryPath!, 'scripts', 'run.sh'), 'utf8')).toBe('echo kept\n')
    expect((await service.discover({ kind: 'skill' })).found.some((item) => item.actor === 'claude' && item.name === 'kept')).toBe(false)
  })

  it('imports and assigns a skill directory whose name contains spaces', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    const skillDir = join(home, '.claude', 'skills', 'code review')
    await writeSkill(skillDir, 'code review', 'spaced')
    await mkdir(join(home, '.codex'))
    const service = serviceWith({
      claude: launcher('claude', { HOME: home }),
      codex: launcher('codex', { HOME: home })
    }, dataRoot)
    const found = (await service.discover({ kind: 'skill' })).found.find((item) => item.actor === 'claude' && item.name === 'code review')
    const imported = await service.apply({ action: 'import', kind: 'skill', instanceId: found!.id })
    expect(imported.results[0]?.code).toBe('imported')
    expect((await lstat(skillDir)).isSymbolicLink()).toBe(true)
    const itemId = imported.results[0]!.libraryItemId!
    const assigned = await service.apply({ action: 'assign', kind: 'skill', libraryItemId: itemId, actor: 'codex', desired: 'on' })
    expect(assigned.results[0]?.code).toBe('assigned')
    const codexLink = join(home, '.codex', 'skills', 'code review')
    expect(await readlink(codexLink)).toBe((await readLibrary(dataRoot)).items[0]?.libraryPath)
    expect(await readFile(join(codexLink, 'SKILL.md'), 'utf8')).toContain('code review')
  })

  it('references an existing link without moving the external directory', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    const external = join(await tempDir(), 'shared-skill')
    await writeSkill(external, 'shared-skill', 'outside')
    const link = join(home, '.claude', 'skills', 'shared-skill')
    await mkdir(join(home, '.claude', 'skills'), { recursive: true })
    await symlink(external, link)
    const service = serviceWith({ claude: launcher('claude', { HOME: home }) }, dataRoot)
    const found = (await service.discover({ kind: 'skill' })).found.find((item) => item.name === 'shared-skill' && item.actor === 'claude')

    const imported = await service.apply({ action: 'import', kind: 'skill', instanceId: found!.id })
    expect(imported.results[0]?.code).toBe('referenced')
    expect((await lstat(external)).isDirectory()).toBe(true)
    expect(await readlink(link)).toBe(external)
    const library = await readLibrary(dataRoot)
    expect(library.items[0]?.libraryPath).toBeNull()
    expect(library.items[0]?.externalPath).toBe(await realpath(external))
  })

  it('assigns a second agent by symlink and revoke leaves the library and the first agent', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    const skillDir = join(home, '.claude', 'skills', 'kept')
    await writeSkill(skillDir, 'kept', 'stay')
    const service = serviceWith({
      claude: launcher('claude', { HOME: home }),
      codex: launcher('codex', { HOME: home })
    }, dataRoot)
    const found = (await service.discover({ kind: 'skill' })).found.find((item) => item.actor === 'claude' && item.name === 'kept')
    const imported = await service.apply({ action: 'import', kind: 'skill', instanceId: found!.id })
    const itemId = imported.results[0]?.libraryItemId
    expect(itemId).toBeTruthy()

    const blocked = await service.apply({ action: 'assign', kind: 'skill', libraryItemId: itemId!, actor: 'codex', desired: 'on' })
    expect(blocked.results[0]?.code).toBe('uninitialized')
    await expect(lstat(join(home, '.codex'))).rejects.toThrow()

    await mkdir(join(home, '.codex'))
    const assigned = await service.apply({ action: 'assign', kind: 'skill', libraryItemId: itemId!, actor: 'codex', desired: 'on' })
    expect(assigned.results[0]?.code).toBe('assigned')
    const codexLink = join(home, '.codex', 'skills', 'kept')
    expect(await readlink(codexLink)).toBe((await readLibrary(dataRoot)).items[0]?.libraryPath)
    const revoked = await service.apply({ action: 'assign', kind: 'skill', libraryItemId: itemId!, actor: 'codex', desired: 'off' })
    expect(revoked.results[0]?.code).toBe('revoked')
    await expect(lstat(codexLink)).rejects.toThrow()
    expect((await lstat(skillDir)).isSymbolicLink()).toBe(true)
    expect((await readLibrary(dataRoot)).items).toHaveLength(1)
  })

  it('returns symlink_failed when the skills directory cannot take a link', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    const skillDir = join(home, '.claude', 'skills', 'kept')
    await writeSkill(skillDir, 'kept', 'stay')
    const service = serviceWith({
      claude: launcher('claude', { HOME: home }),
      codex: launcher('codex', { HOME: home })
    }, dataRoot)
    const found = (await service.discover({ kind: 'skill' })).found.find((item) => item.actor === 'claude' && item.name === 'kept')
    const imported = await service.apply({ action: 'import', kind: 'skill', instanceId: found!.id })
    const itemId = imported.results[0]?.libraryItemId
    expect(itemId).toBeTruthy()
    const skills = join(home, '.codex', 'skills')
    await mkdir(skills, { recursive: true })
    await chmod(skills, 0o555)
    try {
      const blocked = await service.apply({ action: 'assign', kind: 'skill', libraryItemId: itemId!, actor: 'codex', desired: 'on' })
      expect(blocked.results[0]?.code).toBe('symlink_failed')
      expect((await readLibrary(dataRoot)).bindings.some((binding) => binding.actor === 'codex' && binding.desired === 'on')).toBe(false)
      await expect(lstat(join(skills, 'kept'))).rejects.toThrow()
    } finally {
      await chmod(skills, 0o755)
    }
  })

  it('does not take over a plugin skill directory', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    const skillDir = join(home, '.claude', 'plugins', 'pack', 'owned')
    await writeSkill(skillDir, 'owned', 'plugin')
    const service = serviceWith({ claude: launcher('claude', { HOME: home }) }, dataRoot)
    const found = (await service.discover({ kind: 'skill' })).found.find((item) => item.name === 'owned')
    expect(found?.readOnly).toBe(true)
    expect(isImportableFoundInstance(found!)).toBe(false)
    const imported = await service.apply({ action: 'import', kind: 'skill', instanceId: found!.id })
    expect(imported.results[0]?.code).toBe('plugin_owned')
    expect((await lstat(skillDir)).isDirectory()).toBe(true)
    expect((await readLibrary(dataRoot)).status).toBe('absent')
  })

  it('import_all skips plugin-owned rows instead of failing the batch', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    await writeSkill(join(home, '.claude', 'skills', 'user-one'), 'user-one', 'mine')
    await writeSkill(join(home, '.claude', 'plugins', 'pack', 'owned'), 'owned', 'plugin')
    const service = serviceWith({ claude: launcher('claude', { HOME: home }) }, dataRoot)
    const batch = await service.apply({ action: 'import_all', kind: 'skill' })
    expect(batch.results.every((entry) => entry.code !== 'plugin_owned')).toBe(true)
    expect(batch.results.some((entry) => entry.code === 'imported' || entry.code === 'referenced')).toBe(true)
    const library = await readLibrary(dataRoot)
    expect(library.items.some((item) => item.name === 'user-one')).toBe(true)
    expect(library.items.some((item) => item.name === 'owned')).toBe(false)
  })

  it('installs a curated catalog skill offline and refuses a second install', async () => {
    const dataRoot = await tempDir()
    const service = serviceWith({ claude: launcher('claude', { HOME: await tempDir() }) }, dataRoot)
    const first = FEATURED_SKILLS[0]!
    const installed = await service.apply({
      action: 'save',
      kind: 'skill',
      source: catalogRepositoryKey(first.id)
    })
    expect(installed.results[0]?.code).toBe('installed')
    const itemId = installed.results[0]?.libraryItemId
    expect(itemId).toBeTruthy()
    const library = await readLibrary(dataRoot)
    const item = library.items.find((entry) => entry.id === itemId)
    expect(item?.repository).toBe(catalogRepositoryKey(first.id))
    expect(item?.libraryPath).toBeTruthy()
    expect(await readFile(join(item!.libraryPath!, 'SKILL.md'), 'utf8')).toContain(first.name)
    const again = await service.apply({
      action: 'save',
      kind: 'skill',
      source: catalogRepositoryKey(first.id)
    })
    expect(again.results[0]?.code).toBe('already')
    expect(again.results[0]?.libraryItemId).toBe(itemId)
    expect((await readLibrary(dataRoot)).items.filter((entry) => entry.repository === catalogRepositoryKey(first.id))).toHaveLength(1)
  })

  it('installs a curated MCP template offline and refuses a second install', async () => {
    const dataRoot = await tempDir()
    const service = serviceWith({ claude: launcher('claude', { HOME: await tempDir() }) }, dataRoot)
    const first = FEATURED_MCPS[0]!
    const installed = await service.apply({
      action: 'save',
      kind: 'mcp',
      source: mcpCatalogKey(first.id)
    })
    expect(installed.results[0]?.code).toBe('installed')
    const itemId = installed.results[0]?.libraryItemId
    expect(itemId).toBeTruthy()
    const library = await readLibrary(dataRoot)
    const item = library.items.find((entry) => entry.id === itemId)
    expect(item?.kind).toBe('mcp')
    expect(item?.repository).toBe(mcpCatalogKey(first.id))
    const saved = JSON.parse(await readFile(item!.libraryPath!, 'utf8')) as {
      kind: string
      serverName: string
      server: { command: string; args?: string[] }
    }
    expect(saved.kind).toBe('mcp')
    expect(saved.serverName).toBe(first.name)
    expect(saved.server.command).toBe(first.server.command)
    expect(saved.server.args).toEqual(first.server.args)
    const again = await service.apply({
      action: 'save',
      kind: 'mcp',
      source: mcpCatalogKey(first.id)
    })
    expect(again.results[0]?.code).toBe('already')
    expect(again.results[0]?.libraryItemId).toBe(itemId)
    expect((await readLibrary(dataRoot)).items.filter((entry) => entry.repository === mcpCatalogKey(first.id))).toHaveLength(1)
  })

  it('keeps unknown JSON fields and refuses comment files', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    const configPath = join(home, '.claude.json')
    const original = '{\n  "theme": "dark",\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["--flag"], "note": "keep-me" }\n  }\n}\n'
    await writeFile(configPath, original)
    const service = serviceWith({ claude: launcher('claude', { HOME: home }) }, dataRoot)
    const found = (await service.discover({ kind: 'mcp' })).found.find((item) => item.actor === 'claude' && item.name === 'github')
    const imported = await service.apply({ action: 'import', kind: 'mcp', instanceId: found!.id })
    expect(imported.results[0]?.code).toBe('referenced')
    expect(await readFile(configPath, 'utf8')).toBe(original)
    const itemId = imported.results[0]!.libraryItemId!

    const removed = await service.apply({ action: 'assign', kind: 'mcp', libraryItemId: itemId, actor: 'claude', desired: 'off' })
    expect(removed.results[0]?.code).toBe('revoked')
    expect((await readdir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    const after = JSON.parse(await readFile(configPath, 'utf8')) as { theme: string; mcpServers: Record<string, unknown> }
    expect(after.theme).toBe('dark')
    expect(after.mcpServers.github).toBeUndefined()

    const restored = await service.apply({ action: 'assign', kind: 'mcp', libraryItemId: itemId, actor: 'claude', desired: 'on' })
    expect(restored.results[0]?.code).toBe('assigned')
    const back = JSON.parse(await readFile(configPath, 'utf8')) as { theme: string; mcpServers: { github: { note: string } } }
    expect(back.theme).toBe('dark')
    expect(back.mcpServers.github.note).toBe('keep-me')

    await writeFile(configPath, '{\n  // comment\n  "theme": "dark",\n  "mcpServers": { "github": { "command": "npx", "args": ["--flag"], "note": "keep-me" } }\n}\n')
    const blocked = await service.apply({ action: 'assign', kind: 'mcp', libraryItemId: itemId, actor: 'claude', desired: 'off' })
    expect(blocked.results[0]?.code).toBe('comment')
    expect(await readFile(configPath, 'utf8')).toContain('// comment')
  })

  it('edits only the owned TOML section', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    await mkdir(join(home, '.codex'))
    const configPath = join(home, '.codex', 'config.toml')
    const original = 'model = "keep"\n\n[mcp_servers.github]\ncommand = "npx"\nargs = ["--flag"]\n\n[other]\nvalue = 1\n'
    await writeFile(configPath, original)
    const service = serviceWith({ codex: launcher('codex', { HOME: home }) }, dataRoot)
    const found = (await service.discover({ kind: 'mcp' })).found.find((item) => item.actor === 'codex' && item.name === 'github')
    const imported = await service.apply({ action: 'import', kind: 'mcp', instanceId: found!.id })
    expect(imported.results[0]?.code).toBe('referenced')
    expect(await readFile(configPath, 'utf8')).toBe(original)
    const itemId = imported.results[0]!.libraryItemId!
    const removed = await service.apply({ action: 'assign', kind: 'mcp', libraryItemId: itemId, actor: 'codex', desired: 'off' })
    expect(removed.results[0]?.code).toBe('revoked')
    const text = await readFile(configPath, 'utf8')
    expect(text).toContain('model = "keep"')
    expect(text).toContain('[other]')
    expect(text).toContain('value = 1')
    expect(text).not.toContain('[mcp_servers.github]')
    const restored = await service.apply({ action: 'assign', kind: 'mcp', libraryItemId: itemId, actor: 'codex', desired: 'on' })
    expect(restored.results[0]?.code).toBe('assigned')
    const back = await readFile(configPath, 'utf8')
    expect(back).toContain('[mcp_servers.github]')
    expect(back).toContain('[other]')
  })

  it('finds a local skill folder and imports it without treating git text as a path', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    const skillDir = join(home, 'outside', 'code review')
    await writeSkill(skillDir, 'local skill', 'from a folder')
    const service = new ExtensionService({
      dataRoot,
      homeDir: home,
      processEnv: {},
      readGlobalSettings: async () => normalizeGlobalSettings({
        launchers: { claude: launcher('claude', { HOME: home }) }
      })
    })

    const missed = await service.apply({ action: 'find', kind: 'skill', source: 'not a source' })
    expect(missed).toEqual({ accepted: false, code: 'find_not_ready', results: [], found: [] })
    const absent = await service.apply({ action: 'find', kind: 'skill', source: join(home, 'outside', 'missing') })
    expect(absent.results[0]?.code).toBe('not_found')
    const noSkill = await service.apply({ action: 'find', kind: 'skill', source: join(home, 'outside') })
    expect(noSkill.results[0]?.code).toBe('missing_skill')
    expect(await lstat(skillDir)).toBeTruthy()
    expect((await readLibrary(dataRoot)).status).toBe('absent')

    const found = await service.apply({ action: 'find', kind: 'skill', source: `~/${'outside/code review'}` })
    expect(found.found?.[0]?.name).toBe('local skill')
    expect(found.found?.[0]?.readOnly).toBe(false)
    expect((await lstat(skillDir)).isSymbolicLink()).toBe(false)

    const imported = await service.apply({ action: 'import', kind: 'skill', source: skillDir })
    expect(imported.results[0]?.code).toBe('referenced')
    expect((await lstat(skillDir)).isDirectory()).toBe(true)
    expect((await lstat(skillDir)).isSymbolicLink()).toBe(false)
    const outsideItem = (await readLibrary(dataRoot)).items.find((item) => item.name === 'local skill')
    expect(outsideItem?.libraryPath).toBeNull()
    expect(outsideItem?.externalPath).toBe(await realpath(skillDir))

    const namedPlugins = join(home, 'work', 'plugins', 'my-skill')
    await writeSkill(namedPlugins, 'workspace skill', 'named plugins')
    const named = await service.apply({ action: 'import', kind: 'skill', source: namedPlugins })
    expect(named.results[0]?.code).toBe('referenced')
    expect((await lstat(namedPlugins)).isSymbolicLink()).toBe(false)

    const agentDir = join(home, '.claude', 'skills', 'kept')
    await writeSkill(agentDir, 'kept', 'agent')
    const agent = await service.apply({ action: 'import', kind: 'skill', source: agentDir })
    expect(agent.results[0]?.code).toBe('imported')
    expect((await lstat(agentDir)).isSymbolicLink()).toBe(true)
    expect((await lstat(skillDir)).isSymbolicLink()).toBe(false)

    const systemDir = join(home, '.claude', 'skills', '.system', 'bundled')
    await writeSkill(systemDir, 'bundled', 'system')
    const system = await service.apply({ action: 'import', kind: 'skill', source: systemDir })
    expect(system.results[0]?.code).toBe('plugin_owned')
    expect((await lstat(systemDir)).isSymbolicLink()).toBe(false)
  })

  it('does not move a plugin skill found by a local path, and All skips targets that cannot take a link', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    const pluginDir = join(home, '.claude', 'plugins', 'pack', 'owned')
    await writeSkill(pluginDir, 'owned', 'plugin')
    await writeSkill(join(home, '.claude', 'skills', 'kept'), 'kept', 'user')
    const service = serviceWith({ claude: launcher('claude', { HOME: home }) }, dataRoot)

    const found = await service.apply({ action: 'find', kind: 'skill', source: pluginDir })
    expect(found.found?.[0]?.readOnly).toBe(true)
    const refused = await service.apply({ action: 'import', kind: 'skill', source: pluginDir })
    expect(refused.results[0]?.code).toBe('plugin_owned')
    expect((await lstat(pluginDir)).isSymbolicLink()).toBe(false)

    const page = await service.discover({ kind: 'skill' })
    const kept = page.found.find((item) => item.name === 'kept')
    const imported = await service.apply({ action: 'import', kind: 'skill', instanceId: kept!.id })
    const itemId = imported.results[0]!.libraryItemId!
    const assigned = await service.apply({ action: 'assign', kind: 'skill', libraryItemId: itemId, actor: '*', desired: 'on' })
    expect(assigned.results.some((entry) => entry.actor === 'cursor')).toBe(false)
    expect(assigned.results.some((entry) => entry.actor === 'claude' && entry.code === 'already')).toBe(true)
    await expect(stat(join('/unused', '.cursor'))).rejects.toThrow()
  })

  it('clones a local git skill without a shell and does not keep the staging directory', async () => {
    const repo = await tempDir()
    const dataRoot = await tempDir()
    const skill = join(repo, 'skills', 'demo')
    await writeSkill(skill, 'demo', 'from git')
    await mkdir(join(skill, 'scripts'))
    await writeFile(join(skill, 'scripts', 'run.sh'), 'echo no\n')
    const git = promisify(execFile)
    await git('git', ['init'], { cwd: repo })
    await git('git', ['add', '.'], { cwd: repo })
    await git('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'init'], { cwd: repo })
    const service = serviceWith({}, dataRoot)

    expect(parseGitSource('owner/repo;touch /tmp/pwn')).toBeNull()
    expect(parseGitSource('https://user:token@github.com/a/b')).toBeNull()
    expect(parseGitSource('acme/skills')?.url).toBe('https://github.com/acme/skills.git')
    const rejected = await service.apply({ action: 'find', kind: 'skill', source: 'owner/repo;touch /tmp/pwn' })
    expect(rejected.code).toBe('find_not_ready')

    const installed = await service.apply({ action: 'find', kind: 'skill', source: pathToFileURL(repo).href })
    expect(installed.results[0]?.code).toBe('installed')
    const item = (await readLibrary(dataRoot)).items[0]
    expect(item?.name).toBe('demo')
    expect(item?.repository).toBe(pathToFileURL(repo).href)
    expect(item?.version).toMatch(/^[0-9a-f]{7,64}$/i)
    expect(await readFile(join(item!.libraryPath!, 'scripts', 'run.sh'), 'utf8')).toContain('echo no')
    expect(await readdir(join(dataRoot, 'extensions', 'staging'))).toEqual([])
    const again = await service.apply({ action: 'find', kind: 'skill', source: pathToFileURL(repo).href })
    expect(again.results[0]?.code).toBe('already')
    expect((await readLibrary(dataRoot)).items).toHaveLength(1)

    const empty = await tempDir()
    await writeFile(join(empty, 'README.md'), 'no skill\n')
    await git('git', ['init'], { cwd: empty })
    await git('git', ['add', '.'], { cwd: empty })
    await git('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'init'], { cwd: empty })
    const missed = await service.apply({ action: 'find', kind: 'skill', source: pathToFileURL(empty).href })
    expect(missed.results[0]?.code).toBe('missing_skill')
    expect((await readLibrary(dataRoot)).items).toHaveLength(1)
  })

  it('probes a stdio MCP server for tool names and stops a server that never answers', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    const script = join(home, 'fake-mcp.js')
    await writeFile(script, `let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl = buf.indexOf('\\n')
  while (nl >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    const msg = JSON.parse(line)
    if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } }) + '\\n')
    if (msg.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo' }] } }) + '\\n')
    nl = buf.indexOf('\\n')
  }
})
`)
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { demo: { command: 'node', args: [script], env: { DEMO_TOKEN: 'secret' } } } }))
    const service = serviceWith({ claude: launcher('claude', { HOME: home }) }, dataRoot)
    const found = (await service.discover({ kind: 'mcp' })).found.find((item) => item.name === 'demo')
    const imported = await service.apply({ action: 'import', kind: 'mcp', instanceId: found!.id })
    const probed = await service.apply({ action: 'probe', libraryItemId: imported.results[0]!.libraryItemId! })
    expect(probed.tools).toEqual(['echo'])
    expect(JSON.stringify(probed)).not.toContain('secret')

    const pidFile = join(home, 'pid')
    const hang = join(home, 'hang.js')
    await writeFile(hang, `require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)\n`)
    const timed = await probeStdio({ command: 'node', args: [hang, pidFile], env: {} }, undefined, 400)
    expect(timed.results[0]?.code).toBe('timeout')
    const pid = Number(await readFile(pidFile, 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(() => process.kill(pid, 0)).toThrow()
  })
})

describe('library skill copy mode', () => {
  it('assigns a managed copy with a buddy marker when mode is copy', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    await mkdir(join(home, '.claude', 'skills'), { recursive: true })
    await mkdir(join(home, '.codex', 'skills'), { recursive: true })
    await writeSkill(join(home, '.claude', 'skills', 'shared-skill'), 'shared-skill', 'base')
    const service = serviceWith({
      claude: launcher('claude', { HOME: home }),
      codex: launcher('codex', { HOME: home, CODEX_HOME: join(home, '.codex') })
    }, dataRoot)
    const found = (await service.discover({ kind: 'skill' })).found.find((item) => item.name === 'shared-skill')
    const imported = await service.apply({ action: 'import', kind: 'skill', instanceId: found!.id })
    const itemId = imported.results[0]!.libraryItemId!
    const assigned = await service.apply({
      action: 'assign',
      kind: 'skill',
      libraryItemId: itemId,
      actor: 'codex',
      desired: 'on',
      mode: 'copy'
    })
    expect(assigned.results.map((entry) => `${entry.status}:${entry.code}`).join(',')).toContain('changed:assigned')
    expect(assigned.results[0]?.status).toBe('changed')
    const copyPath = join(home, '.codex', 'skills', 'shared-skill')
    expect((await lstat(copyPath)).isSymbolicLink()).toBe(false)
    expect(await readFile(join(copyPath, '.buddy-library'), 'utf8')).toContain('copied from')
    expect(await readFile(join(copyPath, 'SKILL.md'), 'utf8')).toContain('base')
    const binding = (await readLibrary(dataRoot)).bindings.find((entry) => entry.actor === 'codex' && entry.libraryItemId === itemId)
    expect(binding?.management).toBe('copy')
  })

  it('takeEdits recovers the newest copy into the library, backs up the old library, and syncs the other copy', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    await mkdir(join(home, '.claude', 'skills'), { recursive: true })
    await mkdir(join(home, '.codex', 'skills'), { recursive: true })
    await mkdir(join(home, '.config', 'opencode', 'skills'), { recursive: true })
    await writeSkill(join(home, '.claude', 'skills', 'shared-skill'), 'shared-skill', 'base')
    const service = serviceWith({
      claude: launcher('claude', { HOME: home }),
      codex: launcher('codex', { HOME: home, CODEX_HOME: join(home, '.codex') }),
      opencode: launcher('opencode', { HOME: home })
    }, dataRoot)
    const found = (await service.discover({ kind: 'skill' })).found.find((item) => item.name === 'shared-skill')
    const itemId = (await service.apply({ action: 'import', kind: 'skill', instanceId: found!.id })).results[0]!.libraryItemId!
    await service.apply({ action: 'assign', kind: 'skill', libraryItemId: itemId, actor: 'codex', desired: 'on', mode: 'copy' })
    await service.apply({ action: 'assign', kind: 'skill', libraryItemId: itemId, actor: 'opencode', desired: 'on', mode: 'copy' })

    const libraryPath = (await readLibrary(dataRoot)).items.find((item) => item.id === itemId)!.libraryPath!
    const beforeLibrary = await readFile(join(libraryPath, 'SKILL.md'), 'utf8')
    const codexSkill = join(home, '.codex', 'skills', 'shared-skill', 'SKILL.md')
    await writeFile(codexSkill, '---\nname: shared-skill\ndescription: edited-in-codex\n---\n\nCodex won\n')
    const future = new Date(Date.now() + 60_000)
    await utimes(codexSkill, future, future)

    const synced = await service.apply({ action: 'sync', kind: 'skill', libraryItemId: itemId })
    expect(synced.results.some((entry) => entry.code === 'taken')).toBe(true)
    expect(await readFile(join(libraryPath, 'SKILL.md'), 'utf8')).toContain('edited-in-codex')
    expect(await readFile(join(home, '.config', 'opencode', 'skills', 'shared-skill', 'SKILL.md'), 'utf8')).toContain('edited-in-codex')
    const backupText = await findBackupFile(join(dataRoot, 'extensions', 'backups'), 'SKILL.md')
    expect(backupText).toBe(beforeLibrary)
  })

  it('does not overwrite copies when one managed copy cannot be read', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    await mkdir(join(home, '.claude', 'skills'), { recursive: true })
    await mkdir(join(home, '.codex', 'skills'), { recursive: true })
    await mkdir(join(home, '.config', 'opencode', 'skills'), { recursive: true })
    await writeSkill(join(home, '.claude', 'skills', 'shared-skill'), 'shared-skill', 'base')
    const service = serviceWith({
      claude: launcher('claude', { HOME: home }),
      codex: launcher('codex', { HOME: home, CODEX_HOME: join(home, '.codex') }),
      opencode: launcher('opencode', { HOME: home })
    }, dataRoot)
    const found = (await service.discover({ kind: 'skill' })).found.find((item) => item.name === 'shared-skill')
    const itemId = (await service.apply({ action: 'import', kind: 'skill', instanceId: found!.id })).results[0]!.libraryItemId!
    await service.apply({ action: 'assign', kind: 'skill', libraryItemId: itemId, actor: 'codex', desired: 'on', mode: 'copy' })
    await service.apply({ action: 'assign', kind: 'skill', libraryItemId: itemId, actor: 'opencode', desired: 'on', mode: 'copy' })

    const broken = join(home, '.codex', 'skills', 'shared-skill')
    await chmod(broken, 0o000)
    try {
      const synced = await service.apply({ action: 'sync', kind: 'skill', libraryItemId: itemId })
      expect(synced.results.some((entry) => entry.code === 'read_failed')).toBe(true)
      expect(await readFile(join(home, '.config', 'opencode', 'skills', 'shared-skill', 'SKILL.md'), 'utf8')).toContain('base')
    } finally {
      await chmod(broken, 0o755)
    }
  })
})

describe('library subagents and hooks', () => {
  it('writes a Claude subagent file and refuses to delete one the user edited', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    await mkdir(join(home, '.claude'), { recursive: true })
    const service = serviceWith({ claude: launcher('claude', { HOME: home }) }, dataRoot)

    const saved = await service.apply({
      action: 'save',
      kind: 'subagent',
      name: 'reviewer',
      description: 'Reviews diffs',
      content: 'Check for bugs.'
    })
    const id = saved.results[0]!.libraryItemId!
    const assigned = await service.apply({ action: 'assign', kind: 'subagent', libraryItemId: id, actor: 'claude', desired: 'on' })
    expect(assigned.results[0]?.status).toBe('changed')
    const native = join(home, '.claude', 'agents', 'reviewer.md')
    const written = await readFile(native, 'utf8')
    expect(written).toContain('name: "reviewer"')
    expect(written).toContain('Check for bugs.')

    await writeFile(native, written.replace('Check for bugs.', 'User changed this.'))
    const blocked = await service.apply({ action: 'assign', kind: 'subagent', libraryItemId: id, actor: 'claude', desired: 'off' })
    expect(blocked.results[0]?.code).toBe('changed_externally')
    expect(await readFile(native, 'utf8')).toContain('User changed this.')

    await writeFile(native, written)
    const revoked = await service.apply({ action: 'assign', kind: 'subagent', libraryItemId: id, actor: 'claude', desired: 'off' })
    expect(revoked.results[0]?.code).toBe('revoked')
    await expect(stat(native)).rejects.toThrow()
  })

  it('adds and removes a Claude hook entry without touching other hooks', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', 'settings.json'), `${JSON.stringify({
      theme: 'dark',
      hooks: {
        Stop: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook' }] }]
      }
    }, null, 2)}\n`)
    const service = serviceWith({ claude: launcher('claude', { HOME: home }) }, dataRoot)
    const saved = await service.apply({
      action: 'save',
      kind: 'hook',
      name: 'notify-stop',
      description: 'Notify on stop',
      event: 'turn-end',
      command: 'buddy-notify'
    })
    const id = saved.results[0]!.libraryItemId!
    await service.apply({ action: 'assign', kind: 'hook', libraryItemId: id, actor: 'claude', desired: 'on' })
    const afterOn = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8')) as {
      theme: string
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> }
    }
    expect(afterOn.theme).toBe('dark')
    expect(afterOn.hooks.Stop).toHaveLength(2)
    expect(afterOn.hooks.Stop.some((entry) => entry.hooks?.[0]?.command === 'user-hook')).toBe(true)
    expect(afterOn.hooks.Stop.some((entry) => entry.hooks?.[0]?.command === 'buddy-notify')).toBe(true)

    await service.apply({ action: 'assign', kind: 'hook', libraryItemId: id, actor: 'claude', desired: 'off' })
    const afterOff = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8')) as {
      theme: string
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> }
    }
    expect(afterOff.theme).toBe('dark')
    expect(afterOff.hooks.Stop).toHaveLength(1)
    expect(afterOff.hooks.Stop[0]?.hooks?.[0]?.command).toBe('user-hook')

    const cursorBlocked = await service.apply({ action: 'assign', kind: 'hook', libraryItemId: id, actor: 'cursor', desired: 'on' })
    expect(cursorBlocked.results[0]?.code).toBe('unsupported')
  })

  it('refuses to revoke a hook entry after the user edited it', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', 'settings.json'), '{}\n')
    const service = serviceWith({ claude: launcher('claude', { HOME: home }) }, dataRoot)
    const saved = await service.apply({
      action: 'save',
      kind: 'hook',
      name: 'fmt',
      event: 'after-tool',
      matcher: 'edit',
      command: 'prettier'
    })
    const id = saved.results[0]!.libraryItemId!
    await service.apply({ action: 'assign', kind: 'hook', libraryItemId: id, actor: 'claude', desired: 'on' })
    const path = join(home, '.claude', 'settings.json')
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { hooks: { PostToolUse: Array<Record<string, unknown>> } }
    parsed.hooks.PostToolUse[0] = { ...parsed.hooks.PostToolUse[0], matcher: 'Write' }
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`)
    const blocked = await service.apply({ action: 'assign', kind: 'hook', libraryItemId: id, actor: 'claude', desired: 'off' })
    expect(blocked.results[0]?.code).toBe('changed_externally')
    const still = JSON.parse(await readFile(path, 'utf8')) as { hooks: { PostToolUse: unknown[] } }
    expect(still.hooks.PostToolUse).toHaveLength(1)
  })
})

describe('library instructions', () => {
  it('injects marker blocks, keeps user text, and revokes one instruction at a time', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    await mkdir(join(home, '.claude'), { recursive: true })
    await mkdir(join(home, '.codex'), { recursive: true })
    const userText = '# Project rules\n\nAlways run tests.\nKeep this paragraph.\n'
    await writeFile(join(home, '.claude', 'CLAUDE.md'), userText)
    await writeFile(join(home, '.codex', 'AGENTS.md'), 'Codex house rules.\n')

    const service = serviceWith({
      claude: launcher('claude', { HOME: home }),
      codex: launcher('codex', { HOME: home, CODEX_HOME: join(home, '.codex') })
    }, dataRoot)

    const savedA = await service.apply({
      action: 'save',
      kind: 'instruction',
      name: 'Review style',
      content: 'Prefer small diffs.'
    })
    expect(savedA.results[0]?.code).toBe('saved')
    const idA = savedA.results[0]!.libraryItemId!
    const savedB = await service.apply({
      action: 'save',
      kind: 'instruction',
      name: 'Security',
      content: 'Never log secrets.'
    })
    const idB = savedB.results[0]!.libraryItemId!

    const onClaudeA = await service.apply({ action: 'assign', kind: 'instruction', libraryItemId: idA, actor: 'claude', desired: 'on' })
    expect(onClaudeA.results[0]?.status).toBe('changed')
    const onClaudeB = await service.apply({ action: 'assign', kind: 'instruction', libraryItemId: idB, actor: 'claude', desired: 'on' })
    expect(onClaudeB.results[0]?.status).toBe('changed')
    const onCodexA = await service.apply({ action: 'assign', kind: 'instruction', libraryItemId: idA, actor: 'codex', desired: 'on' })
    expect(onCodexA.results[0]?.status).toBe('changed')

    const claudeAfter = await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')
    expect(claudeAfter.startsWith('# Project rules')).toBe(true)
    expect(claudeAfter).toContain('Always run tests.')
    expect(claudeAfter).toContain('Keep this paragraph.')
    expect(claudeAfter).toContain(`<!-- BEGIN BUDDY MANAGED INSTRUCTION: ${idA} -->`)
    expect(claudeAfter).toContain('Prefer small diffs.')
    expect(claudeAfter).toContain(`<!-- END BUDDY MANAGED INSTRUCTION: ${idA} -->`)
    expect(claudeAfter).toContain(`<!-- BEGIN BUDDY MANAGED INSTRUCTION: ${idB} -->`)
    expect(claudeAfter).toContain('Never log secrets.')

    const codexAfter = await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8')
    expect(codexAfter).toContain('Codex house rules.')
    expect(codexAfter).toContain('Prefer small diffs.')
    expect(codexAfter).not.toContain('Never log secrets.')

    const revoked = await service.apply({ action: 'assign', kind: 'instruction', libraryItemId: idA, actor: 'claude', desired: 'off' })
    expect(revoked.results[0]?.code).toBe('revoked')
    const claudeRevoked = await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')
    expect(claudeRevoked).toContain('Always run tests.')
    expect(claudeRevoked).toContain('Keep this paragraph.')
    expect(claudeRevoked).not.toContain(idA)
    expect(claudeRevoked).not.toContain('Prefer small diffs.')
    expect(claudeRevoked).toContain(idB)
    expect(claudeRevoked).toContain('Never log secrets.')
    // exact user prose still present; only Buddy blocks and joining newlines may differ
    expect(claudeRevoked.replace(/\n+$/, '\n')).toContain('# Project rules\n\nAlways run tests.\nKeep this paragraph.')

    const cursorBlocked = await service.apply({ action: 'assign', kind: 'instruction', libraryItemId: idB, actor: 'cursor', desired: 'on' })
    expect(cursorBlocked.results[0]?.code).toBe('unsupported')
    await expect(stat(join(home, '.cursor'))).rejects.toThrow()
  })

  it('creates a missing instruction file and restores an empty file after revoke', async () => {
    const home = await tempDir()
    const dataRoot = await tempDir()
    await mkdir(join(home, '.claude'), { recursive: true })
    const service = serviceWith({ claude: launcher('claude', { HOME: home }) }, dataRoot)
    const saved = await service.apply({ action: 'save', kind: 'instruction', name: 'Alone', content: 'Solo block.' })
    const id = saved.results[0]!.libraryItemId!
    await service.apply({ action: 'assign', kind: 'instruction', libraryItemId: id, actor: 'claude', desired: 'on' })
    const written = await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')
    expect(written).toContain('Solo block.')
    await service.apply({ action: 'assign', kind: 'instruction', libraryItemId: id, actor: 'claude', desired: 'off' })
    expect(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('')
  })
})

async function findBackupFile(root: string, fileName: string): Promise<string> {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    for (const name of await readdir(dir)) {
      const path = join(dir, name)
      const info = await stat(path)
      if (info.isDirectory()) stack.push(path)
      else if (name === fileName) return readFile(path, 'utf8')
    }
  }
  throw new Error(`backup file ${fileName} not found under ${root}`)
}

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'buddy-ext-'))
  roots.push(root)
  return root
}

async function writeSkill(directory: string, name: string, description: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody\n`)
}

function launcher(command: string, env: Record<string, string> = {}, extra: Partial<Launcher> = {}): Launcher {
  return {
    command,
    timeout_seconds: 30,
    ...extra,
    env
  }
}

function serviceWith(launchers: Record<string, Launcher>, dataRoot?: string): ExtensionService {
  return new ExtensionService({
    dataRoot: dataRoot ?? roots[0],
    homeDir: '/unused',
    processEnv: {},
    readGlobalSettings: async () => normalizeGlobalSettings({ launchers })
  })
}

describe('library review regressions', () => {
  it.each(['claude', 'codex', 'wecode_claude', 'wecode_codex'].flatMap(actor => ['direct', 'absolute', 'npx'].map(form => ({ actor, form }))))('recognizes $actor adapter in $form form', async ({ actor, form }) => {
    const binary = actor.includes('codex') ? 'codex-acp' : 'claude-agent-acp'
    const target = await resolveExtensionTarget({ actor, launcher: launcher(form === 'npx' ? 'npx' : form === 'absolute' ? `/opt/bin/${binary}` : binary, {}, { protocol: 'acp', args: form === 'npx' ? ['-y', `@agentclientprotocol/${binary}`] : [] }), homeDir: await tempDir(), dataRoot: await tempDir(), processEnv: {} })
    expect(target.adapter).toBe(actor.includes('codex') ? 'codex' : 'claude')
    expect(target.resolution).toBe('ready')
  })

  async function fixture() {
    const home = await tempDir(), dataRoot = await tempDir()
    await writeSkill(join(home, '.claude/skills/review'), 'review', 'original')
    await mkdir(join(home, '.codex/skills'), { recursive: true })
    const launchers = { claude: launcher('claude', { HOME: home }), codex: launcher('codex', { HOME: home, CODEX_HOME: join(home, '.codex') }) }
    const service = serviceWith(launchers, dataRoot)
    const found = (await service.discover({ kind: 'skill' })).found.find(i => i.actor === 'claude' && i.name === 'review')!
    const id = (await service.apply({ action: 'import', kind: 'skill', instanceId: found.id })).results[0].libraryItemId!
    const source = (await service.readLibrary()).items.find(i => i.id === id)!.libraryPath!
    return { home, dataRoot, service, launchers, id, source, copy: join(home, '.codex/skills/review') }
  }

  it('persists default and agent modes, converts existing distributions both ways and restores inheritance', async () => {
    const f = await fixture()
    await f.service.apply({ action: 'assign', kind: 'skill', libraryItemId: f.id, actor: 'codex', desired: 'on' })
    await f.service.apply({ action: 'skill_mode', kind: 'skill', mode: 'copy' })
    expect((await lstat(f.copy)).isSymbolicLink()).toBe(false)
    await f.service.apply({ action: 'skill_mode', kind: 'skill', actor: 'codex', mode: 'link' })
    expect((await lstat(f.copy)).isSymbolicLink()).toBe(true)
    const restarted = serviceWith(f.launchers, f.dataRoot)
    expect((await restarted.readLibrary()).skillAgentModes).toEqual({ codex: 'link' })
    await restarted.apply({ action: 'skill_mode', kind: 'skill', actor: 'codex', inherit: true })
    expect((await lstat(f.copy)).isSymbolicLink()).toBe(false)
    expect((await restarted.readLibrary()).skillAgentModes).toEqual({})
  })

  it.each(['off', 'remove', 'link'] as const)('recovers edited copies before %s', async operation => {
    const f = await fixture()
    await f.service.apply({ action: 'assign', kind: 'skill', libraryItemId: f.id, actor: 'codex', desired: 'on', mode: 'copy' })
    await writeSkill(f.copy, 'review', 'UNSYNCED-EDIT')
    const future = new Date(Date.now() + 10_000)
    await utimes(join(f.copy, 'SKILL.md'), future, future)
    const response = await f.service.apply(operation === 'remove' ? { action: 'remove', kind: 'skill', libraryItemId: f.id } : { action: 'assign', kind: 'skill', libraryItemId: f.id, actor: 'codex', desired: operation === 'off' ? 'off' : 'on', mode: 'link' })
    expect(response.accepted).toBe(true)
    if (operation !== 'remove') expect(await readFile(join(f.source, 'SKILL.md'), 'utf8')).toContain('UNSYNCED-EDIT')
    if (operation === 'link') expect((await lstat(f.copy)).isSymbolicLink()).toBe(true)
    const files = await readdir(join(f.dataRoot, 'extensions/backups'), { recursive: true })
    const texts = await Promise.all(files.filter(p => p.endsWith('SKILL.md')).map(p => readFile(join(f.dataRoot, 'extensions/backups', p), 'utf8')))
    expect(texts.some(s => s.includes('UNSYNCED-EDIT'))).toBe(true)
  })

  it('refuses cross-kind removal and keeps every resource', async () => {
    const f = await fixture()
    const saved = await f.service.apply({ action: 'save', kind: 'instruction', name: 'rules', content: 'keep me' })
    const id = saved.results[0].libraryItemId!
    const response = await f.service.apply({ action: 'remove', kind: 'skill', libraryItemId: id })
    expect(response.accepted).toBe(false)
    expect((await f.service.readLibrary()).items.some(i => i.id === id)).toBe(true)
  })

  it('reports copy differences without modifying files and recovers them at startup', async () => {
    const f = await fixture()
    await f.service.apply({ action: 'assign', kind: 'skill', libraryItemId: f.id, actor: 'codex', desired: 'on', mode: 'copy' })
    await writeSkill(f.copy, 'review', 'startup-edit')
    const future = new Date(Date.now() + 10_000)
    await utimes(join(f.copy, 'SKILL.md'), future, future)
    expect((await f.service.discover({ kind: 'skill' })).copyDifferences).toContainEqual({ libraryItemId: f.id, actor: 'codex' })
    expect(await readFile(join(f.source, 'SKILL.md'), 'utf8')).not.toContain('startup-edit')
    const restarted = serviceWith(f.launchers, f.dataRoot)
    await restarted.initialize()
    expect(await readFile(join(f.source, 'SKILL.md'), 'utf8')).toContain('startup-edit')
    expect((await restarted.discover({ kind: 'skill' })).copyDifferences).toEqual([])
  })

  it('coordinates agents sharing the same native folder', async () => {
    const f = await fixture()
    const service = serviceWith({ ...f.launchers, wecode_codex: launcher('codex', { HOME: f.home, CODEX_HOME: join(f.home, '.codex') }) }, f.dataRoot)
    await service.apply({ action: 'assign', kind: 'skill', libraryItemId: f.id, actor: 'codex', desired: 'on' })
    await service.apply({ action: 'skill_mode', kind: 'skill', mode: 'copy' })
    await service.apply({ action: 'skill_mode', kind: 'skill', actor: 'codex', mode: 'link' })
    expect((await lstat(f.copy)).isSymbolicLink()).toBe(false)
    await service.apply({ action: 'skill_mode', kind: 'skill', actor: 'wecode_codex', mode: 'link' })
    expect((await lstat(f.copy)).isSymbolicLink()).toBe(true)
  })

  it('applies the chosen default to newly imported skills', async () => {
    const f = await fixture()
    await f.service.apply({ action: 'skill_mode', kind: 'skill', mode: 'copy' })
    const source = join(f.home, '.claude/skills/future')
    await writeSkill(source, 'future', 'new skill')
    const found = (await f.service.discover({ kind: 'skill' })).found.find(i => i.name === 'future')!
    const imported = await f.service.apply({ action: 'import', kind: 'skill', instanceId: found.id })
    expect(imported.accepted).toBe(true)
    expect((await lstat(source)).isSymbolicLink()).toBe(false)
    expect(await readFile(join(source, '.buddy-library'), 'utf8')).toContain('copied from')
    expect((await f.service.discover({ kind: 'skill' })).found.some(i => i.name === 'future')).toBe(false)
  })

  it('preserves copies when the launcher becomes unrecognized or a destination is replaced', async () => {
    const f = await fixture()
    await f.service.apply({ action: 'assign', kind: 'skill', libraryItemId: f.id, actor: 'codex', desired: 'on', mode: 'copy' })
    const changed = serviceWith({ ...f.launchers, codex: launcher('custom-tool', { HOME: f.home }) }, f.dataRoot)
    expect((await changed.initialize()).results.some(r => r.status === 'failed')).toBe(true)
    expect(await readFile(join(f.copy, 'SKILL.md'), 'utf8')).toContain('original')
    await rm(join(f.copy, '.buddy-library'))
    await writeFile(join(f.copy, 'SKILL.md'), 'Unmanaged replacement')
    expect((await f.service.apply({ action: 'sync', kind: 'skill' })).results.some(r => r.code === 'conflict')).toBe(true)
    expect(await readFile(join(f.copy, 'SKILL.md'), 'utf8')).toBe('Unmanaged replacement')
  })

  it('serializes concurrent mode writes without losing settings', async () => {
    const f = await fixture()
    await Promise.all(['claude', 'codex'].map(actor => f.service.apply({ action: 'skill_mode', kind: 'skill', actor, mode: 'copy' })))
    expect((await f.service.readLibrary()).skillAgentModes).toEqual({ claude: 'copy', codex: 'copy' })
  })
})

describe('library upstream updates', () => {
  it('checks revisions, protects edited resources, backs up explicit replacement and synchronizes copies', async () => {
    const repo = await tempDir(), home = await tempDir(), dataRoot = await tempDir()
    const git = promisify(execFile)
    await git('git', ['init', repo])
    await writeSkill(join(repo, 'skills/demo'), 'demo', 'upstream one')
    await writeFile(join(repo, 'skills/demo/helper.txt'), 'helper one')
    const commit = async () => {
      await git('git', ['-C', repo, 'add', '.'])
      await git('git', ['-C', repo, '-c', 'user.name=Buddy Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'])
    }
    await commit()
    await mkdir(join(home, '.codex/skills'), { recursive: true })
    const service = serviceWith({ codex: launcher('codex', { HOME: home, CODEX_HOME: join(home, '.codex') }) }, dataRoot)
    const installed = await service.apply({ action: 'find', kind: 'skill', source: pathToFileURL(repo).href })
    const id = installed.results[0].libraryItemId!
    const item = (await service.readLibrary()).items.find(i => i.id === id)!
    await service.apply({ action: 'assign', kind: 'skill', libraryItemId: id, actor: 'codex', desired: 'on', mode: 'copy' })
    expect(await readFile(join(home, '.codex/skills/demo/helper.txt'), 'utf8')).toBe('helper one')
    await writeFile(join(item.libraryPath!, 'helper.txt'), 'local helper edit')
    await writeSkill(join(repo, 'skills/demo'), 'demo', 'upstream two')
    await writeFile(join(repo, 'skills/demo/helper.txt'), 'helper two')
    await commit()
    await service.apply({ action: 'check_updates', kind: 'skill' })
    const checked = (await service.readLibrary()).items.find(i => i.id === id)!
    expect(checked.updateAvailable).toBeTruthy()
    expect(checked.locallyEdited).toBe(true)
    expect((await service.apply({ action: 'update', kind: 'skill', libraryItemId: id })).results[0].code).toBe('changed_externally')
    expect(await readFile(join(item.libraryPath!, 'helper.txt'), 'utf8')).toBe('local helper edit')
    expect((await service.apply({ action: 'update', kind: 'skill', libraryItemId: id, replace: true })).accepted).toBe(true)
    expect(await readFile(join(home, '.codex/skills/demo/helper.txt'), 'utf8')).toBe('helper two')
    expect(await findBackupFile(join(dataRoot, 'extensions/backups'), 'helper.txt')).toBe('local helper edit')
  })
})
