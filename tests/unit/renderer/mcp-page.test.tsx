// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { McpPage } from '../../../src/renderer/components/library/McpPage'

const state = vi.hoisted(() => ({ importServers: vi.fn(), managed: false, ejectServer: vi.fn() }))
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useT: () => (key: string) => key
}))
vi.mock('../../../src/renderer/hooks/useLibrary', () => ({
  useLibrarySnapshot: () => ({ data: {
    servers: state.managed ? [{ id: 'local', name: 'local-mcp', transport: 'stdio', summary: 'node', assignedTargetIds: ['cursor:native:user'] }] : [],
    auth: [],
    targets: [{ targetId: 'cursor:native:user', agentId: 'cursor', displayName: 'Cursor', configContext: 'native', scope: 'user', mcpPath: '/tmp/mcp.json', capabilities: { readMcp: true, writeMcp: true } }], discoveredServers: [{
      discoveryId: 'shared:example', name: 'example-mcp', agentId: 'shared',
      path: '/home/user/.agents/mcp.json', transport: 'stdio', summary: 'example serve'
    }]
  } }),
  useLibraryActions: () => ({
    ejectServer: { isPending: false, mutate: state.ejectServer },
    refresh: { isPending: false }, setServer: { isPending: false },
    importServers: { isPending: false, mutate: state.importServers }
  })
}))
afterEach(() => { cleanup(); vi.clearAllMocks(); state.managed = false })

it('shows discovered MCP servers even when the managed catalog is empty and allows importing them', () => {
  render(<McpPage />)
  expect(screen.getByText('library.mcp.discovered')).toBeInTheDocument()
  expect(screen.getByText('example-mcp')).toBeInTheDocument()
  expect(screen.getByText('shared · /home/user/.agents/mcp.json')).toBeInTheDocument()
  fireEvent.click(screen.getByText('library.import'))
  expect(state.importServers).toHaveBeenLastCalledWith(['shared:example'])
  fireEvent.click(screen.getByText('library.importAll'))
  expect(state.importServers).toHaveBeenLastCalledWith(['shared:example'])
})

it('does not invent unknown login labels for assigned local servers', () => {
  state.managed = true
  render(<McpPage />)
  expect(screen.getByText('local-mcp')).toBeInTheDocument()
  expect(screen.queryByText(/Cursor: unknown/)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Cursor' })).toHaveAttribute('aria-pressed', 'true')
})

it('lets the user stop managing a library server', () => {
  state.managed = true
  vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
  render(<McpPage />)
  fireEvent.click(screen.getByRole('button', { name: 'library.mcp.eject' }))
  expect(state.ejectServer).toHaveBeenCalledWith('local')
  vi.restoreAllMocks()
})
