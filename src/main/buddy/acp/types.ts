/**
 * JSON-RPC 2.0 Base Specifications
 */
export interface JsonRpcRequest<T = unknown> {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: T
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0'
  id: string | number
  result?: T
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export interface JsonRpcNotification<T = unknown> {
  jsonrpc: '2.0'
  method: string
  params?: T
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

export function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  return typeof msg === 'object' && msg !== null && 'method' in msg && 'id' in msg
}

export function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
  return typeof msg === 'object' && msg !== null && 'id' in msg && ('result' in msg || 'error' in msg)
}

export function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
  return typeof msg === 'object' && msg !== null && 'method' in msg && !('id' in msg)
}

/**
 * ACP Protocol Initialize Handshake
 */
export interface AcpClientInfo {
  name: string
  version: string
}

export interface AcpClientCapabilities {
  fs?: {
    readTextFile?: boolean
    writeTextFile?: boolean
  }
  terminal?: boolean
  [key: string]: unknown
}

export interface AcpInitializeParams {
  protocolVersion: number | string
  clientInfo: AcpClientInfo
  clientCapabilities?: AcpClientCapabilities
  capabilities?: AcpClientCapabilities
  _meta?: Record<string, unknown>
}

export interface AcpAgentInfo {
  name: string
  version: string
  title?: string
  description?: string
}

export interface AcpAgentCapabilities {
  streaming?: boolean
  tools?: boolean
  slashCommands?: string[]
}

export interface AcpInitializeResult {
  protocolVersion: string | number
  agentInfo?: AcpAgentInfo
  serverInfo?: AcpAgentInfo
  capabilities?: AcpAgentCapabilities
  agentCapabilities?: Record<string, unknown>
  authMethods?: unknown[]
  [key: string]: unknown
}

/**
 * ACP Content Block structure for prompt turns
 */
export type AcpContentBlock =
  | { type: 'text'; text: string; [key: string]: unknown }
  | { type: 'image'; data: string; mimeType: string; [key: string]: unknown }
  | { type: 'audio'; data: string; mimeType: string; [key: string]: unknown }
  | { type: 'resource'; resource: unknown; [key: string]: unknown }
  | { type: 'resource_link'; uri: string; [key: string]: unknown }

/**
 * ACP Session Lifecycle
 */
export interface AcpNewSessionParams {
  cwd: string
  mcpServers?: Array<unknown>
  systemPrompt?: string
  additionalDirectories?: string[]
  _meta?: Record<string, unknown>
}

export interface AcpNewSessionResult {
  sessionId: string
  modes?: {
    currentModeId: string
    availableModes: Array<{ id: string; name: string; description?: string }>
  }
  configOptions?: Array<unknown>
  [key: string]: unknown
}

export interface AcpLoadSessionParams {
  sessionId: string
  cwd: string
  mcpServers?: Array<unknown>
  additionalDirectories?: string[]
  _meta?: Record<string, unknown>
}

export interface AcpLoadSessionResult {
  sessionId: string
  [key: string]: unknown
}

/**
 * ACP Prompt & Streaming Notifications
 */
export interface AcpToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface AcpPromptParams {
  sessionId: string
  prompt: string | AcpContentBlock[]
  tools?: AcpToolDefinition[]
  _meta?: Record<string, unknown>
}

export interface AcpPromptResult {
  status?: 'completed' | 'cancelled' | 'error' | string
  stopReason?: string
  usage?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

/**
 * Streaming Events emitted by the ACP Agent during a prompt
 */
export type AcpStreamNotification =
  | { type: 'content_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; result: unknown; isError?: boolean }
  | { type: 'session_break'; reason?: string }
  | { type: 'error'; message: string }
