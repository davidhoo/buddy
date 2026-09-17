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

  // Helper to simulate incoming server message
  simulateMessage(msg: JsonRpcMessage): void {
    for (const handler of this.messageHandlers) {
      handler(msg)
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

  it('creates and resumes sessions', async () => {
    const transport = new MockAcpTransport()
    const client = new AcpClient(transport)

    // 1. new session
    const newSessionPromise = client.newSession({ cwd: '/test/repo' })
    const req1 = transport.sentMessages[0] as JsonRpcRequest
    expect(req1.method).toBe('session/new')

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

    transport.simulateMessage({
      jsonrpc: '2.0',
      id: req2.id,
      result: { sessionId: 'sess_12345' }
    })
    const loadRes = await loadSessionPromise
    expect(loadRes.sessionId).toBe('sess_12345')
  })

  it('streams content and thinking deltas', async () => {
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

    // Simulate thinking notifications
    transport.simulateMessage({
      jsonrpc: '2.0',
      method: 'session/thinkingDelta',
      params: { thinking: 'Let me think...' }
    })

    // Simulate content notifications
    transport.simulateMessage({
      jsonrpc: '2.0',
      method: 'session/contentDelta',
      params: { text: 'Hello ' }
    })
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
    expect(thinkingDeltas).toEqual(['Let me think...'])
    expect(contentDeltas).toEqual(['Hello ', 'world!'])
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
})

