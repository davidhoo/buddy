import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuddyRunner, isUpgradeExitError } from '../../../src/main/buddy/runner'
import { BuddyStore } from '../../../src/main/buddy/store'

describe('isUpgradeExitError', () => {
  it('detects English upgrade messages', () => {
    expect(isUpgradeExitError('A new version is available. Update complete, please restart.')).toBe(true)
    expect(isUpgradeExitError('Upgrade complete, restarting...')).toBe(true)
    expect(isUpgradeExitError('Auto-update in progress')).toBe(true)
    expect(isUpgradeExitError('Updated to v2.0.0, restart required')).toBe(true)
  })

  it('detects Chinese upgrade messages', () => {
    expect(isUpgradeExitError('检测到新版本，自动更新中...')).toBe(true)
    expect(isUpgradeExitError('自动升级完成，请重启')).toBe(true)
    expect(isUpgradeExitError('已更新到最新版本')).toBe(true)
    expect(isUpgradeExitError('升级完成')).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isUpgradeExitError('Connection refused')).toBe(false)
    expect(isUpgradeExitError('Permission denied')).toBe(false)
    expect(isUpgradeExitError('Actor exited with code 1')).toBe(false)
    expect(isUpgradeExitError('Command not found')).toBe(false)
    expect(isUpgradeExitError('')).toBe(false)
  })
})

describe('BuddyRunner upgrade auto-retry', () => {
  it('detects upgrade exit and retries, then fails after max retries', { timeout: 30000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-upgrade-'))
    const fake = join(root, 'fake-upgrade.js')
    await writeFile(fake, `
process.stderr.write('A new version is available. Upgrade complete, restart required.\\n');
process.exit(1);
`)

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_upgrade_retries: 1, max_compact_retries: 0 })
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    await store.updateTaskState('demo', created.workspace_key, (state) => ({
      ...state,
      claude_session_id: 'upgrade-test-session'
    }))

    const runner = new BuddyRunner(store)

    await expect(runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'claude'
    })).rejects.toThrow()

    const detail = await store.getTaskDetail('demo', created.workspace_key)

    const upgradeEvents = detail.events.filter((e) => e.type === 'actor.upgrade_detected')
    expect(upgradeEvents.length).toBeGreaterThanOrEqual(1)
    expect(upgradeEvents[0]?.payload.retry_attempt).toBe(1)

    const upgradeTranscript = detail.transcript.find((t) => t.meta?.kind === 'upgrade_retry')
    expect(upgradeTranscript).toBeDefined()
    expect(upgradeTranscript?.content).toContain('自动升级')

    expect(detail.state.status).toBe('FAILED')
  })

  it('does not retry when max_upgrade_retries is 0', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-upgrade-disabled-'))
    const fake = join(root, 'fake-upgrade.js')
    await writeFile(fake, `
process.stderr.write('A new version is available. Upgrade complete.\\n');
process.exit(1);
`)

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_upgrade_retries: 0, max_compact_retries: 0 })
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    await store.updateTaskState('demo', created.workspace_key, (state) => ({
      ...state,
      claude_session_id: 'upgrade-test-session-2'
    }))

    const runner = new BuddyRunner(store)

    await expect(runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'claude'
    })).rejects.toThrow()

    const detail = await store.getTaskDetail('demo', created.workspace_key)

    const upgradeEvents = detail.events.filter((e) => e.type === 'actor.upgrade_detected')
    expect(upgradeEvents.length).toBe(0)
    expect(detail.state.status).toBe('FAILED')
  })

  it('does not treat non-upgrade errors as upgrade exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-upgrade-non-'))
    const fake = join(root, 'fake-normal-error.js')
    await writeFile(fake, `
process.stderr.write('Some random runtime error\\n');
process.exit(1);
`)

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_upgrade_retries: 3, max_compact_retries: 0 })
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    await store.updateTaskState('demo', created.workspace_key, (state) => ({
      ...state,
      claude_session_id: 'normal-error-session'
    }))

    const runner = new BuddyRunner(store)

    await expect(runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'claude'
    })).rejects.toThrow()

    const detail = await store.getTaskDetail('demo', created.workspace_key)

    const upgradeEvents = detail.events.filter((e) => e.type === 'actor.upgrade_detected')
    expect(upgradeEvents.length).toBe(0)
    expect(detail.state.status).toBe('FAILED')
  })
})
