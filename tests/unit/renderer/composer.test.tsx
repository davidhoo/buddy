// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { Composer } from '../../../src/renderer/components/Composer'
import type { AcpModelList, TaskSettings, TaskState } from '../../../src/shared/types'

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useT: () => (key: string) => key,
  useSendShortcut: () => ({ shortcut: 'cmd-enter', setShortcut: vi.fn() })
}))

type BuddyMocks = {
  listAcpModels?: ReturnType<typeof vi.fn>
  listCliModels?: ReturnType<typeof vi.fn>
  updateTaskLauncherModel?: ReturnType<typeof vi.fn>
}

function mockWindowBuddy(overrides: BuddyMocks = {}) {
  const buddy = {
    listAcpModels: vi.fn().mockResolvedValue({ models: [] }),
    listCliModels: vi.fn().mockResolvedValue({ models: [] }),
    updateTaskLauncherModel: vi.fn().mockResolvedValue({}),
    ...overrides
  }
  Object.defineProperty(window, 'buddy', { configurable: true, value: buddy })
  return buddy
}

function cliSettings(claudeModel?: string): TaskSettings {
  return {
    protocol_version: '1',
    flow_policy: 'claude_then_codex',
    role_mode: 'claude_implements',
    implementer_actor: 'claude',
    reviewer_actor: 'codex',
    launchers: {
      claude: {
        command: 'claude',
        env: {},
        timeout_seconds: 7200,
        ...(claudeModel ? { model: claudeModel } : {})
      },
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
  const view = render(<Composer {...props} />)
  return {
    buddy,
    props,
    rerender: (next: Partial<React.ComponentProps<typeof Composer>> = {}) => {
      const merged = { ...props, ...next }
      Object.assign(props, merged)
      view.rerender(<Composer {...merged} />)
    }
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Composer model picker', () => {
  it('shows a loading option on the first paint before models resolve', async () => {
    let resolveModels!: (value: AcpModelList) => void
    renderComposer(
      { settings: cliSettings() },
      {
        listCliModels: vi.fn(() => new Promise<AcpModelList>(resolve => { resolveModels = resolve }))
      }
    )

    const modelSelect = screen.getByLabelText('modal.create.model')
    expect(modelSelect).toBeDisabled()
    expect(within(modelSelect).getByRole('option', { name: 'common.loading' })).toBeInTheDocument()

    await act(async () => {
      resolveModels({
        models: [{ id: 'sonnet', name: 'Sonnet' }],
        currentModelId: 'sonnet'
      })
    })

    await waitFor(() => {
      expect(modelSelect).not.toBeDisabled()
      expect(modelSelect).toHaveValue('')
      expect(within(modelSelect).getByRole('option', { name: 'agents.native' })).toBeInTheDocument()
    })
  })

  it('loads CLI models for CLI next-round actors without inventing a selection', async () => {
    const { buddy } = renderComposer(
      { settings: cliSettings() },
      {
        listCliModels: vi.fn().mockResolvedValue({
          models: [
            { id: 'sonnet', name: 'Sonnet' },
            { id: 'opus', name: 'Opus' }
          ],
          currentModelId: 'sonnet'
        })
      }
    )

    const modelSelect = await screen.findByLabelText('modal.create.model')
    await waitFor(() => {
      expect(modelSelect).toHaveValue('')
      expect(within(modelSelect).getByRole('option', { name: 'agents.native' })).toBeInTheDocument()
      expect(within(modelSelect).getByRole('option', { name: 'Sonnet' })).toBeInTheDocument()
    })
    expect(buddy.listCliModels).toHaveBeenCalledWith('claude')
    expect(buddy.listAcpModels).not.toHaveBeenCalled()
  })

  it('shows agent default when the CLI actor has no model list', async () => {
    renderComposer(
      { settings: cliSettings() },
      { listCliModels: vi.fn().mockResolvedValue({ models: [] }) }
    )

    const modelSelect = await screen.findByLabelText('modal.create.model')
    await waitFor(() => {
      expect(modelSelect).toBeDisabled()
      expect(modelSelect).toHaveTextContent('agents.native')
    })
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

  it('keeps agent default when the launcher has no model even if the probe advertises a current one', async () => {
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
      expect(modelSelect).toHaveValue('')
      expect(within(modelSelect).getByRole('option', { name: 'agents.native' })).toBeInTheDocument()
    })
  })

  it('persists clearing the model back to agent default', async () => {
    const { buddy } = renderComposer(
      {},
      {
        listAcpModels: vi.fn().mockResolvedValue({
          models: [
            { id: 'opus-4.6', name: 'Opus 4.6' },
            { id: 'sonnet-4.5', name: 'Sonnet 4.5' }
          ]
        })
      }
    )

    const modelSelect = await screen.findByLabelText('modal.create.model')
    await waitFor(() => {
      expect(modelSelect).toHaveValue('sonnet-4.5')
    })

    fireEvent.change(modelSelect, { target: { value: '' } })
    await waitFor(() => {
      expect(buddy.updateTaskLauncherModel).toHaveBeenCalledWith('demo', 'ws', 'claude', '')
      expect(modelSelect).toHaveValue('')
    })
  })

  it('switches from ACP models to CLI models when the next actor changes', async () => {
    const { buddy } = renderComposer(
      {},
      {
        listAcpModels: vi.fn().mockResolvedValue({
          models: [{ id: 'sonnet-4.5', name: 'Sonnet 4.5' }],
          currentModelId: 'sonnet-4.5'
        }),
        listCliModels: vi.fn().mockResolvedValue({
          models: [{ id: 'gpt-5', name: 'GPT-5' }],
          currentModelId: 'gpt-5'
        })
      }
    )

    await screen.findByLabelText('modal.create.model')
    fireEvent.change(screen.getByLabelText('composer.nextHandoff'), {
      target: { value: 'codex' }
    })
    await waitFor(() => {
      expect(buddy.listCliModels).toHaveBeenCalledWith('codex')
      expect(screen.getByLabelText('modal.create.model')).toHaveValue('')
      expect(within(screen.getByLabelText('modal.create.model')).getByRole('option', { name: 'GPT-5' })).toBeInTheDocument()
    })
  })

  it('shows agent default when the ACP actor advertises no models', async () => {
    renderComposer(
      {},
      { listAcpModels: vi.fn().mockResolvedValue({ models: [] }) }
    )

    const modelSelect = await screen.findByLabelText('modal.create.model')
    await waitFor(() => {
      expect(modelSelect).toBeDisabled()
      expect(modelSelect).toHaveTextContent('agents.native')
    })
  })

  it('keeps the previous catalog visible while a same-actor refresh is in flight', async () => {
    let resolveRefresh!: (value: AcpModelList) => void
    const listAcpModels = vi.fn()
      .mockResolvedValueOnce({
        models: [
          { id: 'sonnet-4.5', name: 'Sonnet 4.5' },
          { id: 'opus-4.6', name: 'Opus 4.6' }
        ],
        currentModelId: 'sonnet-4.5'
      })
      .mockImplementationOnce(() => new Promise<AcpModelList>(resolve => { resolveRefresh = resolve }))

    const { props, rerender } = renderComposer({}, { listAcpModels })
    const modelSelect = await screen.findByLabelText('modal.create.model')
    await waitFor(() => {
      expect(modelSelect).toHaveValue('sonnet-4.5')
    })

    rerender({ taskState: { ...props.taskState!, repo_root: '/tmp/repo-refetch' } })

    expect(modelSelect).toHaveValue('sonnet-4.5')
    expect(within(modelSelect).getByRole('option', { name: 'Sonnet 4.5' })).toBeInTheDocument()
    expect(within(modelSelect).queryByRole('option', { name: 'common.loading' })).not.toBeInTheDocument()

    await act(async () => {
      resolveRefresh({
        models: [
          { id: 'opus-4.6', name: 'Opus 4.6' },
          { id: 'haiku', name: 'Haiku' }
        ],
        currentModelId: 'opus-4.6'
      })
    })

    await waitFor(() => {
      expect(within(modelSelect).getByRole('option', { name: 'Haiku' })).toBeInTheDocument()
      expect(within(modelSelect).queryByRole('option', { name: 'Sonnet 4.5' })).not.toBeInTheDocument()
      expect(modelSelect).toHaveValue('sonnet-4.5')
    })
  })

  it('replaces the catalog with agent default when a refresh returns a successful empty list', async () => {
    const listAcpModels = vi.fn()
      .mockResolvedValueOnce({
        models: [{ id: 'sonnet-4.5', name: 'Sonnet 4.5' }],
        currentModelId: 'sonnet-4.5'
      })
      .mockResolvedValueOnce({ models: [] })

    const { props, rerender } = renderComposer({}, { listAcpModels })
    const modelSelect = await screen.findByLabelText('modal.create.model')
    await waitFor(() => {
      expect(modelSelect).toHaveValue('sonnet-4.5')
    })

    rerender({ taskState: { ...props.taskState!, repo_root: '/tmp/repo-empty' } })

    await waitFor(() => {
      expect(listAcpModels).toHaveBeenCalledTimes(2)
      expect(modelSelect).toBeDisabled()
      expect(modelSelect).toHaveTextContent('agents.native')
    })
  })

  it('keeps the previous catalog when a refresh fails with an error payload', async () => {
    const listAcpModels = vi.fn()
      .mockResolvedValueOnce({
        models: [{ id: 'sonnet-4.5', name: 'Sonnet 4.5' }],
        currentModelId: 'sonnet-4.5'
      })
      .mockResolvedValueOnce({ models: [], error: 'probe failed' })

    const { props, rerender } = renderComposer({}, { listAcpModels })
    const modelSelect = await screen.findByLabelText('modal.create.model')
    await waitFor(() => {
      expect(modelSelect).toHaveValue('sonnet-4.5')
    })

    rerender({ taskState: { ...props.taskState!, repo_root: '/tmp/repo-error' } })

    await waitFor(() => {
      expect(listAcpModels).toHaveBeenCalledTimes(2)
    })
    expect(modelSelect).toHaveValue('sonnet-4.5')
    expect(within(modelSelect).getByRole('option', { name: 'Sonnet 4.5' })).toBeInTheDocument()
  })

  it('persists a CLI model selection onto the task launcher', async () => {
    const { buddy } = renderComposer(
      { settings: cliSettings('sonnet') },
      {
        listCliModels: vi.fn().mockResolvedValue({
          models: [
            { id: 'sonnet', name: 'Sonnet' },
            { id: 'opus', name: 'Opus' }
          ]
        })
      }
    )

    const modelSelect = await screen.findByLabelText('modal.create.model')
    await waitFor(() => {
      expect(modelSelect).toHaveValue('sonnet')
    })
    fireEvent.change(modelSelect, { target: { value: 'opus' } })
    await waitFor(() => {
      expect(buddy.updateTaskLauncherModel).toHaveBeenCalledWith('demo', 'ws', 'claude', 'opus')
    })
  })
})
