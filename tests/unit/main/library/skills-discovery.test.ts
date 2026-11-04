import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { discoverSkills } from '../../../../src/main/buddy/library/discovery'
import { resolveLibraryTargets } from '../../../../src/main/buddy/library/targets'
import type { LibraryTarget } from '../../../../src/shared/library'

it('scans shared home skills without installed agents and deduplicates agent links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-shared-skills-'))
  vi.stubEnv('HOME', root)
  try {
    const shared = join(root, '.agents', 'skills', 'shared-skill')
    const native = join(root, '.cursor', 'skills')
    await mkdir(shared, { recursive: true })
    await writeFile(join(shared, 'SKILL.md'), '---\nname: shared-skill\ndescription: Shared user skill\n---\n')
    await mkdir(native, { recursive: true })
    await symlink(shared, join(native, 'shared-skill'))

    const targets = await resolveLibraryTargets([], join(root, 'buddy'))
    const skills = await discoverSkills(targets, [])
    const { groupSkillTargets } = await import('../../../../src/shared/library')
    expect(targets.some((target) => target.agentId === 'shared')).toBe(true)
    expect(groupSkillTargets(targets).some((target) => target.agentId === 'shared')).toBe(false)
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      name: 'shared-skill', description: 'Shared user skill', path: shared,
      agentId: 'shared', targetId: 'shared:native:user'
    })

    await rm(join(root, '.agents'), { recursive: true, force: true })
    expect(await discoverSkills(targets, [])).toEqual([])
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})

it('discovers only user skills and counts a shared skill once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-discover-skills-'))
  try {
    const native = join(root, 'native')
    const second = join(root, 'second')
    const user = join(native, 'user-skill')
    const builtin = join(native, '.system', 'builtin')
    const plugin = join(root, 'plugins', 'cache', 'extension')
    for (const dir of [user, builtin, plugin]) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), '# Skill\n')
    }
    await mkdir(join(native, 'empty'))
    await mkdir(second)
    await symlink(user, join(second, 'user-skill'))
    await symlink(builtin, join(second, 'builtin'))
    await symlink(plugin, join(second, 'extension'))
    await symlink(join(root, 'missing'), join(second, 'broken'))

    const targets: LibraryTarget[] = [native, second, native].map((skillsDir, index) => ({
      targetId: String(index),
      agentId: 'codex',
      displayName: 'Codex',
      configContext: 'native',
      scope: 'user',
      skillsDir,
      capabilities: { readSkills: true, writeSkills: true, readMcp: false, writeMcp: false, authProbe: false, diagnose: false }
    }))
    const skills = await discoverSkills(targets, [])
    expect(skills.map((skill) => skill.path)).toEqual([user])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('exposes CodeBuddy and dsh skill roots and merges only physically shared wrapper roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-skill-targets-'))
  vi.stubEnv('HOME', root)
  vi.stubEnv('DSH_HOME', join(root, 'custom-dsh'))
  vi.stubEnv('CODEBUDDY_CONFIG_DIR', join(root, 'custom-codebuddy'))
  try {
    const { groupSkillTargets } = await import('../../../../src/shared/library')
    const native = join(root, '.codex', 'skills')
    await mkdir(native, { recursive: true })
    for (const actor of ['codex', 'wecode_codex']) {
      const home = join(root, 'buddy', 'acp', actor, 'codex-home')
      await mkdir(home, { recursive: true })
      await symlink(native, join(home, 'skills'))
    }
    const agents = [
      { id: 'wecode_codex', enabled: true },
      { id: 'wecode_claude', enabled: true },
      { id: 'wecode_opencode', enabled: true, cli: { env: { OPENCODE_CONFIG_DIR: join(root, 'separate-opencode') } } }
    ] as import('../../../../src/shared/agents').LocalAgent[]
    const targets = await resolveLibraryTargets(agents, join(root, 'buddy'))
    expect(targets.find((t) => t.agentId === 'codebuddy')?.skillsDir).toBe(join(root, 'custom-codebuddy', 'skills'))
    expect(targets.find((t) => t.agentId === 'dsh')?.skillsDir).toBe(join(root, 'custom-dsh', 'skills'))
    const groups = groupSkillTargets(targets)
    const codex = groups.filter((t) => t.agentId === 'codex')
    expect(codex).toHaveLength(1)
    expect(codex[0].linkedSkillTargetIds).toEqual(expect.arrayContaining(['codex:buddy-acp:user', 'wecode_codex:wecode:user']))
    expect(codex[0].displayName).toContain('WeCode Codex ACP')
    expect(groups.find((t) => t.agentId === 'claude')?.linkedSkillTargetIds).toContain('wecode_claude:wecode:user')
    expect(groups.find((t) => t.agentId === 'wecode_opencode')?.skillsDir).toBe(join(root, 'separate-opencode', 'skills'))
    // Grouping is a view operation: independent MCP contexts are preserved.
    expect(targets.filter((t) => t.mcpFormat === 'toml-mcp_servers')).toHaveLength(3)
    expect(targets.find((t) => t.displayName === 'Codex')?.displayName).toBe('Codex')
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
