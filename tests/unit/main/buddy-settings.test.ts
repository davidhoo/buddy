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
      max_rounds: 9999,
      max_consecutive_failures: 10,
      launchers: {
        claude: { command: 'claude', env: {}, timeout_seconds: 7200 },
        codex: { command: 'codex', env: {}, timeout_seconds: 7200 },
        'cursor-agent': {
          command: 'agent',
          backend: 'cursor',
          display_name: 'Cursor Agent',
          timeout_seconds: 7200
        }
      },
      seed_claude_session_id: '',
      seed_codex_thread_id: ''
    })
  })

  it('persists multiple independent Cursor Agent profiles and prompt presets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-settings-cursor-'))
    const store = new BuddyStore(root)

    await store.updateGlobalSettings({
      launchers: {
        'cursor-agent': {
          command: 'agent',
          env: {},
          timeout_seconds: 1200,
          backend: 'cursor',
          model: 'composer-2.5',
          prompt_preset_id: 'implement'
        },
        'cursor-agent-2': {
          command: 'cursor-agent',
          env: {},
          timeout_seconds: 1800,
          backend: 'cursor',
          model: 'gpt-5.6-sol-high'
        }
      },
      prompt_presets: [{ id: 'implement', name: 'Implement', prompt: 'Implement and test.' }]
    })

    const settings = await store.readGlobalSettings()
    expect(settings.launchers?.['cursor-agent'].model).toBe('composer-2.5')
    expect(settings.launchers?.['cursor-agent-2'].model).toBe('gpt-5.6-sol-high')
    expect(settings.prompt_presets).toEqual([
      { id: 'implement', name: 'Implement', prompt: 'Implement and test.' }
    ])

    const created = await store.createTask({ task_id: 'cursor-task', repo_root: root })
    await store.updateGlobalSettings({
      ...settings,
      prompt_presets: [{ id: 'implement', name: 'Implement', prompt: 'Changed later.' }]
    })
    const detail = await store.getTaskDetail('cursor-task', created.workspace_key)
    expect(detail.settings.prompt_presets).toEqual([
      { id: 'implement', name: 'Implement', prompt: 'Implement and test.' }
    ])
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
