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
})
