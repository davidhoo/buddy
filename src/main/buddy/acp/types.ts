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
  terminal?: {
    runCommand?: boolean
  }
  tools?: {
    customTools?: boolean
  }
}

export interface AcpInitializeParams {
  protocolVersion: string
  clientInfo: AcpClientInfo
  capabilities: AcpClientCapabilities
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
  capabilities: AcpAgentCapabilities
}

/**
 * ACP Session Lifecycle
 */
export interface AcpNewSessionParams {
  cwd: string
  mcpServers?: Array<{ name: string; command: string; args?: string[] }>
  systemPrompt?: string
}

export interface AcpNewSessionResult {
  sessionId: string
}

export interface AcpLoadSessionParams {
  sessionId: string
  cwd: string
}

export interface AcpLoadSessionResult {
  sessionId: string
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
  prompt: string
  tools?: AcpToolDefinition[]
}

export interface AcpPromptResult {
  status: 'completed' | 'cancelled' | 'error'
  stopReason?: string
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
