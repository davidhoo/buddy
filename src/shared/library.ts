/** Shared Skills / MCP library types (Magpie-port semantics). */

export type LibraryScope = 'user' | 'project'
export type LibraryConfigContext = 'native' | 'buddy-acp' | 'wecode'
export type McpTransport = 'stdio' | 'http' | 'sse' | 'unknown'
export type SkillImportMode = 'migrate-link' | 'external-ref' | 'copy' | 'shared-ref'
export type AuthProbeStatus = 'signed-in' | 'not-found' | 'unknown'
export type LibraryOpStatus = 'ok' | 'exists' | 'conflict' | 'failed' | 'rejected'

export interface LibraryCapabilities {
  readSkills: boolean
  writeSkills: boolean
  readMcp: boolean
  writeMcp: boolean
  authProbe: boolean
  diagnose: boolean
  reason?: string
}

export interface LibraryTarget {
  targetId: string
  agentId: string
  displayName: string
  configContext: LibraryConfigContext
  scope: LibraryScope
  projectPath?: string
  skillsDir?: string
  skillsPhysicalKey?: string
  mcpPath?: string
  mcpPhysicalKey?: string
  mcpFormat: 'jsonc-mcpServers' | 'toml-mcp_servers' | 'unsupported'
  capabilities: LibraryCapabilities
  /** True when ACP home is not on disk yet (scan must not create it). */
  pendingInit?: boolean
  /** Other targetIds that share the same skills physicalKey. */
  linkedSkillTargetIds?: string[]
  /** Shown when this target is the one Buddy tasks use. */
  usedByTasks?: boolean
}

export interface LibrarySkillRecord {
  id: string
  name: string
  description?: string
  libraryPath: string
  sourceKind: 'migrated' | 'external' | 'shared' | 'copy'
  originPath?: string
  contentHash?: string
  assignedTargetIds: string[]
  importMode: SkillImportMode
  managed: boolean
}

export interface DiscoveredSkill {
  discoveryId: string
  name: string
  description?: string
  path: string
  physicalKey: string
  targetId: string
  agentId: string
  scope: LibraryScope
  isSymlink: boolean
  isGitRoot: boolean
  alreadyImported: boolean
  importBlockedReason?: string
}

export interface LibraryMcpServer {
  id: string
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  /** Non-secret summary fields only. */
  summary: string
  raw: Record<string, unknown>
  sourceTargetId?: string
  scope: LibraryScope
  assignedTargetIds: string[]
  managed: boolean
}

export interface DiscoveredMcpServer {
  discoveryId: string
  name: string
  transport: McpTransport
  summary: string
  targetId: string
  agentId: string
  scope: LibraryScope
  path: string
  physicalKey: string
  alreadyImported: boolean
  raw: Record<string, unknown>
}

export interface TargetAuthStatus {
  targetId: string
  serverName: string
  status: AuthProbeStatus
  detail?: string
}

export interface LibrarySnapshot {
  schemaVersion: 1
  scannedAt?: string
  refreshing: boolean
  targets: LibraryTarget[]
  skills: LibrarySkillRecord[]
  discoveredSkills: DiscoveredSkill[]
  servers: LibraryMcpServer[]
  discoveredServers: DiscoveredMcpServer[]
  auth: TargetAuthStatus[]
  error?: string
}

export interface LibraryOpResult {
  status: LibraryOpStatus
  id?: string
  name?: string
  message?: string
  affectedTargetIds?: string[]
}

export interface LibraryBatchResult {
  results: LibraryOpResult[]
}

export interface LibraryMetaFile {
  schemaVersion: 1
  skills: LibrarySkillRecord[]
  servers: LibraryMcpServer[]
  applied: Record<string, { kind: 'skill' | 'mcp'; fingerprint: string; path: string; at: string }>
}
