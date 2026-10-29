// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LibraryPage } from '../../../src/renderer/components/library/LibraryPage'
import { translate } from '../../../src/renderer/lib/i18n'
import type { ExtensionPage, LibraryItem } from '../../../src/shared/extensions'

const { page, action } = vi.hoisted(() => ({ page: { data: null as unknown as ExtensionPage }, action: vi.fn() }))
vi.mock('../../../src/renderer/hooks/useBuddy', () => ({
  useExtensionTargets: () => ({ data: [] }),
  useExtensionPage: () => ({ data: page.data }),
  useExtensionLibrary: () => ({ data: page.data.library })
}))
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useT: () => (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('en', key, params) }))
vi.mock('../../../src/renderer/lib/api', () => ({ api: { planExtensionAction: (request: unknown) => action(request) } }))
afterEach(cleanup)
function setup(section: 'skills' | 'mcp') {
  const item = (id: string, kind: LibraryItem['kind']): LibraryItem => ({ id, kind, name: id, description: 'description', originActor: 'claude', originPath: id, shareKey: null, repository: null, pluginId: null, version: null, contentHash: null, libraryPath: '/fixture/'+id, externalPath: null, createdAt: '', updatedAt: '' })
  page.data = { kind: section === 'skills' ? 'skill' : 'mcp', cwd: null, cwdRejected: false, readOnly: true, generatedAt: '', targets: [{ actor: 'claude', assignBlock: 'none', status: 'ok', problems: [], instances: [], notes: [] } as unknown as ExtensionPage['targets'][number]], library: { version: 1, status: 'ok', dir: '', contentDir: '', backupDir: '', items: [item('skill-demo', 'skill'), item('mcp-demo', 'mcp'), item('rules-demo', 'instruction')], bindings: [], records: [] }, found: [] }
  action.mockReset().mockResolvedValue({ accepted: true, code: 'ok', results: [{ actor: 'claude', status: 'changed', code: 'saved', libraryItemId: null }], content: '# Real skill preview' })
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LibraryPage section={section} onOpenLauncherSettings={() => undefined} /></QueryClientProvider>)
}
describe('library UI regressions', () => {
  it.each(['skills', 'mcp'] as const)('shows only the page resource type in %s', section => {
    setup(section)
    const region = screen.getByRole('region', { name: 'In the library' })
    expect(within(region).getByRole('article', { name: section === 'skills' ? 'skill-demo' : 'mcp-demo' })).toBeVisible()
    expect(within(region).queryByRole('article', { name: 'rules-demo' })).not.toBeInTheDocument()
    expect(within(region).queryByRole('article', { name: section === 'skills' ? 'mcp-demo' : 'skill-demo' })).not.toBeInTheDocument()
  })
  it.each(['skills', 'mcp'] as const)('manages one agent from the %s header without a scan filter', async section => {
    setup(section)
    expect(screen.queryByRole('button', { name: 'Claude · Readable' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'By agent', exact: true }))
    const dialog = screen.getByRole('dialog', { name: 'By agent' })
    expect(within(dialog).getByText('0 of 1 assigned')).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn all on' }))
    await waitFor(() => expect(action).toHaveBeenCalledWith(expect.objectContaining({ action: 'assign', actor: 'claude', kind: section === 'skills' ? 'skill' : 'mcp', libraryItemId: section === 'skills' ? 'skill-demo' : 'mcp-demo', desired: 'on' })))
    expect(action).toHaveBeenCalledTimes(1)
  })
  it('locks native shared skills and excludes them from bulk off', () => {
    setup('skills')
    page.data.sharedSkills = [{ libraryItemId: 'skill-demo', actor: 'claude', path: '/shared/skill-demo' }]
    fireEvent.click(screen.getByRole('button', { name: 'By agent', exact: true }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('1 of 1 assigned')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Turn all off' })).toBeDisabled()
    expect(within(dialog).getByText('1 remain visible through native sharing')).toBeVisible()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    const skill = screen.getByRole('article', { name: 'skill-demo' })
    expect(within(skill).getByRole('button', { name: 'Claude', exact: true })).toBeDisabled()
    expect(within(skill).getByRole('button', { name: 'Claude', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(action).not.toHaveBeenCalled()
  })
  it('sets default mode, agent override and inheritance, opens preview and syncs', async () => {
    setup('skills')
    fireEvent.click(screen.getByRole('button', { name: 'Copies', exact: true }))
    await waitFor(() => expect(action).toHaveBeenCalledWith(expect.objectContaining({ action: 'skill_mode', mode: 'copy' })))
    fireEvent.click(screen.getByRole('button', { name: 'Mode by agent', exact: true }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Claude' }), { target: { value: 'copy' } })
    await waitFor(() => expect(action).toHaveBeenCalledWith(expect.objectContaining({ action: 'skill_mode', actor: 'claude', mode: 'copy' })))
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Claude' }), { target: { value: '' } })
    await waitFor(() => expect(action).toHaveBeenCalledWith(expect.objectContaining({ actor: 'claude', inherit: true })))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Sync copies' }))
    await waitFor(() => expect(action).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync' })))
    fireEvent.click(screen.getByRole('button', { name: /skill-demo.*description/ }))
    expect(await screen.findByText('# Real skill preview')).toBeVisible()
  })
})
