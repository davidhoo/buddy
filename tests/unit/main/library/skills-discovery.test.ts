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
