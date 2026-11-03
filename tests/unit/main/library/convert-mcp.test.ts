import { describe, expect, it } from 'vitest'
import { convertMcpRawForTarget, toCanonical } from '../../../../src/main/buddy/library/convert'

describe('MCP format conversion', () => {
  it('maps Claude headers to Codex http_headers', () => {
    const raw = {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x', 'X-Test': '1' }
    }
    expect(convertMcpRawForTarget(raw, 'toml-mcp_servers')).toEqual({
      url: 'https://example.com/mcp',
      http_headers: { Authorization: 'Bearer x', 'X-Test': '1' }
    })
  })

  it('maps Codex http_headers back to Claude headers', () => {
    const raw = {
      url: 'https://example.com/mcp',
      http_headers: { Authorization: 'Bearer x' }
    }
    expect(convertMcpRawForTarget(raw, 'jsonc-mcpServers')).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' }
    })
  })

  it('keeps stdio command/args/env across formats', () => {
    const raw = { command: 'npx', args: ['-y', 'demo'], env: { FOO: '1' } }
    expect(convertMcpRawForTarget(raw, 'toml-mcp_servers')).toEqual({
      command: 'npx',
      args: ['-y', 'demo'],
      env: { FOO: '1' }
    })
    expect(convertMcpRawForTarget(raw, 'jsonc-mcpServers')).toEqual({
      command: 'npx',
      args: ['-y', 'demo'],
      env: { FOO: '1' }
    })
  })

  it('refuses SSE assignment to Codex TOML', () => {
    expect(() => convertMcpRawForTarget({ type: 'sse', url: 'https://sse.example' }, 'toml-mcp_servers'))
      .toThrow(/does not support SSE/)
  })

  it('accepts SSE for jsonc targets', () => {
    expect(convertMcpRawForTarget({ type: 'sse', url: 'https://sse.example' }, 'jsonc-mcpServers')).toEqual({
      type: 'sse',
      url: 'https://sse.example'
    })
  })

  it('normalizes OpenCode local command arrays', () => {
    expect(toCanonical({ type: 'local', command: ['npx', '-y', 'x'], environment: { A: 'b' } })).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'x'],
      env: { A: 'b' }
    })
  })
})
