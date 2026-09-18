import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BuddyCoreService } from '../../../src/main/buddy/service'

describe('testLauncher ACP protocol support', () => {
  it('successfully initializes and returns preview for ACP agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-acp-testlauncher-'))
    const fakeAcp = join(root, 'fake-acp.js')

    const fakeAcpContent = `#!/usr/bin/env node
const readline = require('node:readline')

if (process.argv[2] === '--version') {
  console.log('1.0.0')
  process.exit(0)
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  try {
    const req = JSON.parse(line)
    if (req.method === 'initialize') {
      const res = {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'MockAcpAgent', version: '3.1.4' },
          capabilities: { tools: true }
        }
      }
      process.stdout.write(JSON.stringify(res) + '\\n')
    }
  } catch {}
})
`
    await writeFile(fakeAcp, fakeAcpContent)
    await chmod(fakeAcp, 0o755)

    try {
      const service = new BuddyCoreService({ dataRoot: join(root, 'data') })
      const result = await service.testLauncher('opencode', fakeAcp, undefined, 'acp', ['acp'])
      expect(result.success).toBe(true)
      expect(result.phase).toBe('ping')
      expect(result.responsePreview).toBe('Connected: MockAcpAgent v3.1.4')
      expect(result.error).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('handles serverInfo format as fallback for ACP agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-acp-testlauncher-serverinfo-'))
    const fakeAcp = join(root, 'fake-acp-serverinfo.js')

    const fakeAcpContent = `#!/usr/bin/env node
const readline = require('node:readline')

if (process.argv[2] === '--version') {
  console.log('1.0.0')
  process.exit(0)
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  try {
    const req = JSON.parse(line)
    if (req.method === 'initialize') {
      const res = {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: 1,
          serverInfo: { name: 'ServerInfoAgent', version: '0.9.1' },
          capabilities: {}
        }
      }
      process.stdout.write(JSON.stringify(res) + '\\n')
    }
  } catch {}
})
`
    await writeFile(fakeAcp, fakeAcpContent)
    await chmod(fakeAcp, 0o755)

    try {
      const service = new BuddyCoreService({ dataRoot: join(root, 'data') })
      const result = await service.testLauncher('codex', fakeAcp, undefined, 'acp')
      expect(result.success).toBe(true)
      expect(result.phase).toBe('ping')
      expect(result.responsePreview).toBe('Connected: ServerInfoAgent v0.9.1')
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('fails gracefully when ACP handshake returns an error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-acp-testlauncher-err-'))
    const fakeAcp = join(root, 'fake-acp-err.js')

    const fakeAcpContent = `#!/usr/bin/env node
const readline = require('node:readline')

if (process.argv[2] === '--version') {
  console.log('1.0.0')
  process.exit(0)
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  try {
    const req = JSON.parse(line)
    if (req.method === 'initialize') {
      const res = {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32603, message: 'Internal agent handshake failure' }
      }
      process.stdout.write(JSON.stringify(res) + '\\n')
    }
  } catch {}
})
`
    await writeFile(fakeAcp, fakeAcpContent)
    await chmod(fakeAcp, 0o755)

    try {
      const service = new BuddyCoreService({ dataRoot: join(root, 'data') })
      const result = await service.testLauncher('claude', fakeAcp, undefined, 'acp')
      expect(result.success).toBe(false)
      expect(result.phase).toBe('ping')
      expect(result.error).toContain('Internal agent handshake failure')
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('falls back to Cursor Agent display name when actor is cursor and agentInfo is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-acp-testlauncher-cursor-'))
    const fakeCursorAcp = join(root, 'fake-cursor-acp.js')

    const fakeCursorAcpContent = `#!/usr/bin/env node
const readline = require('node:readline')

if (process.argv[2] === '--version') {
  console.log('0.1.0')
  process.exit(0)
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  try {
    const req = JSON.parse(line)
    if (req.method === 'initialize') {
      // Cursor returns protocolVersion: 1 and agentCapabilities, but NO agentInfo or serverInfo
      const res = {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true }
        }
      }
      process.stdout.write(JSON.stringify(res) + '\\n')
    }
  } catch {}
})
`
    await writeFile(fakeCursorAcp, fakeCursorAcpContent)
    await chmod(fakeCursorAcp, 0o755)

    try {
      const service = new BuddyCoreService({ dataRoot: join(root, 'data') })
      const result = await service.testLauncher('cursor', fakeCursorAcp, undefined, 'acp', ['acp'])
      expect(result.success).toBe(true)
      expect(result.phase).toBe('ping')
      expect(result.responsePreview).toBe('Connected: Cursor Agent')
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('fails fast when process exits immediately with error instead of hanging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-acp-testlauncher-exit-'))
    const fakeAgy = join(root, 'fake-agy.js')

    // Simulates agy acp: prints error to stderr and exits with code 2 immediately
    const fakeAgyContent = `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  console.log('1.0.0')
  process.exit(0)
}
process.stderr.write('Error: unexpected argument "acp".\\n')
process.exit(2)
`
    await writeFile(fakeAgy, fakeAgyContent)
    await chmod(fakeAgy, 0o755)

    try {
      const service = new BuddyCoreService({ dataRoot: join(root, 'data') })
      const startTime = Date.now()
      const result = await service.testLauncher('agy', fakeAgy, undefined, 'acp', ['acp'])
      const duration = Date.now() - startTime

      expect(result.success).toBe(false)
      expect(result.phase).toBe('ping')
      expect(result.error).toContain('Process exited with code 2')
      expect(result.error).toContain('Error: unexpected argument "acp"')
      // Verify fast failure (< 2000ms, not hanging for 120s timeout)
      expect(duration).toBeLessThan(2000)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('automatically injects WeCode environment variables during ACP testLauncher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-acp-testlauncher-wecode-'))
    const fakeAcp = join(root, 'fake-wecode-acp.js')

    const fakeAcpContent = `#!/usr/bin/env node
const readline = require('node:readline')

if (process.argv[2] === '--version') {
  console.log('1.0.0')
  process.exit(0)
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  try {
    const req = JSON.parse(line)
    if (req.method === 'initialize') {
      const isClaude = Boolean(process.env.CLAUDE_CODE_EXECUTABLE)
      const isCodex = Boolean(process.env.CODEX_PATH)
      const name = isClaude ? 'WeCodeClaudeAdapter' : isCodex ? 'WeCodeCodexAdapter' : 'Unknown'
      const res = {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name, version: '1.0.0' }
        }
      }
      process.stdout.write(JSON.stringify(res) + '\\n')
    }
  } catch {}
})
`
    await writeFile(fakeAcp, fakeAcpContent)
    await chmod(fakeAcp, 0o755)

    try {
      const service = new BuddyCoreService({ dataRoot: join(root, 'data') })

      // Test wecode_claude
      const claudeResult = await service.testLauncher('wecode_claude', fakeAcp, undefined, 'acp')
      expect(claudeResult.success).toBe(true)
      expect(claudeResult.responsePreview).toBe('Connected: WeCodeClaudeAdapter v1.0.0')

      // Test wecode_codex
      const codexResult = await service.testLauncher('wecode_codex', fakeAcp, undefined, 'acp')
      expect(codexResult.success).toBe(true)
      expect(codexResult.responsePreview).toBe('Connected: WeCodeCodexAdapter v1.0.0')
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('strictly sends boolean terminal capability so strict agents (cursor, opencode) succeed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-acp-strict-terminal-'))
    const fakeAcp = join(root, 'fake-strict-acp.js')

    const fakeAcpContent = `#!/usr/bin/env node
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  try {
    const req = JSON.parse(line)
    if (req.method === 'initialize') {
      const term = req.params?.clientCapabilities?.terminal
      if (typeof term !== 'boolean') {
        const err = {
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: -32603,
            message: 'Internal error',
            data: [{ expected: 'boolean', code: 'invalid_type', path: ['clientCapabilities', 'terminal'] }]
          }
        }
        process.stdout.write(JSON.stringify(err) + '\\n')
        return
      }
      const res = {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'StrictAgent', version: '2.0.0' }
        }
      }
      process.stdout.write(JSON.stringify(res) + '\\n')
    }
  } catch {}
})
`
    await writeFile(fakeAcp, fakeAcpContent)
    await chmod(fakeAcp, 0o755)

    try {
      const service = new BuddyCoreService({ dataRoot: join(root, 'data') })
      const result = await service.testLauncher('cursor', fakeAcp, undefined, 'acp', ['acp'])
      expect(result.success).toBe(true)
      expect(result.responsePreview).toBe('Connected: StrictAgent v2.0.0')
      expect(result.error).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('lists models advertised by an ACP session/new result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-acp-list-models-'))
    const fakeAcp = join(root, 'fake-acp-models.js')

    const fakeAcpContent = `#!/usr/bin/env node
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  try {
    const req = JSON.parse(line)
    if (req.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: { protocolVersion: 1, agentInfo: { name: 'ModelAgent', version: '1.0.0' } }
      }) + '\\n')
    } else if (req.method === 'session/new') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          sessionId: 'sess_models',
          models: {
            currentModelId: 'sonnet-4.5',
            availableModels: [
              { modelId: 'opus-4.6', name: 'Opus 4.6' },
              { modelId: 'sonnet-4.5', name: 'Sonnet 4.5' }
            ]
          }
        }
      }) + '\\n')
    }
  } catch {}
})
`
    await writeFile(fakeAcp, fakeAcpContent)
    await chmod(fakeAcp, 0o755)

    try {
      const service = new BuddyCoreService({ dataRoot: join(root, 'data') })
      await service.updateGlobalSettings({
        launchers: {
          claude: {
            protocol: 'acp',
            command: process.execPath,
            args: [fakeAcp],
            env: {},
            timeout_seconds: 10
          }
        }
      })

      const list = await service.listAcpModels('claude')
      expect(list.currentModelId).toBe('sonnet-4.5')
      expect(list.models).toEqual([
        { id: 'opus-4.6', name: 'Opus 4.6' },
        { id: 'sonnet-4.5', name: 'Sonnet 4.5' }
      ])

      const cliList = await service.listAcpModels('codex')
      expect(cliList.models).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // Live probes hit real CLIs (cursor-agent / opencode / wecode) with a 120s ACP
  // ping timeout. Keep them out of the default unit suite so hung agents cannot
  // fail or stall `pnpm test`. Opt in with BUDDY_LIVE_ACP_TEST=1.
  it.skipIf(!process.env.BUDDY_LIVE_ACP_TEST)(
    'successfully handshakes with live cursor-agent, opencode, and wecode opencode if available',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'buddy-acp-live-test-'))
      try {
        const service = new BuddyCoreService({ dataRoot: join(root, 'data') })

        // Test cursor if installed
        const cursorRes = await service
          .testLauncher('cursor', 'cursor-agent', undefined, 'acp', ['acp'])
          .catch(() => null)
        if (cursorRes && cursorRes.success) {
          expect(cursorRes.success).toBe(true)
          expect(cursorRes.responsePreview).toContain('Connected: Cursor Agent')
        }

        // Test opencode if installed
        const opencodeRes = await service
          .testLauncher('opencode', 'opencode', undefined, 'acp', ['acp'])
          .catch(() => null)
        if (opencodeRes && opencodeRes.success) {
          expect(opencodeRes.success).toBe(true)
          expect(opencodeRes.responsePreview).toContain('Connected: OpenCode')
        }

        // Test wecode_opencode if installed
        const wecodeRes = await service
          .testLauncher('wecode_opencode', 'wecode opencode', undefined, 'acp', [])
          .catch(() => null)
        if (wecodeRes && wecodeRes.success) {
          expect(wecodeRes.success).toBe(true)
          expect(wecodeRes.responsePreview).toContain('Connected: OpenCode')
        }
      } finally {
        await rm(root, { recursive: true, force: true }).catch(() => {})
      }
    },
    20000
  )
})
