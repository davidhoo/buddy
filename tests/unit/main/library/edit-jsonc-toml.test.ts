import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteMcpServerInJsonc, listMcpServersFromJsonc, parseJsonc, setMcpServerInJsonc } from '../../../../src/main/buddy/library/edit/jsonc'
import { deleteMcpServerToml, getMcpServerTable, listMcpServerTables, setMcpServerToml } from '../../../../src/main/buddy/library/edit/toml'

describe('library edit jsonc', () => {
  it('keeps comments when setting mcpServers entry', () => {
    const input = `{\n  // keep me\n  "mcpServers": {\n    "a": { "command": "echo" }\n  },\n  "other": true\n}\n`
    const next = setMcpServerInJsonc(input, 'demo', { command: 'npx', args: ['-y', 'demo'] })
    expect(next).toContain('// keep me')
    expect(next).toContain('"other": true')
    const value = parseJsonc<Record<string, unknown>>(next)
    expect(listMcpServersFromJsonc(value).demo).toMatchObject({ command: 'npx' })
    expect(listMcpServersFromJsonc(value).a).toMatchObject({ command: 'echo' })
  })

  it('deletes one server without wiping siblings', () => {
    const input = `{\n  "mcpServers": {\n    "a": { "command": "a" },\n    "b": { "command": "b" }\n  }\n}\n`
    const next = deleteMcpServerInJsonc(input, 'a')
    const servers = listMcpServersFromJsonc(parseJsonc(next))
    expect(servers.a).toBeUndefined()
    expect(servers.b).toMatchObject({ command: 'b' })
  })
})

describe('library edit toml', () => {
  it('replaces mcp_servers table while keeping comments and other tables', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'buddy-toml-'))
    const path = join(dir, 'config.toml')
    await writeFile(path, [
      '# top comment',
      'model = "gpt"',
      '',
      '[mcp_servers.old]',
      'command = "old"',
      '',
      '[features]',
      'hooks = true',
      ''
    ].join('\n'), 'utf8')

    await setMcpServerToml(path, 'demo', { command: 'npx', args: ['-y', 'x'] })
    const text = await readFile(path, 'utf8')
    expect(text).toContain('# top comment')
    expect(text).toContain('model = "gpt"')
    expect(text).toContain('[features]')
    expect(text).toContain('hooks = true')
    expect(listMcpServerTables(text).sort()).toEqual(['demo', 'old'])
    expect(getMcpServerTable(text, 'demo')).toMatchObject({ command: 'npx' })
    expect(getMcpServerTable(text, 'old')).toMatchObject({ command: 'old' })

    await deleteMcpServerToml(path, 'demo')
    const after = await readFile(path, 'utf8')
    expect(listMcpServerTables(after)).toEqual(['old'])
    expect(after).toContain('# top comment')
    expect(after).toContain('[features]')
  })
})

it('reads inline and nested TOML authentication headers as equivalent objects', () => {
  const inline = '[mcp_servers.remote]\nurl = "https://example.com"\nhttp_headers = { Authorization = "Bearer test-only" }\n'
  const nested = '[mcp_servers.remote]\nurl = "https://example.com"\n[mcp_servers.remote.http_headers]\nAuthorization = "Bearer test-only"\n'
  expect(getMcpServerTable(inline, 'remote')).toEqual(getMcpServerTable(nested, 'remote'))
  expect(getMcpServerTable(inline, 'remote')?.http_headers).toEqual({ Authorization: 'Bearer test-only' })
})
