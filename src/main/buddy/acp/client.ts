import type { AcpTransport } from './transport'
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type AcpInitializeParams,
  type AcpInitializeResult,
  type AcpLoadSessionParams,
  type AcpLoadSessionResult,
  type AcpNewSessionParams,
  type AcpNewSessionResult,
  type AcpPromptParams,
  type AcpPromptResult,
  type AcpToolDefinition,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse
} from './types'

export interface AcpPromptHandlers {
  onContentDelta?: (text: string) => void
  onThinkingDelta?: (thinking: string) => void
  onToolCall?: (id: string, name: string, input: Record<string, unknown>) => void
  onToolResult?: (id: string, result: unknown, isError?: boolean) => void
  onBreak?: (reason?: string) => void
  /**
   * Optional custom tool executor for host-provided tools
   */
  onExecuteTool?: (name: string, input: Record<string, unknown>) => Promise<unknown>
}

export interface AcpClientOptions {
  timeoutMs?: number
  clientInfo?: {
    name: string
    version: string
  }
}

export class AcpClient {
  private nextId = 1
  private readonly pendingRequests = new Map<
    string | number,
    {
      resolve: (result: any) => void
      reject: (err: Error) => void
      timer: NodeJS.Timeout
    }
  >()
  private activePromptHandlers: AcpPromptHandlers | null = null
  private readonly unsubscribeTransport: () => void

  constructor(
    private readonly transport: AcpTransport,
    private readonly options: AcpClientOptions = {}
  ) {
    this.unsubscribeTransport = this.transport.onMessage((msg) => this.handleMessage(msg))
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (isJsonRpcResponse(msg)) {
      const pending = this.pendingRequests.get(msg.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete(msg.id)
        if (msg.error) {
          pending.reject(new Error(`ACP Error ${msg.error.code}: ${msg.error.message}`))
        } else {
          pending.resolve(msg.result)
        }
      }
      return
    }

    if (isJsonRpcNotification(msg)) {
      this.handleNotification(msg.method, msg.params)
      return
    }

    if (isJsonRpcRequest(msg)) {
      this.handleHostRequest(msg)
      return
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const handlers = this.activePromptHandlers
    if (!handlers) return

    const data = params as Record<string, unknown> | undefined

    switch (method) {
      case 'session/contentDelta':
      case 'content_delta':
        if (typeof data?.text === 'string') {
          handlers.onContentDelta?.(data.text)
        }
        break

      case 'session/thinkingDelta':
      case 'thinking_delta':
        if (typeof data?.thinking === 'string') {
          handlers.onThinkingDelta?.(data.thinking)
        }
        break

      case 'session/toolCall':
      case 'tool_call':
        if (typeof data?.id === 'string' && typeof data?.name === 'string') {
          handlers.onToolCall?.(data.id, data.name, (data.input as Record<string, unknown>) ?? {})
        }
        break

      case 'session/toolResult':
      case 'tool_result':
        if (typeof data?.id === 'string') {
          handlers.onToolResult?.(data.id, data.result, Boolean(data.isError))
        }
        break

      case 'session/break':
        handlers.onBreak?.(typeof data?.reason === 'string' ? data.reason : undefined)
        break

      case 'session/update':
        // Generic session update container supported by Zed / standard ACP
        if (data?.delta && typeof data.delta === 'object') {
          const delta = data.delta as Record<string, unknown>
          if (typeof delta.text === 'string') handlers.onContentDelta?.(delta.text)
          if (typeof delta.thinking === 'string') handlers.onThinkingDelta?.(delta.thinking)
        }
        break
    }
  }

  private async handleHostRequest(req: JsonRpcRequest): Promise<void> {
    const method = req.method
    const params = (req.params ?? {}) as Record<string, unknown>

    try {
      if (method === 'tools/call' || method === 'session/callTool') {
        const toolName = String(params.name ?? '')
        const toolInput = (params.input ?? {}) as Record<string, unknown>

        // Built-in handling for Buddy Dual-Break proposal tool
        if (toolName === 'buddy_propose_break') {
          const reason = typeof toolInput.reason === 'string' ? toolInput.reason : undefined
          this.activePromptHandlers?.onBreak?.(reason)
          await this.sendResponse(req.id, {
            status: 'success',
            message: 'Break proposal recorded by Buddy'
          })
          return
        }

        if (this.activePromptHandlers?.onExecuteTool) {
          const result = await this.activePromptHandlers.onExecuteTool(toolName, toolInput)
          await this.sendResponse(req.id, { result })
          return
        }

        await this.sendError(req.id, -32601, `Tool not found: ${toolName}`)
        return
      }

      // Default unrecognized request
      await this.sendError(req.id, -32601, `Method not supported: ${method}`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await this.sendError(req.id, -32000, errMsg)
    }
  }

  private async sendResponse(id: string | number, result: unknown): Promise<void> {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result
    }
    await this.transport.send(response)
  }

  private async sendError(id: string | number, code: number, message: string): Promise<void> {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message }
    }
    await this.transport.send(response)
  }

  async request<TResult = unknown, TParams = unknown>(
    method: string,
    params?: TParams,
    timeoutMs?: number
  ): Promise<TResult> {
    const id = this.nextId++
    const request: JsonRpcRequest<TParams> = {
      jsonrpc: '2.0',
      id,
      method,
      params
    }

    const effectiveTimeout = timeoutMs ?? this.options.timeoutMs ?? 60000

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`ACP Request timeout after ${effectiveTimeout}ms for method ${method}`))
      }, effectiveTimeout)

      this.pendingRequests.set(id, { resolve, reject, timer })
      this.transport.send(request).catch((err) => {
        clearTimeout(timer)
        this.pendingRequests.delete(id)
        reject(err)
      })
    })
  }

  /**
   * Perform handshake with the ACP Agent
   */
  async initialize(customParams?: Partial<AcpInitializeParams>): Promise<AcpInitializeResult> {
    const params: AcpInitializeParams = {
      protocolVersion: '1.0',
      clientInfo: this.options.clientInfo ?? { name: 'buddy', version: '1.0.0' },
      capabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: { runCommand: true },
        tools: { customTools: true }
      },
      ...customParams
    }
    return this.request<AcpInitializeResult>('initialize', params)
  }

  /**
   * Create a new session in the ACP Agent
   */
  async newSession(params: AcpNewSessionParams): Promise<AcpNewSessionResult> {
    return this.request<AcpNewSessionResult>('session/new', params)
  }

  /**
   * Load an existing session in the ACP Agent
   */
  async loadSession(params: AcpLoadSessionParams): Promise<AcpLoadSessionResult> {
    return this.request<AcpLoadSessionResult>('session/load', params)
  }

  /**
   * Send a prompt to the agent, providing the buddy_propose_break tool and streaming notifications
   */
  async prompt(params: AcpPromptParams, handlers?: AcpPromptHandlers): Promise<AcpPromptResult> {
    this.activePromptHandlers = handlers ?? null

    const breakTool: AcpToolDefinition = {
      name: 'buddy_propose_break',
      description:
        'Call this tool when you believe the task is complete, verified, or ready for reviewer break confirmation.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Detailed reason why you propose breaking/completing the task' }
        },
        required: ['reason']
      }
    }

    const augmentedTools = [...(params.tools ?? []), breakTool]

    try {
      return await this.request<AcpPromptResult>('session/prompt', {
        ...params,
        tools: augmentedTools
      })
    } finally {
      this.activePromptHandlers = null
    }
  }

  /**
   * Cancel an ongoing session prompt
   */
  async cancel(sessionId: string): Promise<void> {
    await this.request('session/cancel', { sessionId })
  }

  /**
   * Clean up client resources and close underlying transport
   */
  async close(): Promise<void> {
    this.unsubscribeTransport()
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('ACP Client closed'))
      this.pendingRequests.delete(id)
    }
    await this.transport.close()
  }
}
