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

  it('detects an upgrade exit reported on stdout (wecode prints progress to stdout)', { timeout: 30000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-upgrade-stdout-'))
    const fake = join(root, 'fake-upgrade-stdout.js')
    // wecode writes the upgrade banner/progress to STDOUT (not stderr); extractActorOutput
    // filters it out of outputText, so the runtime path must consult raw stdout to detect it.
    await writeFile(fake, `
process.stdout.write('A new version is available. Upgrade complete, restart required.\\n');
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
      claude_session_id: 'upgrade-stdout-session'
    }))

    const runner = new BuddyRunner(store)

    await expect(runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'claude'
    })).rejects.toThrow()

    const detail = await store.getTaskDetail('demo', created.workspace_key)

    const upgradeEvents = detail.events.filter((e) => e.type === 'actor.upgrade_detected')
    expect(upgradeEvents.length).toBeGreaterThanOrEqual(1)
    expect(detail.state.status).toBe('FAILED')
  })
})

describe('BuddyRunner health-check upgrade auto-retry', () => {
  // wecode-cli-cc (and similar CLIs) exit on first launch to auto-upgrade, then expect a
  // relaunch. A connectivity ping that hits this used to fail the health check outright.
  // The ping path now detects the upgrade exit and retries, mirroring executeActorInner.
  it('retries a connectivity ping that exits to auto-upgrade, then fails after max retries', { timeout: 30000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-ping-upgrade-'))
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
        role_mode: 'claude_implements',
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5, display_name: 'Primary Reviewer' },
          codex: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5, display_name: 'Secondary Reviewer' }
        }
      }
    })

    const runner = new BuddyRunner(store)
    await expect(runner.startTask('demo', { workspace_key: created.workspace_key }))
      .rejects.toThrow(/Primary Reviewer/)

    const detail = await store.getTaskDetail('demo', created.workspace_key)

    const retryEvents = detail.events.filter((e) => e.type === 'health_check.actor_upgrade_retry')
    expect(retryEvents.length).toBeGreaterThanOrEqual(1)
    expect(retryEvents[0]?.payload.retry_attempt).toBe(1)

    const retryTranscript = detail.transcript.find(
      (t) => t.meta?.kind === 'health_check_upgrade_retry' && t.meta?.actor === 'claude'
    )
    expect(retryTranscript).toBeDefined()
    expect(retryTranscript?.content).toContain('Primary Reviewer')

    expect(detail.state.status).toBe('FAILED')
    expect(detail.state.health_check?.failed_actor).toBeTruthy()
    expect(detail.state.latest_failure?.message).toContain('Primary Reviewer')
  })

  it('recovers the health check when an auto-upgrading CLI succeeds on retry', { timeout: 30000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-ping-upgrade-ok-'))
    const fake = join(root, 'fake-upgrade-once.js')
    // First invocation: exit to auto-upgrade. Subsequent invocations: emit a valid buddy
    // message plus a claude init session line so the ping captures a session id.
    await writeFile(fake, `
const fs = require('fs');
const path = require('path');
const actor = process.env.BUDDY_ACTOR || 'default';
const dir = process.env.BUDDY_COUNTER_DIR;
const counterFile = dir ? path.join(dir, 'ping-' + actor + '.cnt') : null;
let n = 0;
if (counterFile) {
  try { n = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; } catch {}
  n += 1;
  fs.writeFileSync(counterFile, String(n));
}
if (n <= 1) {
  process.stderr.write('A new version is available. Upgrade complete, restart required.\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-' + actor }) + '\\n');
const out = process.env.BUDDY_OUTPUT_FILE;
if (out) fs.writeFileSync(out, JSON.stringify({ type: 'chat', content: 'ready' }));
process.exit(0);
`)

    const store = new BuddyStore(root)
    // max_rounds: 1 stops the buddy loop after the first actor round so the test
    // terminates (the fake always responds with a chat message and never breaks).
    await store.updateGlobalSettings({ max_upgrade_retries: 2, max_compact_retries: 0, max_rounds: 1 })
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      settings: {
        role_mode: 'claude_implements',
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: { BUDDY_COUNTER_DIR: root }, timeout_seconds: 5 },
          codex: { command: `${process.execPath} ${fake}`, env: { BUDDY_COUNTER_DIR: root }, timeout_seconds: 5 }
        }
      }
    })

    const runner = new BuddyRunner(store)
    await runner.startTask('demo', { workspace_key: created.workspace_key })

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    const retryEvents = detail.events.filter((e) => e.type === 'health_check.actor_upgrade_retry')
    expect(retryEvents.length).toBeGreaterThanOrEqual(1)
    const passedEvents = detail.events.filter((e) => e.type === 'health_check.passed')
    expect(passedEvents.length).toBe(1)
    expect(detail.state.health_check).toBeNull()
    expect(detail.state.claude_session_id).toBe('sid-claude')
  })
})
