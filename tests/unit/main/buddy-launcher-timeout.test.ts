import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/main/buddy/launchers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/buddy/launchers')>()
  return { ...actual, runLauncher: vi.fn(), runLauncherWithPty: vi.fn() }
})

import { runLauncher, runLauncherWithPty } from '../../../src/main/buddy/launchers'
import { BuddyRunner } from '../../../src/main/buddy/runner'
import { BuddyStore } from '../../../src/main/buddy/store'
import { BuddyCoreService } from '../../../src/main/buddy/service'

describe('deadline handling across launcher paths', () => {
  beforeEach(() => vi.resetAllMocks())

  it('does not retry a timed-out health check even with an upgrade banner', async () => {
    vi.mocked(runLauncher).mockImplementation(async (input) => {
      input.onStderr('A new version is available. Upgrade complete.')
      return { exitCode: 0, signal: null, timedOut: true }
    })
    const root = await mkdtemp(join(tmpdir(), 'buddy-ping-timeout-'))
    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_upgrade_retries: 3 })
    const created = await store.createTask({ task_id: 'demo', repo_root: root })
    await expect(new BuddyRunner(store).startTask('demo', { workspace_key: created.workspace_key }))
      .rejects.toThrow('timed out after 120 seconds')
    // Health checks ping both actors concurrently, once each.
    expect(runLauncher).toHaveBeenCalledTimes(2)
    expect(new Set(vi.mocked(runLauncher).mock.calls.map(([input]) => input.command)).size).toBe(2)
    const detail = await store.getTaskDetail('demo', created.workspace_key)
    expect(detail.events.some((e) => e.type === 'health_check.actor_upgrade_retry')).toBe(false)
  })

  it('does not retry or complete a timed-out PTY actor that exits with code 0', async () => {
    vi.mocked(runLauncherWithPty).mockImplementation(async (input) => {
      input.onData('Auto-update in progress\n')
      return { exitCode: 0, signal: null, timedOut: true }
    })
    const root = await mkdtemp(join(tmpdir(), 'buddy-pty-timeout-'))
    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_upgrade_retries: 3 })
    const created = await store.createTask({
      task_id: 'demo', repo_root: root,
      settings: { launchers: { opencode: { command: 'opencode', env: {}, timeout_seconds: 5 } } }
    })
    await expect(new BuddyRunner(store).startTask('demo', { workspace_key: created.workspace_key, actor: 'opencode' }))
      .rejects.toThrow('timed out after 5 seconds')
    expect(runLauncherWithPty).toHaveBeenCalledTimes(1)
    const detail = await store.getTaskDetail('demo', created.workspace_key)
    expect(detail.events.some((e) => ['actor.upgrade_detected', 'actor.completed'].includes(e.type))).toBe(false)
  })

  it('returns explicit timeout error when testLauncher times out', async () => {
    vi.mocked(runLauncher).mockImplementation(async () => {
      return { exitCode: null, signal: 'SIGTERM', timedOut: true }
    })
    const root = await mkdtemp(join(tmpdir(), 'buddy-service-timeout-'))
    const fakeScript = join(root, 'fake-agy.sh')
    await writeFile(fakeScript, '#!/bin/sh\nexit 0\n')
    await chmod(fakeScript, 0o755)

    const service = new BuddyCoreService({ dataRoot: root })
    const result = await service.testLauncher('agy', fakeScript)
    expect(result.success).toBe(false)
    expect(result.phase).toBe('ping')
    expect(result.error).toContain('timed out after 120 seconds')
    expect(result.error).not.toBe('Process exited with code null')
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
})
