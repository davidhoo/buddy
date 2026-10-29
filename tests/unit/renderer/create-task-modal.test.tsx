// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { CreateTaskModal } from '../../../src/renderer/App'
import type { TFunction } from '../../../src/renderer/hooks/useI18n'
import { modelMemoryKey } from '../../../src/renderer/lib/agent-memory'
import type { AcpModelList, GlobalSettings } from '../../../src/shared/types'

// A `t` that returns the translation key verbatim. Tests assert on these keys
// so they stay coupled to the i18n contract, not to any locale's wording.
const t = ((key: string) => key) as unknown as TFunction

vi.mock('../../../src/renderer/hooks/useBuddy', () => ({
  useGitStatus: () => ({ data: null, isLoading: false })
}))

vi.mock('../../../src/renderer/components/BranchModal', () => ({
  BranchModal: () => null
}))

type CreateTaskModalProps = Parameters<typeof CreateTaskModal>[0]

type BuddyMocks = {
  detectActorModels?: ReturnType<typeof vi.fn>
  listAcpModels?: ReturnType<typeof vi.fn>
  listCliModels?: ReturnType<typeof vi.fn>
  listLocalAgents?: ReturnType<typeof vi.fn>
}

function mockWindowApi(buddyOverrides: BuddyMocks = {}) {
  const api = {
    selectDirectory: vi.fn().mockResolvedValue(null),
    readClipboardFilePaths: vi.fn().mockResolvedValue([]),
    readFileAsDataURL: vi.fn().mockResolvedValue('')
  }
  const buddy = {
    detectActorModels: vi.fn().mockResolvedValue({}),
    listAcpModels: vi.fn().mockResolvedValue({ models: [] }),
    ...buddyOverrides
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  Object.defineProperty(window, 'buddy', { configurable: true, value: buddy })
  return { api, buddy }
}

function renderModal(
  overrides: Partial<CreateTaskModalProps> = {},
  buddyOverrides: BuddyMocks = {}
) {
  const onCreate = vi.fn()
  mockWindowApi(buddyOverrides)
  const props: CreateTaskModalProps = {
    onClose: vi.fn(),
    onCreate,
    defaultRepoRoot: '/tmp/repo',
    globalSettings: null,
    t,
    ...overrides
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><CreateTaskModal {...props} /></QueryClientProvider>)
  const rerender = (next: Partial<CreateTaskModalProps>) => view.rerender(
    <QueryClientProvider client={client}><CreateTaskModal {...props} {...next} /></QueryClientProvider>
  )
  return { ...props, rerender }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CreateTaskModal execution mode', () => {
  beforeEach(() => {
    // jsdom in this project exposes no localStorage by default; stub a minimal
    // in-memory store so the component's read/write of recent actor prefs works.
    const store = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => store.set(key, value)),
        removeItem: vi.fn((key: string) => store.delete(key)),
        clear: vi.fn(() => store.clear())
      }
    })
  })

  it('defaults to immediate execution with the switch in the footer', () => {
    renderModal()

    const toggle = screen.getByRole('switch', {
      name: 'modal.create.executionMode.immediate'
    })
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    // The switch lives in the same footer row as the cancel / submit buttons.
    // Walk up from the cancel button to the border-t footer row that contains
    // both the left (switch) and right (actions) groups — asserting on the row
    // rather than on the immediate parent, which is just the right-side group.
    let footer: HTMLElement = screen.getByText('common.cancel')
    while (footer.parentElement && !footer.className.includes('border-t')) {
      footer = footer.parentElement
    }
    expect(footer).toContainElement(toggle)
    expect(footer).toContainElement(screen.getByText('modal.create.submit'))

    // The old execution mode block (title, two buttons, hint paragraph) is gone.
    // The only switch-named control is the footer toggle; see the next test.
  })

  it('does not render the old two-button execution mode selector', () => {
    renderModal()
    // No buttons whose labels are the bare execution mode names (the old
    // segmented control used the same text as switch labels, so the switch
    // itself is the only switch-named control).
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(1)
  })

  it('submits with queued after toggling the switch off', () => {
    const { onCreate } = renderModal()

    // Enter a valid task name so canSubmit becomes true.
    fireEvent.change(screen.getByPlaceholderText('modal.create.taskNamePlaceholder'), {
      target: { value: 'ui-layout' }
    })

    // Toggle the switch off.
    const toggle = screen.getByRole('switch', {
      name: 'modal.create.executionMode.immediate'
    })
    fireEvent.click(toggle)

    // Accessible name now reflects the queued label and state is unchecked.
    expect(
      screen.getByRole('switch', { name: 'modal.create.executionMode.queued' })
    ).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(screen.getByRole('button', { name: /modal.create.submit/ }))

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith(
      'ui-layout',
      expect.any(String),
      '/tmp/repo',
      expect.any(Object),
      undefined,
      'queued'
    )
  })

  it('submits with immediate by default', () => {
    const { onCreate } = renderModal()

    fireEvent.change(screen.getByPlaceholderText('modal.create.taskNamePlaceholder'), {
      target: { value: 'ui-layout' }
    })

    fireEvent.click(screen.getByRole('button', { name: /modal.create.submit/ }))

    expect(onCreate).toHaveBeenCalledTimes(1)
    const args = onCreate.mock.calls[0]
    expect(args[args.length - 1]).toBe('immediate')
  })
})

describe('CreateTaskModal task ID validation', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => store.set(key, value)),
        removeItem: vi.fn((key: string) => store.delete(key)),
        clear: vi.fn(() => store.clear())
      }
    })
  })

  it('accepts broad Unicode punctuation and passes the trimmed ID to onCreate', () => {
    const { onCreate } = renderModal()
    const input = 'feat: “任务名称” (v2) [macOS + Linux] #42 🚀'

    fireEvent.change(screen.getByPlaceholderText('modal.create.taskNamePlaceholder'), {
      target: { value: `  ${input}  ` }
    })

    const submit = screen.getByRole('button', { name: /modal.create.submit/ })
    expect(submit).not.toBeDisabled()

    fireEvent.click(submit)
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0][0]).toBe(input)
  })

  it.each([
    ['path separator', 'a/b'],
    ['dot segment', '.'],
    ['overlong (65 emoji)', '🚀'.repeat(65)]
  ])('disables submission and shows the error for an unsafe ID (%s)', (_label, unsafeId) => {
    renderModal()

    fireEvent.change(screen.getByPlaceholderText('modal.create.taskNamePlaceholder'), {
      target: { value: unsafeId }
    })

    expect(screen.getByText('modal.create.taskNameError')).toBeInTheDocument()
    // The submit button is gated by canSubmit; when invalid it is disabled.
    expect(screen.getByRole('button', { name: /modal.create.submit/ })).toBeDisabled()
  })

  it('counts Unicode code points, not UTF-16 units, in the counter', () => {
    renderModal()
    const input = screen.getByPlaceholderText('modal.create.taskNamePlaceholder') as HTMLInputElement

    // 3 emoji = 3 code points, 6 UTF-16 units. Counter must read 3/64.
    fireEvent.change(input, { target: { value: '🚀🚀🚀' } })
    expect(screen.getByText('3/64')).toBeInTheDocument()
  })
})

describe('CreateTaskModal task brief layout', () => {
  it('renders the brief textarea at rows=9 with min-h-[176px] instead of the old fixed height', () => {
    renderModal()

    // The brief is the only textarea in the modal.
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    expect(textarea).toHaveAttribute('rows', '9')
    expect(textarea.className).toContain('min-h-[176px]')
    expect(textarea.className).not.toContain('h-[160px]')
  })

  it('exposes the localized paste hint next to the task-brief label', () => {
    renderModal()

    // The label and the hint sit in the same flex row.
    const label = screen.getByText('modal.create.taskBrief')
    const hint = screen.getByText('modal.create.taskBriefPasteHint')
    const row = label.parentElement
    expect(row).toContainElement(hint)
  })
})

describe('CreateTaskModal actor models', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => store.set(key, value)),
        removeItem: vi.fn((key: string) => store.delete(key)),
        clear: vi.fn(() => store.clear())
      }
    })
  })

  it('uses separate agent and model dropdowns for CLI and snapshots both selected models', async () => {
    const detectActorModels = vi.fn()
    const listCliModels = vi.fn(async (actor: string) => ({
      models: actor === 'claude'
        ? [{ id: 'sonnet-4.5', name: 'Sonnet 4.5' }]
        : [{ id: 'gpt-5.6', name: 'GPT 5.6' }]
    }))
    const { onCreate } = renderModal({}, { detectActorModels, listCliModels })

    expect(screen.getAllByRole('combobox')).toHaveLength(4)
    const agentSelect = screen.getByRole('combobox', { name: 'modal.create.implementer modal.create.agent' })
    expect(within(agentSelect).getByRole('option', { name: 'actor.claude' })).toBeInTheDocument()
    expect(within(agentSelect).queryByRole('option', { name: /sonnet/ })).not.toBeInTheDocument()
    expect(detectActorModels).not.toHaveBeenCalled()

    const implementerModel = screen.getByRole('combobox', { name: 'modal.create.implementer modal.create.model' })
    const reviewerModel = screen.getByRole('combobox', { name: 'modal.create.reviewer modal.create.model' })
    await within(implementerModel).findByRole('option', { name: 'Sonnet 4.5' })
    await within(reviewerModel).findByRole('option', { name: 'GPT 5.6' })
    fireEvent.change(implementerModel, { target: { value: 'sonnet-4.5' } })
    fireEvent.change(reviewerModel, { target: { value: 'gpt-5.6' } })
    fireEvent.change(screen.getByPlaceholderText('modal.create.taskNamePlaceholder'), {
      target: { value: 'cli-models' }
    })
    fireEvent.click(screen.getByRole('button', { name: /modal.create.submit/ }))
    expect(onCreate.mock.calls[0][3].launchers).toMatchObject({
      claude: { model: 'sonnet-4.5' }, codex: { model: 'gpt-5.6' }
    })
  })

  it('shows an ACP model picker and snapshots the selected model onto the launcher', async () => {
    const { onCreate } = renderModal(
      {
        globalSettings: {
          launchers: {
            claude: {
              protocol: 'acp',
              command: 'npx',
              args: ['-y', '@agentclientprotocol/claude-agent-acp'],
              env: {},
              timeout_seconds: 7200
            },
            codex: {
              command: 'codex',
              env: {},
              timeout_seconds: 7200
            }
          }
        }
      },
      {
        listAcpModels: vi.fn().mockImplementation(async (actor: string) => {
          if (actor !== 'claude') return { models: [] }
          return {
            models: [
              { id: 'opus-4.6', name: 'Opus 4.6' },
              { id: 'sonnet-4.5', name: 'Sonnet 4.5' }
            ],
            currentModelId: 'sonnet-4.5'
          }
        })
      }
    )

    const modelSelect = await screen.findByLabelText('modal.create.implementer modal.create.model')
    await within(modelSelect).findByRole('option', { name: 'Opus 4.6' })
    expect(modelSelect).toHaveValue('__native__')
    expect(screen.getAllByRole('option', { name: 'actor.claude' }).length).toBeGreaterThan(0)
    expect(screen.queryAllByRole('option', { name: /actor.claude \(/ })).toHaveLength(0)

    fireEvent.change(modelSelect, { target: { value: 'opus-4.6' } })
    fireEvent.change(screen.getByPlaceholderText('modal.create.taskNamePlaceholder'), {
      target: { value: 'acp-model' }
    })
    fireEvent.click(screen.getByRole('button', { name: /modal.create.submit/ }))

    expect(onCreate).toHaveBeenCalledTimes(1)
    const settings = onCreate.mock.calls[0][3] as {
      launchers: Record<string, { model?: string; protocol?: string }>
    }
    expect(settings.launchers.claude.model).toBe('opus-4.6')
    expect(settings.launchers.claude.protocol).toBe('acp')
    expect(settings.launchers.codex.model).toBeUndefined()
  })

  it('keeps role-specific model history when both roles temporarily select the same agent', async () => {
    const settings = {}
    localStorage.setItem(modelMemoryKey('implementer', 'codex', settings), 'implementer-codex')
    localStorage.setItem(modelMemoryKey('reviewer', 'opencode', settings), 'reviewer-opencode')
    renderModal()
    fireEvent.change(screen.getByRole('combobox', { name: 'modal.create.implementer modal.create.agent' }), { target: { value: 'codex' } })
    expect(screen.getByText('modal.create.sameActorError')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'modal.create.reviewer modal.create.agent' }), { target: { value: 'opencode' } })
    expect(screen.queryByText('modal.create.sameActorError')).not.toBeInTheDocument()
    expect(screen.getByLabelText('modal.create.implementer modal.create.model')).toHaveValue('implementer-codex')
    expect(screen.getByLabelText('modal.create.reviewer modal.create.model')).toHaveValue('reviewer-opencode')
  })

  it('keeps the native default selectable when model discovery fails or returns no models', async () => {
    const globalSettings = { launchers: { claude: { command: 'claude', env: {}, timeout_seconds: 7200, model: 'saved-custom-model' } } }
    const { onCreate } = renderModal({ globalSettings }, {
      listCliModels: vi.fn(async (actor: string) => {
        if (actor === 'claude') throw new Error('discovery failed')
        return { models: [] }
      })
    })
    const model = screen.getByLabelText('modal.create.implementer modal.create.model')
    await within(model).findByRole('option', { name: 'modal.create.modelLoadFailed' })
    expect(model).toHaveValue('saved-custom-model')
    expect(model).not.toBeDisabled()
    const reviewerModel = screen.getByLabelText('modal.create.reviewer modal.create.model')
    await within(reviewerModel).findByRole('option', { name: 'modal.create.modelUnavailable' })
    expect(reviewerModel).toHaveValue('__native__')
    expect(reviewerModel).not.toBeDisabled()
    fireEvent.change(model, { target: { value: '__native__' } })
    fireEvent.change(screen.getByPlaceholderText('modal.create.taskNamePlaceholder'), { target: { value: 'native-default' } })
    fireEvent.click(screen.getByRole('button', { name: /modal.create.submit/ }))
    expect(onCreate.mock.calls[0][3].launchers.claude.model).toBeUndefined()
  })

  it('ignores a late model response after switching agents and uses the new agent protocol', async () => {
    let resolveOld!: (value: AcpModelList) => void
    const listCliModels = vi.fn((actor: string) => actor === 'claude'
      ? new Promise<AcpModelList>(resolve => { resolveOld = resolve })
      : Promise.resolve({ models: [] }))
    const listAcpModels = vi.fn().mockResolvedValue({ models: [{ id: 'new-model', name: 'New model' }] })
    renderModal({ globalSettings: { launchers: { opencode: { protocol: 'acp', command: 'opencode', args: ['acp'], env: {}, timeout_seconds: 7200 } } } }, { listCliModels, listAcpModels })
    fireEvent.change(screen.getByRole('combobox', { name: 'modal.create.implementer modal.create.agent' }), { target: { value: 'opencode' } })
    const model = screen.getByLabelText('modal.create.implementer modal.create.model')
    await within(model).findByRole('option', { name: 'New model' })
    fireEvent.change(model, { target: { value: 'new-model' } })
    await act(async () => { resolveOld({ models: [{ id: 'old-model', name: 'Old model' }] }) })
    expect(model).toHaveValue('new-model')
    expect(within(model).queryByRole('option', { name: 'Old model' })).not.toBeInTheDocument()
    expect(listAcpModels).toHaveBeenCalledWith('opencode')
    expect(listCliModels).not.toHaveBeenCalledWith('opencode')
  })

  it('reloads models when the same agent switches between CLI and ACP', async () => {
    const listCliModels = vi.fn().mockResolvedValue({ models: [{ id: 'cli-model', name: 'CLI model' }] })
    const listAcpModels = vi.fn().mockResolvedValue({ models: [{ id: 'acp-model', name: 'ACP model' }] })
    const globalSettings: GlobalSettings = { launchers: { claude: { command: 'claude', env: {}, timeout_seconds: 7200 } } }
    const { rerender } = renderModal({ globalSettings }, { listCliModels, listAcpModels })
    const model = screen.getByLabelText('modal.create.implementer modal.create.model')
    await within(model).findByRole('option', { name: 'CLI model' })
    rerender({ globalSettings: { launchers: { claude: { ...globalSettings.launchers!.claude, protocol: 'acp', command: 'claude-agent-acp' } } } })
    await within(model).findByRole('option', { name: 'ACP model' })
    expect(within(model).queryByRole('option', { name: 'CLI model' })).not.toBeInTheDocument()
    expect(listAcpModels).toHaveBeenCalledWith('claude')
  })

  it('requires replacing an unavailable remembered ACP model and allows the native default', async () => {
    const globalSettings: GlobalSettings = { launchers: { claude: { command: 'claude-agent-acp', protocol: 'acp', env: {}, timeout_seconds: 7200, model: 'removed-model' } } }
    renderModal({ globalSettings }, { listAcpModels: vi.fn().mockResolvedValue({ models: [{ id: 'available-model', name: 'Available model' }] }) })
    const model = screen.getByLabelText('modal.create.implementer modal.create.model')
    await within(model).findByRole('option', { name: 'Available model' })
    fireEvent.change(screen.getByPlaceholderText('modal.create.taskNamePlaceholder'), { target: { value: 'valid-model' } })
    expect(model).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: /modal.create.submit/ })).toBeDisabled()
    fireEvent.change(model, { target: { value: '__native__' } })
    expect(screen.getByRole('button', { name: /modal.create.submit/ })).not.toBeDisabled()
  })
})

describe('CreateTaskModal advanced options', () => {
  it('hides session IDs by default and preserves entered IDs through collapse and submit', () => {
    const { onCreate } = renderModal()
    const toggle = screen.getByRole('button', { name: 'modal.create.advancedOptions' })
    const implementerSession = screen.getByLabelText('modal.create.implementerSession')
    const reviewerSession = screen.getByLabelText('modal.create.reviewerSession')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(implementerSession).not.toBeVisible()
    expect(reviewerSession).not.toBeVisible()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(implementerSession).toBeVisible()
    expect(reviewerSession).toBeVisible()
    fireEvent.change(implementerSession, { target: { value: ' implementer-session ' } })
    fireEvent.change(reviewerSession, { target: { value: ' reviewer-thread ' } })
    fireEvent.click(toggle)
    expect(implementerSession).not.toBeVisible()
    fireEvent.click(toggle)
    expect(implementerSession).toHaveValue(' implementer-session ')
    expect(reviewerSession).toHaveValue(' reviewer-thread ')
    fireEvent.click(toggle)
    fireEvent.change(screen.getByPlaceholderText('modal.create.taskNamePlaceholder'), { target: { value: 'resume-sessions' } })
    fireEvent.click(screen.getByRole('button', { name: /modal.create.submit/ }))
    expect(onCreate.mock.calls[0][3]).toMatchObject({
      seed_actor_sessions: { claude: 'implementer-session', codex: 'reviewer-thread' },
      seed_claude_session_id: 'implementer-session',
      seed_codex_thread_id: 'reviewer-thread'
    })
  })
})

