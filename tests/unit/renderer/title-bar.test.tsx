import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TitleBar } from '../../../src/renderer/components/TitleBar'

type TitleBarProps = Parameters<typeof TitleBar>[0]

function renderTitleBar(overrides: Partial<TitleBarProps> = {}) {
  const props: TitleBarProps = {
    taskName: 'demo',
    taskStatus: 'RUNNING_CLAUDE',
    isSidebarOpen: true,
    isStatusBarOpen: false,
    isFullScreen: false,
    onToggleSidebar: () => {},
    onToggleStatusBar: () => {},
    onRetry: () => {},
    onResume: () => {},
    ...overrides
  }

  return renderToStaticMarkup(<TitleBar {...props} />)
}

describe('TitleBar compact status', () => {
  it('shows running status when the status bar is hidden', () => {
    const html = renderTitleBar({ taskStatus: 'RUNNING_CODEX', isStatusBarOpen: false })

    expect(html).toContain('lucide-loader-circle')
    expect(html).toContain('animate-spin')
    expect(html).toContain('status-text-running')
  })

  it('aligns the compact status with the status bar toggle button', () => {
    const html = renderTitleBar({ taskStatus: 'RUNNING_CODEX', isStatusBarOpen: false })

    expect(html).toContain('class="h-5 flex items-center gap-1.5 mr-2 mt-[4px] no-drag"')
    expect(html).toContain('class="w-5 h-5 mt-[4px] flex items-center justify-center rounded hover:bg-bg-muted no-drag"')
  })

  it('hides compact status when the status bar is open', () => {
    const html = renderTitleBar({ taskStatus: 'RUNNING_CODEX', isStatusBarOpen: true })

    expect(html).not.toContain('lucide-loader-circle')
    expect(html).not.toContain('status-text-running')
  })

  it('shows resume and retry icon actions for paused and failed states', () => {
    const paused = renderTitleBar({ taskStatus: 'PAUSED' })
    const failed = renderTitleBar({ taskStatus: 'FAILED' })

    expect(paused).toContain('status-dot-paused')
    expect(paused).toContain('lucide-play')
    expect(paused).not.toContain('lucide-rotate-cw')
    expect(failed).toContain('lucide-x')
    expect(failed).toContain('lucide-rotate-cw')
    expect(failed).not.toContain('lucide-play')
  })

  it('shows completed status without an action icon', () => {
    const html = renderTitleBar({ taskStatus: 'DONE' })

    expect(html).toContain('status-dot-done-ring')
    expect(html).toContain('status-text-done')
    expect(html).not.toContain('lucide-play')
    expect(html).not.toContain('lucide-rotate-cw')
  })
})
