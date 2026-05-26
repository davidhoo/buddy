// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../../src/renderer/components/Sidebar'
import type { Task } from '../../../src/shared/types'

describe('Sidebar', () => {
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

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    try { window.localStorage?.clear() } catch {}
  })

  function task(taskId: string, repoRoot = '/tmp/repo'): Task {
    return {
      task_id: taskId,
      workspace_key: `${taskId}-workspace`,
      status: 'READY',
      updated_at: '2026-05-26T10:00:00.000Z',
      repo_root: repoRoot,
      round: 1,
      active_run: null
    }
  }

  function renderSidebar(tasks: Task[], overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
    const props = {
      isOpen: true,
      width: 240,
      tasks,
      selectedTaskId: null,
      isLoading: false,
      error: null,
      isHealthy: true,
      view: 'chat' as const,
      settingsTab: 'general' as const,
      onSelectTask: vi.fn(),
      onCreateTask: vi.fn(),
      onDeleteTask: vi.fn(),
      onOpenSettings: vi.fn(),
      onBackToApp: vi.fn(),
      onSelectSettingsTab: vi.fn(),
      onResize: vi.fn(),
      onToggleSidebar: vi.fn(),
      isFullScreen: false,
      onRenameProject: vi.fn(),
      onOpenInFinder: vi.fn(),
      onRemoveProject: vi.fn(),
      projectNames: {},
      ...overrides
    }

    render(<Sidebar {...props} />)
    return props
  }

  it('does not show task round numbers in the task list', () => {
    const tasks: Task[] = [{
      task_id: 'demo',
      workspace_key: 'abc123def456',
      status: 'READY',
      updated_at: '',
      repo_root: '/tmp/repo',
      round: 3,
      active_run: null
    }]

    const html = renderToStaticMarkup(
      <Sidebar
        isOpen
        width={240}
        tasks={tasks}
        selectedTaskId={null}
        isLoading={false}
        error={null}
        isHealthy
        view="chat"
        settingsTab="general"
        onSelectTask={() => {}}
        onCreateTask={() => {}}
        onDeleteTask={() => {}}
        onOpenSettings={() => {}}
        onBackToApp={() => {}}
        onSelectSettingsTab={() => {}}
        onResize={() => {}}
        onToggleSidebar={() => {}}
        isFullScreen={false}
        onRenameProject={() => {}}
        onOpenInFinder={() => {}}
        onRemoveProject={() => {}}
        projectNames={{}}
      />
    )

    expect(html).toContain('demo')
    expect(html).not.toContain('Round 3')
    expect(html).not.toContain('第 3 轮')
  })

  it('does not show a live seconds timer under running task names', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-26T08:00:14.000Z'))

    const tasks: Task[] = [{
      task_id: 'running demo',
      workspace_key: 'abc123def456',
      status: 'RUNNING_CLAUDE',
      updated_at: '2026-05-26T08:00:14.000Z',
      repo_root: '/tmp/repo',
      round: 1,
      active_run: {
        actor: 'claude',
        started_at: '2026-05-26T08:00:00.000Z'
      }
    }]

    const html = renderToStaticMarkup(
      <Sidebar
        isOpen
        width={240}
        tasks={tasks}
        selectedTaskId="running demo"
        isLoading={false}
        error={null}
        isHealthy
        view="chat"
        settingsTab="general"
        onSelectTask={() => {}}
        onCreateTask={() => {}}
        onDeleteTask={() => {}}
        onOpenSettings={() => {}}
        onBackToApp={() => {}}
        onSelectSettingsTab={() => {}}
        onResize={() => {}}
        onToggleSidebar={() => {}}
        isFullScreen={false}
        onRenameProject={() => {}}
        onOpenInFinder={() => {}}
        onRemoveProject={() => {}}
        projectNames={{}}
      />
    )

    expect(html).toContain('running demo')
    expect(html).not.toContain('14s')
  })

  it('collapses and expands a project when clicking the project row', () => {
    renderSidebar([task('first'), task('second')])

    const projectRow = screen.getByRole('button', { name: /repo/ })
    expect(projectRow).toHaveAttribute('aria-expanded', 'true')
    expect(projectRow.querySelector('.lucide-folder-open')).toBeTruthy()
    expect(projectRow.querySelector('.lucide-chevron-down, .lucide-chevron-right')).toBeNull()
    expect(projectRow).not.toHaveClass('focus:ring-1')
    expect(projectRow).not.toHaveClass('focus:ring-accent')
    expect(screen.getByText('first')).toBeTruthy()
    expect(screen.getByText('second')).toBeTruthy()

    fireEvent.click(projectRow)

    expect(projectRow).toHaveAttribute('aria-expanded', 'false')
    expect(projectRow.querySelector('.lucide-folder')).toBeTruthy()
    expect(projectRow.querySelector('.lucide-folder-open')).toBeNull()
    expect(projectRow.querySelector('.lucide-chevron-down, .lucide-chevron-right')).toBeNull()
    expect(screen.queryByText('first')).toBeNull()
    expect(screen.queryByText('second')).toBeNull()

    fireEvent.click(projectRow)

    expect(projectRow).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('first')).toBeTruthy()
    expect(screen.getByText('second')).toBeTruthy()
  })

  it('keeps the project collapse state when clicking project actions', () => {
    const props = renderSidebar([task('first'), task('second')])
    const projectRow = screen.getByRole('button', { name: /repo/ })

    fireEvent.click(projectRow)
    expect(projectRow).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(screen.getByTitle('More actions'))
    expect(projectRow).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('first')).toBeNull()

    fireEvent.click(screen.getByTitle('New task in this project'))
    expect(props.onCreateTask).toHaveBeenCalledWith('/tmp/repo')
    expect(projectRow).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('second')).toBeNull()
  })

  it('allows the selected task project to stay collapsed when the project was persisted collapsed', () => {
    window.localStorage.setItem('buddy.collapsedProjectKeys', JSON.stringify(['repo']))

    renderSidebar([task('first'), task('second')], { selectedTaskId: 'first' })

    const projectRow = screen.getByRole('button', { name: /repo/ })
    expect(projectRow).toHaveAttribute('aria-expanded', 'false')
    expect(projectRow.querySelector('.lucide-folder')).toBeTruthy()
    expect(projectRow.querySelector('.lucide-folder-open')).toBeNull()
    expect(screen.queryByText('first')).toBeNull()
    expect(screen.queryByText('second')).toBeNull()
  })
})
