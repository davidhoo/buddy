import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readlink, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryStore } from '../../../../src/main/buddy/library/store'
import { ejectSkill, importDiscoveredSkill } from '../../../../src/main/buddy/library/skills'
import type { DiscoveredSkill, LibraryTarget } from '../../../../src/shared/library'

describe('skills import / eject', () => {
  it('migrates a normal skill dir then ejects it back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-skill-'))
    const agentSkills = join(root, 'agent-skills')
    const skillDir = join(agentSkills, 'demo')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: hi\n---\n\n# demo\n', 'utf8')
    await writeFile(join(skillDir, 'extra.txt'), 'keep-me', 'utf8')

    const store = new LibraryStore(join(root, 'buddy-data'))
    const discovered: DiscoveredSkill = {
      discoveryId: 't:demo',
      name: 'demo',
      description: 'hi',
      path: skillDir,
      physicalKey: skillDir,
      targetId: 'claude:native:user',
      agentId: 'claude',
      scope: 'user',
      isSymlink: false,
      isGitRoot: false,
      alreadyImported: false
    }
    const targets: LibraryTarget[] = [{
      targetId: 'claude:native:user',
      agentId: 'claude',
      displayName: 'Claude',
      configContext: 'native',
      scope: 'user',
      skillsDir: agentSkills,
      skillsPhysicalKey: agentSkills,
      mcpFormat: 'jsonc-mcpServers',
      capabilities: { readSkills: true, writeSkills: true, readMcp: false, writeMcp: false, authProbe: false, diagnose: false }
    }]

    const imported = await importDiscoveredSkill(store, discovered, targets)
    expect(imported.status).toBe('ok')
    const link = await readlink(skillDir)
    expect(link).toContain('library/skills/demo')
    expect(await readFile(join(link, 'extra.txt'), 'utf8')).toBe('keep-me')

    const meta = await store.readMeta()
    const eject = await ejectSkill(store, meta.skills[0].id)
    expect(eject.status).toBe('ok')
    expect((await lstat(skillDir)).isSymbolicLink()).toBe(false)
    expect(await readFile(join(skillDir, 'extra.txt'), 'utf8')).toBe('keep-me')
    expect((await store.readMeta()).skills).toHaveLength(0)
  })

  it('refuses to mv a git-root skill and imports as external ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-skill-git-'))
    const skillDir = join(root, 'repo-skill')
    await mkdir(join(skillDir, '.git'), { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), 'name: repo\n', 'utf8')
    const store = new LibraryStore(join(root, 'data'))
    const discovered: DiscoveredSkill = {
      discoveryId: 't:repo',
      name: 'repo',
      path: skillDir,
      physicalKey: skillDir,
      targetId: 'claude:native:user',
      agentId: 'claude',
      scope: 'user',
      isSymlink: false,
      isGitRoot: true,
      alreadyImported: false
    }
    const result = await importDiscoveredSkill(store, discovered, [])
    expect(result.status).toBe('ok')
    expect(result.message).toMatch(/external/)
    const meta = await store.readMeta()
    expect(meta.skills[0].importMode).toBe('external-ref')
    expect((await lstat(skillDir)).isDirectory()).toBe(true)
  })
})
