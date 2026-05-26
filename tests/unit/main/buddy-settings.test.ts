import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'

describe('BuddyStore settings and delete', () => {
  it('returns default CLI launchers when no global settings file exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-settings-default-'))
    const store = new BuddyStore(root)

    await expect(store.readGlobalSettings()).resolves.toMatchObject({
      protocol_version: '1',
      countdown_seconds: 30,
      max_rounds: 10,
      max_consecutive_failures: 3,
      launchers: {
        claude: { command: 'claude', env: {}, timeout_seconds: 7200 },
        codex: { command: 'codex', env: {}, timeout_seconds: 7200 }
      },
      seed_claude_session_id: '',
      seed_codex_thread_id: ''
    })
  })

  it('updates global settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-settings-'))
    const store = new BuddyStore(root)

    await store.updateGlobalSettings({ countdown_seconds: 45 })

    await expect(readFile(join(root, 'global', 'settings.json'), 'utf8')).resolves.toContain('"countdown_seconds": 45')
    await expect(store.readGlobalSettings()).resolves.toMatchObject({
      countdown_seconds: 45,
      launchers: {
        claude: expect.objectContaining({ command: 'claude' })
      }
    })
  })

  it('reads legacy root global settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-settings-legacy-'))
    const store = new BuddyStore(root)
    await writeFile(join(root, 'global_settings.json'), JSON.stringify({
      countdown_seconds: 10,
      launchers: {
        claude: {
          command: 'wecode --dangerously-skip-permissions',
          env: {},
          timeout_seconds: 7200
        }
      }
    }))

    await expect(store.readGlobalSettings()).resolves.toMatchObject({
      countdown_seconds: 10,
      launchers: {
        claude: expect.objectContaining({ command: 'wecode --dangerously-skip-permissions' })
      }
    })
  })

  it('deletes task directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-delete-'))
    const store = new BuddyStore(root)
    const created = await store.createTask({ task_id: 'demo', repo_root: '/tmp/repo' })

    await store.deleteTask('demo', created.workspace_key)

    await expect(access(created.path)).rejects.toThrow()
  })
})
