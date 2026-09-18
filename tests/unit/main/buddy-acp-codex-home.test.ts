import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareCodexHome } from '../../../src/main/buddy/acp/codex-home'
import { prepareAcpEnvironment } from '../../../src/main/buddy/acp/agent-catalog'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

let root: string
let source: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'buddy-codex-home-'))
  source = join(root, 'desktop')
  await mkdir(source)
  vi.stubEnv('CODEX_HOME', source)
  vi.stubEnv('CODEX_SQLITE_HOME', source)
  await writeFile(join(source, 'config.toml'), 'model = "test-model"\n')
  await writeFile(join(source, 'auth.json'), '{"token":"test-only"}')
  await chmod(join(source, 'auth.json'), 0o644)
  await writeFile(join(source, 'state_5.sqlite'), 'not a real database')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('ACP Codex storage isolation', () => {
  it('isolates both actors and their inherited SQLite root, while retaining bootstrap config', async () => {
    for (const actor of ['codex', 'wecode_codex']) {
      const env = await prepareAcpEnvironment(actor, { CUSTOM: 'kept' }, root)
      expect(env.CODEX_HOME).toBe(join(root, 'acp', actor, 'codex-home'))
      expect(env.CODEX_SQLITE_HOME).toBe(env.CODEX_HOME)
      expect(env.CUSTOM).toBe('kept')
      expect(await readFile(join(env.CODEX_HOME, 'config.toml'), 'utf8')).toContain('test-model')
      expect((await lstat(join(env.CODEX_HOME, 'auth.json'))).mode & 0o777).toBe(0o600)
      expect((await lstat(join(env.CODEX_HOME, 'config.toml'))).isSymbolicLink()).toBe(false)
      expect(await readdir(env.CODEX_HOME)).not.toContain('state_5.sqlite')
      await writeFile(join(env.CODEX_HOME, 'config.toml'), 'private provider configuration')
      await prepareAcpEnvironment(actor, {}, root)
      expect(await readFile(join(env.CODEX_HOME, 'config.toml'), 'utf8')).toBe('private provider configuration')
    }
    expect(await readFile(join(source, 'config.toml'), 'utf8')).toBe('model = "test-model"\n')
  })

  it('copies only a selected legacy rollout and never overwrites resumed progress', async () => {
    const relative = 'sessions/2026/09/18'
    await mkdir(join(source, relative), { recursive: true })
    const filename = 'rollout-2026-09-18T10-00-00-legacy-123.jsonl'
    await writeFile(join(source, relative, filename), 'legacy history')
    await writeFile(join(source, relative, 'rollout-other.jsonl'), 'unrelated history')
    const home = await prepareCodexHome('codex', root, {}, 'legacy-123', source)
    expect(await readdir(join(home, relative))).toEqual([filename])
    expect(await readFile(join(home, relative, filename), 'utf8')).toBe('legacy history')
    await writeFile(join(home, relative, filename), 'resumed progress')
    await prepareCodexHome('codex', root, {}, 'legacy-123', source)
    expect(await readFile(join(home, relative, filename), 'utf8')).toBe('resumed progress')
    expect(await readFile(join(source, relative, filename), 'utf8')).toBe('legacy history')
  })

  it('serializes concurrent probe/run initialization without partial files', async () => {
    const homes = await Promise.all(Array.from({ length: 6 }, () => prepareCodexHome('codex', root, {}, undefined, source)))
    expect(new Set(homes).size).toBe(1)
    expect(await readFile(join(homes[0], 'auth.json'), 'utf8')).toBe('{"token":"test-only"}')
    expect((await readdir(homes[0])).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('honors an explicit launcher home and leaves other actors untouched', async () => {
    const custom = join(root, 'custom')
    const env = await prepareAcpEnvironment('codex', { CODEX_HOME: custom }, root)
    expect(env.CODEX_HOME).toBe(custom)
    expect(env.CODEX_SQLITE_HOME).toBe(custom)
    expect(await prepareAcpEnvironment('opencode', { CUSTOM: 'kept' }, root)).toEqual({ CUSTOM: 'kept' })
  })

  it('wraps a custom executable and passes the isolated DB override literally', async () => {
    const executable = join(root, 'fake codex')
    await writeFile(executable, '#!/bin/bash\nprintf "%s\\n" "$@"\n', { mode: 0o700 })
    const customHome = join(root, 'home with "quotes" and $literal')
    const env = await prepareAcpEnvironment('codex', { CODEX_HOME: customHome, CODEX_PATH: executable }, root)
    const { stdout } = await promisify(execFile)(env.CODEX_PATH, ['app-server'], { env: { ...process.env, ...env } })
    expect(stdout.split('\n')).toEqual(['-c', `sqlite_home=${JSON.stringify(customHome)}`, 'app-server', ''])
  })
})
