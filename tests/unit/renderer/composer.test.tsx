// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { Composer } from '../../../src/renderer/components/Composer'
import type { TaskSettings, TaskState } from '../../../src/shared/types'

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useT: () => (key: string) => key,
  useSendShortcut: () => ({ shortcut: 'cmd-enter', setShortcut: vi.fn() })
}))

type BuddyMocks = {
  listAcpModels?: ReturnType<typeof vi.fn>
  updateTaskLauncherModel?: ReturnType<typeof vi.fn>
}

function mockWindowBuddy(overrides: BuddyMocks = {}) {
  const buddy = {
    listAcpModels: vi.fn().mockResolvedValue({ models: [] }),
    updateTaskLauncherModel: vi.fn().mockResolvedValue({}),
    ...overrides
  }
  Object.defineProperty(window, 'buddy', { configurable: true, value: buddy })
  return buddy
}

function cliSettings(): TaskSettings {
  return {
    protocol_version: '1',
    flow_policy: 'claude_then_codex',
    role_mode: 'claude_implements',
    implementer_actor: 'claude',
    reviewer_actor: 'codex',
    launchers: {
      claude: { command: 'claude', env: {}, timeout_seconds: 7200 },
      codex: { command: 'codex', env: {}, timeout_seconds: 7200 }
    }
  }
}

function mixedSettings(claudeModel?: string): TaskSettings {
  return {
    protocol_version: '1',
    flow_policy: 'claude_then_codex',
    role_mode: 'claude_implements',
    implementer_actor: 'claude',
    reviewer_actor: 'codex',
    launchers: {
      claude: {
        protocol: 'acp',
        command: 'npx',
        args: ['-y', '@agentclientprotocol/claude-agent-acp'],
        env: {},
        timeout_seconds: 7200,
        ...(claudeModel ? { model: claudeModel } : {})
      },
      codex: { command: 'codex', env: {}, timeout_seconds: 7200 }
    }
  }
}

function readyState(nextActor = 'claude'): TaskState {
  return {
    status: 'READY',
    round: 1,
    next_actor: nextActor,
    active_run: null,
    updated_at: '2026-05-26T07:06:50.471Z',
    repo_root: '/tmp/repo',
    pending_break: null
  }
}

function renderComposer(
  overrides: Partial<React.ComponentProps<typeof Composer>> = {},
  buddyOverrides: BuddyMocks = {}
) {
  const buddy = mockWindowBuddy(buddyOverrides)
  const props: React.ComponentProps<typeof Composer> = {
    onSend: vi.fn(),
    onStart: vi.fn(),
    onInterrupt: vi.fn(),
    onEnqueueInstruction: vi.fn(),
    isRunning: false,
    isReady: true,
    settings: mixedSettings('sonnet-4.5'),
    taskState: readyState(),
    taskId: 'demo',
    workspaceKey: 'ws',
    draft: '',
    onDraftChange: vi.fn(),
    attachments: [],
    onAttachmentsChange: vi.fn(),
    ...overrides
  }
  render(<Composer {...props} />)
  return { buddy, ...props }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Composer ACP model picker', () => {
  it('hides the model dropdown for CLI next-round actors', () => {
    renderComposer({ settings: cliSettings() })
    expect(screen.getByLabelText('composer.nextHandoff')).toBeInTheDocument()
    expect(screen.queryByLabelText('modal.create.model')).not.toBeInTheDocument()
  })

  it('preselects the task launcher model and persists a change onto that task', async () => {
    const { buddy } = renderComposer(
      {},
      {
        listAcpModels: vi.fn().mockResolvedValue({
          models: [
            { id: 'opus-4.6', name: 'Opus 4.6' },
            { id: 'sonnet-4.5', name: 'Sonnet 4.5' }
          ],
          currentModelId: 'opus-4.6'
        })
      }
    )

    const modelSelect = await screen.findByLabelText('modal.create.model')
    await waitFor(() => {
      expect(modelSelect).toHaveValue('sonnet-4.5')
    })
    expect(buddy.listAcpModels).toHaveBeenCalledWith('claude', '/tmp/repo')

    fireEvent.change(modelSelect, { target: { value: 'opus-4.6' } })
    await waitFor(() => {
      expect(buddy.updateTaskLauncherModel).toHaveBeenCalledWith('demo', 'ws', 'claude', 'opus-4.6')
    })
  })

  it('falls back to the advertised current model when the launcher has none', async () => {
    renderComposer(
      { settings: mixedSettings() },
      {
        listAcpModels: vi.fn().mockResolvedValue({
          models: [
            { id: 'opus-4.6', name: 'Opus 4.6' },
            { id: 'sonnet-4.5', name: 'Sonnet 4.5' }
          ],
          currentModelId: 'sonnet-4.5'
        })
      }
    )

    const modelSelect = await screen.findByLabelText('modal.create.model')
    await waitFor(() => {
      expect(modelSelect).toHaveValue('sonnet-4.5')
    })
  })

  it('hides the model dropdown after switching to a CLI actor', async () => {
    renderComposer(
      {},
      {
        listAcpModels: vi.fn().mockResolvedValue({
          models: [{ id: 'sonnet-4.5', name: 'Sonnet 4.5' }],
          currentModelId: 'sonnet-4.5'
        })
      }
    )

    await screen.findByLabelText('modal.create.model')
    fireEvent.change(screen.getByLabelText('composer.nextHandoff'), {
      target: { value: 'codex' }
    })
    await waitFor(() => {
      expect(screen.queryByLabelText('modal.create.model')).not.toBeInTheDocument()
    })
  })

  it('shows unavailable when the ACP actor advertises no models', async () => {
    renderComposer(
      {},
      { listAcpModels: vi.fn().mockResolvedValue({ models: [] }) }
    )

    const modelSelect = await screen.findByLabelText('modal.create.model')
    await waitFor(() => {
      expect(modelSelect).toBeDisabled()
      expect(modelSelect).toHaveTextContent('modal.create.modelUnavailable')
    })
  })
})
