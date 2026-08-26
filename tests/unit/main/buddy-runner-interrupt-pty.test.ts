import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Live node-pty spawn fails in this environment with `posix_spawnp failed`
 * (verified for /bin/echo, /bin/sh, and absolute fake binaries). This suite
 * mocks the PTY launcher to prove BuddyRunner still forwards AbortSignal on
 * the native OpenCode path. Pipe-based kill coverage lives in
 * buddy-runner-launcher.test.ts.
 */
vi.mock('../../../src/main/buddy/launchers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/buddy/launchers')>()
  return {
    ...actual,
    runLauncherWithPty: vi.fn()
  }
})

import { runLauncherWithPty } from '../../../src/main/buddy/launchers'
import { BuddyRunner } from '../../../src/main/buddy/runner'
import { BuddyStore } from '../../../src/main/buddy/store'

describe('BuddyRunner PTY interrupt signal pass-through', () => {
  beforeEach(() => {
    vi.mocked(runLauncherWithPty).mockReset()
  })

  it('forwards the run AbortSignal into runLauncherWithPty for native opencode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-pty-signal-'))
    let resolveExit: ((value: { exitCode: number | null; signal: string | null }) => void) | undefined
    const exitPromise = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
      resolveExit = resolve
    })

    vi.mocked(runLauncherWithPty).mockImplementation(async (input) => {
      expect(input.signal).toBeInstanceOf(AbortSignal)
      expect(input.signal?.aborted).toBe(false)
      input.signal!.addEventListener('abort', () => {
        resolveExit?.({ exitCode: null, signal: 'SIGTERM' })
      }, { once: true })
      return exitPromise
    })

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_rounds: 1 })
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: root,
      settings: {
        launchers: {
          opencode: { command: 'opencode', env: {}, timeout_seconds: 30 }
        }
      }
    })
    const runner = new BuddyRunner(store)

    const startPromise = runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'opencode'
    })

    await vi.waitFor(() => {
      expect(runLauncherWithPty).toHaveBeenCalled()
    })

    const signal = vi.mocked(runLauncherWithPty).mock.calls[0]?.[0]?.signal
    expect(signal).toBeInstanceOf(AbortSignal)

    await runner.interrupt('demo', created.workspace_key)
    await expect(startPromise).resolves.toMatchObject({
      run_id: expect.stringMatching(/^run_/)
    })
    expect(signal?.aborted).toBe(true)

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    expect(detail.state.status).toBe('PAUSED')
    expect(detail.state.active_run).toBeNull()
    expect(detail.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'actor.interrupted' })
    ]))
    expect(detail.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'actor.failed' }),
      expect.objectContaining({ type: 'actor.completed' })
    ]))
  }, 10_000)
})
