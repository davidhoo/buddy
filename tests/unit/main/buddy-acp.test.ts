import { describe, expect, it, vi } from 'vitest'
import { AcpClient, type AcpTransport, type JsonRpcMessage, type JsonRpcRequest, type JsonRpcResponse } from '../../../src/main/buddy/acp'

class MockAcpTransport implements AcpTransport {
  sentMessages: JsonRpcMessage[] = []
  private messageHandlers = new Set<(msg: JsonRpcMessage) => void>()
  private closeHandlers = new Set<(code: number | null, signal: string | null) => void>()
  private errorHandlers = new Set<(err: Error) => void>()
  isClosed = false

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.isClosed) throw new Error('Transport is closed')
    this.sentMessages.push(message)
  }

  onMessage(handler: (msg: JsonRpcMessage) => void): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  onClose(handler: (code: number | null, signal: string | null) => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  onError(handler: (err: Error) => void): () => void {
    this.errorHandlers.add(handler)
    return () => this.errorHandlers.delete(handler)
  }

  async close(): Promise<void> {
    this.isClosed = true
  }

  mockStderr = ''
  getStderr(): string {
    return this.mockStderr
  }

  // Helper to simulate incoming server message
  simulateMessage(msg: JsonRpcMessage): void {
    for (const handler of this.messageHandlers) {
      handler(msg)
    }
  }

  simulateClose(code: number | null, signal: string | null = null, stderr = ''): void {
    this.mockStderr = stderr
    this.isClosed = true
    for (const handler of this.closeHandlers) {
      handler(code, signal)
    }
  }

  simulateError(err: Error): void {
    for (const handler of this.errorHandlers) {
      handler(err)
    }
  }
}

describe('AcpClient', () => {
  it('performs initialize handshake with capabilities', async () => {
    const transport = new MockAcpTransport()
    const client = new AcpClient(transport)

    const initPromise = client.initialize()

    expect(transport.sentMessages.length).toBe(1)
    const req = transport.sentMessages[0] as JsonRpcRequest
    expect(req.method).toBe('initialize')
    expect(req.jsonrpc).toBe('2.0')
    expect((req.params as any).protocolVersion).toBe(1)

    transport.simulateMessage({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '1.0',
        agentInfo: { name: 'test-agent', version: '0.1.0' },
        capabilities: { streaming: true, tools: true }
      }
    })

    const result = await initPromise
    expect(result.agentInfo.name).toBe('test-agent')
    expect(result.capabilities.streaming).toBe(true)
  })

  it('creates and resumes sessions with mcpServers default', async () => {
    const transport = new MockAcpTransport()
    const client = new AcpClient(transport)

    // 1. new session
    const newSessionPromise = client.newSession({ cwd: '/test/repo' })
    const req1 = transport.sentMessages[0] as JsonRpcRequest
    expect(req1.method).toBe('session/new')
    expect((req1.params as any).mcpServers).toEqual([])

    transport.simulateMessage({
      jsonrpc: '2.0',
      id: req1.id,
      result: { sessionId: 'sess_12345' }
    })
    const newRes = await newSessionPromise
    expect(newRes.sessionId).toBe('sess_12345')

    // 2. load session
    const loadSessionPromise = client.loadSession({ sessionId: 'sess_12345', cwd: '/test/repo' })
    const req2 = transport.sentMessages[1] as JsonRpcRequest
    expect(req2.method).toBe('session/load')
    expect((req2.params as any).mcpServers).toEqual([])

    transport.simulateMessage({
      jsonrpc: '2.0',
      id: req2.id,
      result: { sessionId: 'sess_12345' }
    })
    const loadRes = await loadSessionPromise
    expect(loadRes.sessionId).toBe('sess_12345')
  })

  it('streams content and thinking deltas including session/update format', async () => {
    const transport = new MockAcpTransport()
    const client = new AcpClient(transport)

    const contentDeltas: string[] = []
    const thinkingDeltas: string[] = []

    const promptPromise = client.prompt(
      { sessionId: 'sess_1', prompt: 'Hello agent' },
      {
        onContentDelta: (text) => contentDeltas.push(text),
        onThinkingDelta: (thinking) => thinkingDeltas.push(thinking)
      }
    )

    const promptReq = transport.sentMessages[0] as JsonRpcRequest
    expect(promptReq.method).toBe('session/prompt')
    expect((promptReq.params as any).prompt).toEqual([{ type: 'text', text: 'Hello agent' }])

    // Simulate thinking notifications
    transport.simulateMessage({
      jsonrpc: '2.0',
      method: 'session/thinkingDelta',
      params: { thinking: 'Let me think...' }
    })

    // Simulate standard session/update notification with chunks
    transport.simulateMessage({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_1',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'More thinking...' }
        }
      }
    })

    // Simulate standard session/update content notification
    transport.simulateMessage({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello ' }
        }
      }
    })

    // Simulate legacy content delta notification
    transport.simulateMessage({
      jsonrpc: '2.0',
      method: 'session/contentDelta',
      params: { text: 'world!' }
    })

    // Finish prompt
    transport.simulateMessage({
      jsonrpc: '2.0',
      id: promptReq.id,
      result: { status: 'completed' }
    })

    const result = await promptPromise
    expect(result.status).toBe('completed')
    expect(thinkingDeltas).toEqual(['Let me think...', 'More thinking...'])
    expect(contentDeltas).toEqual(['Hello ', 'world!'])
  })

  it('automatically approves permission requests from the agent', async () => {
    const transport = new MockAcpTransport()
    const client = new AcpClient(transport)

    const promptPromise = client.prompt({ sessionId: 'sess_1', prompt: 'Run code' })
    const promptReq = transport.sentMessages[0] as JsonRpcRequest

    // Simulate agent requesting permission
    transport.simulateMessage({
      jsonrpc: '2.0',
      id: 'perm_req_1',
      method: 'session/request_permission',
      params: {
        sessionId: 'sess_1',
        toolCall: { toolCallId: 'call_1', title: 'Write file' },
        options: [
          { optionId: 'opt_reject', name: 'Reject', kind: 'reject_once' },
          { optionId: 'opt_allow', name: 'Allow always', kind: 'allow_always' }
        ]
      }
    })

    const permRes = transport.sentMessages.find(
      (m): m is JsonRpcResponse => 'id' in m && m.id === 'perm_req_1'
    )
    expect(permRes).toBeDefined()
    expect(permRes?.result).toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'opt_allow'
      }
    })

    // Finish prompt
    transport.simulateMessage({
      jsonrpc: '2.0',
      id: promptReq.id,
      result: { status: 'completed' }
    })

    await promptPromise
  })

  it('handles buddy_propose_break tool call for native Dual-Break', async () => {
    const transport = new MockAcpTransport()
    const client = new AcpClient(transport)

    let breakReason: string | undefined

    const promptPromise = client.prompt(
      { sessionId: 'sess_1', prompt: 'Check if done' },
      {
        onBreak: (reason) => {
          breakReason = reason
        }
      }
    )

    const promptReq = transport.sentMessages[0] as JsonRpcRequest

    // Simulate agent calling the host tool buddy_propose_break
    transport.simulateMessage({
      jsonrpc: '2.0',
      id: 'agent_call_1',
      method: 'tools/call',
      params: {
        name: 'buddy_propose_break',
        input: { reason: 'All unit tests pass and feature is verified.' }
      }
    })

    // Expect client to send back a successful response to the agent's tool call
    const hostRes = transport.sentMessages.find(
      (m): m is JsonRpcResponse => 'id' in m && m.id === 'agent_call_1'
    )
    expect(hostRes).toBeDefined()
    expect(hostRes?.result).toEqual({
      status: 'success',
      message: 'Break proposal recorded by Buddy'
    })
    expect(breakReason).toBe('All unit tests pass and feature is verified.')

    // Complete the prompt turn
    transport.simulateMessage({
      jsonrpc: '2.0',
      id: promptReq.id,
      result: { status: 'completed' }
    })

    const promptRes = await promptPromise
    expect(promptRes.status).toBe('completed')
  })

  it('rejects on JSON-RPC error response', async () => {
    const transport = new MockAcpTransport()
    const client = new AcpClient(transport)

    const reqPromise = client.request('some/method')
    const req = transport.sentMessages[0] as JsonRpcRequest

    transport.simulateMessage({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32600, message: 'Invalid Request' }
    })

    await expect(reqPromise).rejects.toThrow('ACP Error -32600: Invalid Request')
  })

  it('rejects pending requests immediately when transport closes unexpectedly with stderr', async () => {
    const transport = new MockAcpTransport()
    const client = new AcpClient(transport)

    const initPromise = client.initialize()

    // Subprocess terminates unexpectedly with stderr
    transport.simulateClose(2, null, 'Error: unexpected argument "acp"')

    await expect(initPromise).rejects.toThrow('Process exited with code 2: Error: unexpected argument "acp"')
  })

  it('rejects pending requests immediately when transport emits an error', async () => {
    const transport = new MockAcpTransport()
    const client = new AcpClient(transport)

    const initPromise = client.initialize()

    transport.simulateError(new Error('spawn ENOENT'))

    await expect(initPromise).rejects.toThrow('spawn ENOENT')
  })
})

describe('AcpStdioTransport', () => {
  it('communicates over stdio with a subprocess', async () => {
    const { AcpStdioTransport } = await import('../../../src/main/buddy/acp/transport')

    // Tiny node script that reads a line from stdin, responds with JSON-RPC result, and exits
    const script = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ping: 'pong' } }) + '\\n');
      });
    `

    const transport = new AcpStdioTransport({
      command: process.execPath,
      args: ['-e', script]
    })

    transport.start()

    const client = new AcpClient(transport)
    const res = await client.request<{ ping: string }>('test/ping')
    expect(res.ping).toBe('pong')

    await client.close()
  })

  it('buffers stderr and provides getStderr', async () => {
    const { AcpStdioTransport } = await import('../../../src/main/buddy/acp/transport')

    const script = `
      process.stderr.write('fatal error: unknown flag\\n');
      process.exit(1);
    `

    let stderrReceived = ''
    const transport = new AcpStdioTransport({
      command: process.execPath,
      args: ['-e', script],
      onStderr: (s) => {
        stderrReceived += s
      }
    })

    let exitCode: number | null = null
    const closePromise = new Promise<void>((resolve) => {
      transport.onClose((code) => {
        exitCode = code
        resolve()
      })
    })

    transport.start()
    await closePromise

    expect(exitCode).toBe(1)
    expect(transport.getStderr()).toContain('fatal error: unknown flag')
    expect(stderrReceived).toContain('fatal error: unknown flag')
  })
})

describe('Global ACP adapter sniffing & resolution', () => {
  it('checkGlobalAcpAdapters returns adapter status with install commands', async () => {
    const { checkGlobalAcpAdapters } = await import('../../../src/main/buddy/acp')
    const status = checkGlobalAcpAdapters()

    expect(status).toHaveProperty('claude')
    expect(status).toHaveProperty('codex')
    expect(typeof status.claude.installed).toBe('boolean')
    expect(typeof status.codex.installed).toBe('boolean')
    expect(status.claude.installCommand).toBe('npm install -g @agentclientprotocol/claude-agent-acp')
    expect(status.codex.installCommand).toBe('npm install -g @agentclientprotocol/codex-acp')

    if (status.claude.installed) {
      expect(status.claude.binaryPath).toBeTruthy()
      expect(status.claude.binaryPath).toContain('claude-agent-acp')
    } else {
      expect(status.claude.binaryPath).toBeNull()
    }

    if (status.codex.installed) {
      expect(status.codex.binaryPath).toBeTruthy()
      expect(status.codex.binaryPath).toContain('codex-acp')
    } else {
      expect(status.codex.binaryPath).toBeNull()
    }
  })

  it('resolveAcpBinary resolves known adapters when installed, or falls back to npx', async () => {
    const { resolveAcpBinary, checkGlobalAcpAdapters } = await import('../../../src/main/buddy/acp')
    const status = checkGlobalAcpAdapters()

    // Test claude adapter resolution
    const claudeResolved = resolveAcpBinary('npx', ['-y', '@agentclientprotocol/claude-agent-acp'])
    if (status.claude.installed) {
      expect(claudeResolved.isGlobal).toBe(true)
      expect(claudeResolved.command).toBe(status.claude.binaryPath)
      expect(claudeResolved.args).toEqual([])
    } else {
      expect(claudeResolved.isGlobal).toBe(false)
      expect(claudeResolved.command).toBe('npx')
      expect(claudeResolved.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp'])
    }

    // Test codex adapter resolution
    const codexResolved = resolveAcpBinary('npx', ['-y', '@agentclientprotocol/codex-acp'])
    if (status.codex.installed) {
      expect(codexResolved.isGlobal).toBe(true)
      expect(codexResolved.command).toBe(status.codex.binaryPath)
      expect(codexResolved.args).toEqual([])
    } else {
      expect(codexResolved.isGlobal).toBe(false)
      expect(codexResolved.command).toBe('npx')
      expect(codexResolved.args).toEqual(['-y', '@agentclientprotocol/codex-acp'])
    }

    // Test unknown package falls back untouched
    const unknownResolved = resolveAcpBinary('npx', ['-y', '@unknown/pkg', '--flag'])
    expect(unknownResolved.isGlobal).toBe(false)
    expect(unknownResolved.command).toBe('npx')
    expect(unknownResolved.args).toEqual(['-y', '@unknown/pkg', '--flag'])

    // Test non-npx custom binary
    const customResolved = resolveAcpBinary('/usr/local/bin/custom-agent', ['run'])
    expect(customResolved.isGlobal).toBe(false)
    expect(customResolved.command).toBe('/usr/local/bin/custom-agent')
    expect(customResolved.args).toEqual(['run'])
  })

  it('findGlobalExecutable returns null for non-existent executable', async () => {
    const { findGlobalExecutable } = await import('../../../src/main/buddy/acp')
    const notFound = findGlobalExecutable('non-existent-binary-buddy-test-xyz-987')
    expect(notFound).toBeNull()
  })
})

