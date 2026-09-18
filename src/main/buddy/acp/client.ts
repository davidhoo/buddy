import type { AcpTransport } from './transport'
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type AcpContentBlock,
  type AcpClientCapabilities,
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
  private readonly unsubscribeClose: () => void
  private readonly unsubscribeError: () => void

  constructor(
    private readonly transport: AcpTransport,
    private readonly options: AcpClientOptions = {}
  ) {
    this.unsubscribeTransport = this.transport.onMessage((msg) => this.handleMessage(msg))
    this.unsubscribeClose = this.transport.onClose((code, signal) => {
      const stderr = this.transport.getStderr?.()?.trim()
      const exitDesc = code !== null ? `code ${code}` : signal !== null ? `signal ${signal}` : 'unknown reason'
      const reason = stderr
        ? `Process exited with ${exitDesc}: ${stderr}`
        : `Process exited unexpectedly with ${exitDesc}`
      this.rejectAllPending(new Error(reason))
    })
    this.unsubscribeError = this.transport.onError((err) => {
      this.rejectAllPending(err)
    })
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer)
      pending.reject(err)
      this.pendingRequests.delete(id)
    }
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

      case 'session/update': {
        const update = (data?.update ?? data) as Record<string, unknown> | undefined
        if (!update) break

        const sessionUpdate = update.sessionUpdate

        if (sessionUpdate === 'agent_message_chunk' || sessionUpdate === 'content_chunk') {
          const content = update.content as Record<string, unknown> | undefined
          if (content && typeof content.text === 'string') {
            handlers.onContentDelta?.(content.text)
          } else if (typeof update.text === 'string') {
            handlers.onContentDelta?.(update.text)
          }
        } else if (sessionUpdate === 'agent_thought_chunk') {
          const content = update.content as Record<string, unknown> | undefined
          if (content && typeof content.text === 'string') {
            handlers.onThinkingDelta?.(content.text)
          } else if (typeof update.thinking === 'string') {
            handlers.onThinkingDelta?.(update.thinking)
          }
        } else if (sessionUpdate === 'tool_call') {
          const toolCallId = String(update.toolCallId ?? update.id ?? '')
          const name = String(update.name ?? update.title ?? 'tool')
          const input = (update.rawInput ?? update.input ?? {}) as Record<string, unknown>
          handlers.onToolCall?.(toolCallId, name, input)
        } else if (sessionUpdate === 'tool_call_update') {
          const toolCallId = String(update.toolCallId ?? update.id ?? '')
          const content = update.content
          const status = update.status
          if (status === 'completed' || status === 'error') {
            handlers.onToolResult?.(toolCallId, content, status === 'error')
          }
        }

        // Generic fallback for custom delta format
        if (data?.delta && typeof data.delta === 'object') {
          const delta = data.delta as Record<string, unknown>
          if (typeof delta.text === 'string') handlers.onContentDelta?.(delta.text)
          if (typeof delta.thinking === 'string') handlers.onThinkingDelta?.(delta.thinking)
        }
        break
      }
    }
  }

  private async handleHostRequest(req: JsonRpcRequest): Promise<void> {
    const method = req.method
    const params = (req.params ?? {}) as Record<string, unknown>

    try {
      if (method === 'session/request_permission' || method === 'session/requestPermission') {
        const options = (params.options ?? []) as Array<{ optionId: string; kind?: string }>
        const allowed =
          options.find((opt) => opt.kind === 'allow_always') ??
          options.find((opt) => opt.kind === 'allow_once') ??
          options[0]

        if (allowed) {
          await this.sendResponse(req.id, {
            outcome: {
              outcome: 'selected',
              optionId: allowed.optionId
            }
          })
        } else {
          await this.sendResponse(req.id, {
            outcome: {
              outcome: 'cancelled'
            }
          })
        }
        return
      }

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
    const clientCapabilities: AcpClientCapabilities = {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true
    }
    const params: AcpInitializeParams = {
      protocolVersion: 1,
      clientInfo: this.options.clientInfo ?? { name: 'buddy', version: '1.0.0' },
      clientCapabilities,
      capabilities: clientCapabilities,
      ...customParams
    }
    return this.request<AcpInitializeResult>('initialize', params)
  }

  /**
   * Create a new session in the ACP Agent
   */
  async newSession(params: AcpNewSessionParams): Promise<AcpNewSessionResult> {
    const payload = {
      ...params,
      mcpServers: params.mcpServers ?? []
    }
    return this.request<AcpNewSessionResult>('session/new', payload)
  }

  /**
   * Load an existing session in the ACP Agent
   */
  async loadSession(params: AcpLoadSessionParams): Promise<AcpLoadSessionResult> {
    const payload = {
      ...params,
      mcpServers: params.mcpServers ?? []
    }
    return this.request<AcpLoadSessionResult>('session/load', payload)
  }

  /**
   * Set session mode (e.g. bypassPermissions, acceptEdits)
   */
  async setSessionMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.request('session/set_mode', { sessionId, modeId })
  }

  /**
   * Send a prompt to the agent, providing the buddy_propose_break tool and streaming notifications
   */
  async prompt(params: AcpPromptParams, handlers?: AcpPromptHandlers): Promise<AcpPromptResult> {
    this.activePromptHandlers = handlers ?? null

    const promptBlocks: AcpContentBlock[] = Array.isArray(params.prompt)
      ? params.prompt
      : [{ type: 'text', text: params.prompt }]

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
        sessionId: params.sessionId,
        prompt: promptBlocks,
        tools: augmentedTools,
        ...(params._meta ? { _meta: params._meta } : {})
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
    this.unsubscribeClose()
    this.unsubscribeError()
    this.rejectAllPending(new Error('ACP Client closed'))
    await this.transport.close()
  }
}
