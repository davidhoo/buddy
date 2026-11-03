/**
 * Canonical MCP server shape ↔ native agent formats.
 * Refuse conversions that would silently drop required semantics.
 */
import type { LibraryTarget, McpTransport } from '../../../shared/library'

export interface CanonicalMcp {
  transport: Exclude<McpTransport, 'unknown'>
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined || v === null) continue
    out[k] = String(v)
  }
  return Object.keys(out).length ? out : undefined
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(String)
}

/** Normalize raw agent entries (Claude/Cursor/Codex/OpenCode-ish) into a canonical form. */
export function toCanonical(raw: Record<string, unknown>): CanonicalMcp {
  const type = String(raw.type || raw.transport || '').toLowerCase()
  const url = typeof raw.url === 'string' ? raw.url
    : typeof raw.serverUrl === 'string' ? raw.serverUrl
    : typeof raw.httpUrl === 'string' ? raw.httpUrl
    : undefined
  const command = typeof raw.command === 'string' ? raw.command
    : Array.isArray(raw.command) && raw.command.length ? String(raw.command[0])
    : undefined
  const args = Array.isArray(raw.command) && raw.command.length > 1
    ? raw.command.slice(1).map(String)
    : asStringList(raw.args)
  const env = asStringMap(raw.env) || asStringMap(raw.environment)
  const headers = asStringMap(raw.headers)
    || asStringMap(raw.http_headers)
    || asStringMap(raw.httpHeaders)

  if (url || type === 'http' || type === 'sse' || type === 'remote' || type === 'streamable-http' || type === 'streamable_http') {
    const transport: CanonicalMcp['transport'] =
      type === 'sse' ? 'sse'
        : type === 'http' || type === 'remote' || type === 'streamable-http' || type === 'streamable_http' || !!url ? 'http'
          : 'http'
    if (!url) throw new Error('remote MCP server is missing url')
    return { transport: type === 'sse' ? 'sse' : transport === 'sse' ? 'sse' : 'http', url, headers }
  }

  if (!command) throw new Error('stdio MCP server is missing command')
  return {
    transport: 'stdio',
    command,
    args,
    env
  }
}

export function encodeForFormat(
  canonical: CanonicalMcp,
  format: LibraryTarget['mcpFormat']
): Record<string, unknown> {
  if (format === 'unsupported') throw new Error('unsupported MCP format')

  if (format === 'toml-mcp_servers') {
    // Codex: no SSE; headers → http_headers.
    if (canonical.transport === 'sse') {
      throw new Error('Codex config.toml does not support SSE MCP servers; refuse assignment')
    }
    if (canonical.transport === 'http') {
      if (!canonical.url) throw new Error('HTTP MCP server missing url')
      const out: Record<string, unknown> = { url: canonical.url }
      if (canonical.headers) out.http_headers = canonical.headers
      return out
    }
    if (!canonical.command) throw new Error('stdio MCP server missing command')
    const out: Record<string, unknown> = { command: canonical.command }
    if (canonical.args?.length) out.args = canonical.args
    if (canonical.env) out.env = canonical.env
    return out
  }

  // jsonc-mcpServers (Claude / Cursor / similar)
  if (canonical.transport === 'http' || canonical.transport === 'sse') {
    if (!canonical.url) throw new Error('remote MCP server missing url')
    const out: Record<string, unknown> = {
      type: canonical.transport,
      url: canonical.url
    }
    if (canonical.headers) out.headers = canonical.headers
    return out
  }
  if (!canonical.command) throw new Error('stdio MCP server missing command')
  const out: Record<string, unknown> = { command: canonical.command }
  if (canonical.args?.length) out.args = canonical.args
  if (canonical.env) out.env = canonical.env
  return out
}

/** Convert a stored raw entry into the target native shape, or throw with a clear reason. */
export function convertMcpRawForTarget(
  raw: Record<string, unknown>,
  format: LibraryTarget['mcpFormat']
): Record<string, unknown> {
  const cleaned = { ...raw }
  delete cleaned.__buddy
  return encodeForFormat(toCanonical(cleaned), format)
}
