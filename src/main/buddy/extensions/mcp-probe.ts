import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { ExtensionActionResult } from '../../../shared/extensions'

interface SavedMcp {
  kind?: string
  format?: string
  server?: Record<string, unknown>
  section?: string
}

export async function probeSavedMcp(file: string, cwd: string | undefined, timeoutMs = 8_000): Promise<ExtensionActionResult> {
  let saved: SavedMcp
  try {
    saved = JSON.parse(await readFile(file, 'utf8')) as SavedMcp
  } catch {
    return failed('not_found')
  }
  const target = stdioTarget(saved)
  if (!target) return failed(targetKind(saved))
  return probeStdio(target, cwd, timeoutMs)
}

export async function probeStdio(
  target: { command: string; args: string[]; env: Record<string, string> },
  cwd: string | undefined,
  timeoutMs: number
): Promise<ExtensionActionResult> {
  const child = spawn(target.command, target.args, {
    shell: false,
    detached: true,
    cwd: cwd && cwd.startsWith('/') && !cwd.includes('\0') ? cwd : undefined,
    env: { ...stringEnv(process.env), ...target.env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let buffer = ''
  const messages: Array<{ id?: number; result?: { tools?: Array<{ name?: string }> }; error?: { message?: string } }> = []
  child.stdout?.on('data', (chunk) => {
    buffer += chunk.toString()
    buffer = takeMessages(buffer, messages)
  })
  const done = new Promise<ExtensionActionResult>((resolvePromise) => {
    let settled = false
    const finish = (result: ExtensionActionResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killGroup(child)
      resolvePromise(result)
    }
    const timer = setTimeout(() => finish(failed('timeout')), timeoutMs)
    child.on('error', () => finish(failed('probe_failed')))
    child.on('close', () => {
      if (!settled && !messages.some((message) => message.id === 2)) finish(failed('probe_failed'))
    })
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'buddy', version: '0.0.0' } } })}\n`)
    const wait = setInterval(() => {
      const init = messages.find((message) => message.id === 1)
      if (!init) return
      clearInterval(wait)
      if (init.error) {
        finish(failed('probe_failed'))
        return
      }
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    }, 15)
    const toolsWait = setInterval(() => {
      const listed = messages.find((message) => message.id === 2)
      if (!listed) return
      clearInterval(toolsWait)
      if (listed.error) {
        finish(failed('probe_failed'))
        return
      }
      const tools = (listed.result?.tools ?? [])
        .map((tool) => (typeof tool.name === 'string' ? tool.name.replace(/[\0\r\n]/g, '').slice(0, 80) : ''))
        .filter(Boolean)
        .slice(0, 40)
      finish({ accepted: true, code: 'ok', results: [{ actor: '', status: 'skipped', code: 'connected', libraryItemId: null }], tools })
    }, 15)
    child.on('close', () => {
      clearInterval(wait)
      clearInterval(toolsWait)
    })
  })
  return done
}

function stdioTarget(saved: SavedMcp): { command: string; args: string[]; env: Record<string, string> } | null {
  if (saved.format === 'json' && saved.server) {
    if (typeof saved.server.url === 'string' && typeof saved.server.command !== 'string') return null
    const command = saved.server.command
    if (typeof command !== 'string' || !command.trim() || /[\0\r\n]/.test(command)) return null
    const args = Array.isArray(saved.server.args) ? saved.server.args : []
    if (args.some((arg) => typeof arg !== 'string' || /[\0\r\n]/.test(arg))) return null
    const env: Record<string, string> = {}
    if (saved.server.env && typeof saved.server.env === 'object' && !Array.isArray(saved.server.env)) {
      for (const [key, value] of Object.entries(saved.server.env)) {
        if (typeof value === 'string' && !/[\0\r\n]/.test(key) && !/[\0\r\n]/.test(value)) env[key] = value
      }
    }
    return { command, args: args as string[], env }
  }
  if (saved.format === 'toml' && saved.section) {
    const command = quoted(saved.section, 'command')
    if (!command) return null
    const argsLine = saved.section.split(/\r?\n/).find((line) => line.trim().startsWith('args'))
    const args = argsLine ? oneLineArgs(argsLine) : []
    if (!args) return null
    return { command, args, env: {} }
  }
  return null
}

function targetKind(saved: SavedMcp): string {
  const server = saved.server
  if (server && typeof server.url === 'string' && typeof server.command !== 'string') return 'remote'
  if (saved.section && /^\s*url\s*=/m.test(saved.section) && !/^\s*command\s*=/m.test(saved.section)) return 'remote'
  return 'unsupported'
}

function quoted(text: string, key: string): string | null {
  const line = text.split(/\r?\n/).find((entry) => entry.trim().startsWith(`${key} `) || entry.trim().startsWith(`${key}=`))
  if (!line) return null
  const raw = line.slice(line.indexOf('=') + 1).trim()
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1)
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1)
  return null
}

function oneLineArgs(line: string): string[] | null {
  const raw = line.slice(line.indexOf('=') + 1).trim()
  if (!raw.startsWith('[') || !raw.endsWith(']')) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return null
    return parsed as string[]
  } catch {
    return null
  }
}

function takeMessages(buffer: string, messages: Array<{ id?: number; result?: { tools?: Array<{ name?: string }> }; error?: { message?: string } }>): string {
  let rest = buffer
  const framed = readFrames(rest, messages)
  rest = framed
  let newline = rest.indexOf('\n')
  while (newline >= 0) {
    const line = rest.slice(0, newline).trim()
    rest = rest.slice(newline + 1)
    if (line.startsWith('{')) {
      try { messages.push(JSON.parse(line) as { id?: number }) } catch { /* ignore logs */ }
    }
    newline = rest.indexOf('\n')
  }
  return rest
}

function readFrames(buffer: string, messages: Array<{ id?: number }>): string {
  let rest = buffer
  while (rest.startsWith('Content-Length:')) {
    const split = rest.indexOf('\r\n\r\n')
    if (split < 0) return rest
    const header = rest.slice(0, split)
    const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1] ?? 0)
    const start = split + 4
    if (rest.length < start + length) return rest
    const body = rest.slice(start, start + length)
    rest = rest.slice(start + length)
    try { messages.push(JSON.parse(body) as { id?: number }) } catch { /* ignore */ }
  }
  return rest
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function failed(code: string): ExtensionActionResult {
  return { accepted: false, code: 'ok', results: [{ actor: '', status: 'failed', code, libraryItemId: null }] }
}

function killGroup(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return
  try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}
