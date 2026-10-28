/** Extension library types. Skill and MCP assignment can write links; other kinds stay read-only. */

export const LIBRARY_SECTIONS = ['agents', 'instructions', 'mcp', 'skills', 'hooks', 'subagents'] as const
export type LibrarySection = (typeof LIBRARY_SECTIONS)[number]

export type ExtensionKind = 'skill' | 'mcp' | 'instruction' | 'hook' | 'subagent'
export type ExtensionAdapter = 'claude' | 'codex' | 'opencode' | 'cursor' | 'agy' | 'kimi' | 'dsh' | 'unrecognized'
export type ExtensionProtocol = 'cli' | 'acp'
export type ExtensionScope = 'user' | 'project' | 'plugin' | 'shared'
export type ScanStatus = 'ok' | 'empty' | 'uninitialized' | 'read_failed' | 'partial' | 'unsupported' | 'unrecognized'
export type AssignBlock = 'none' | 'unsupported' | 'unrecognized' | 'uninitialized' | 'read_failed'
export type TargetResolution = 'ready' | 'unrecognized' | 'unsupported'
export type DiscoveryMethod = 'filesystem' | 'unsupported' | 'none'
export type LocationKind = 'skills' | 'mcp' | 'instructions' | 'subagents' | 'hooks' | 'execution_env'
export type MissingMeans = 'uninitialized' | 'empty' | 'ignore' | 'read_failed'

export type TargetNote =
  | 'acp_codex_home'
  | 'program_differs_from_actor'
  | 'wecode_family_unverified'
  | 'desktop_skills_not_attributed'
  | 'assign_not_ready'
  | 'execution_env_not_scanned'

export type LocationNote = 'acp_private_uninitialized' | 'execution_env_not_scanned' | 'desktop_skills_not_attributed'

export type ScanProblemCode =
  | 'uninitialized'
  | 'read_failed'
  | 'broken_link'
  | 'parse_failed'
  | 'truncated'
  | 'too_large'
  | 'not_directory'
  | 'stat_failed'

export interface ExtensionQuery {
  kind?: 'skill' | 'mcp'
  cwd?: string
  taskId?: string
  workspaceKey?: string
}

export interface ConfigLocation {
  id: string
  path: string
  kind: LocationKind
  scope: ExtensionScope
  exists: boolean
  isDirectory: boolean
  linkSource: string | null
  scan: boolean
  missingMeans: MissingMeans
  error?: ScanProblemCode
  note?: LocationNote
}

export interface ResolvedTarget {
  actor: string
  protocol: ExtensionProtocol
  adapter: ExtensionAdapter
  command: string
  args: string[]
  cwd: string
  fingerprint: string
  resolution: TargetResolution
  discovery: DiscoveryMethod
  envKeys: string[]
  versionStatus: 'not_probed'
  /** False means discover may scan files, but import/assign must not rewrite native config. */
  writesNativeConfig: boolean
  locations: ConfigLocation[]
  notes: TargetNote[]
}

export interface ScanProblem {
  code: ScanProblemCode
  path: string
}

export interface DiscoveredInstance {
  id: string
  shareKey: string
  kind: 'skill' | 'mcp'
  name: string
  description: string
  actor: string
  scope: ExtensionScope
  path: string
  realpath: string
  linkSource: string | null
  nativeKey: string | null
  ownership: 'user' | 'plugin' | 'shared'
  readOnly: boolean
  contentHash: string | null
  envKeys: string[]
  sharedWith: string[]
}

export interface TargetScan {
  actor: string
  adapter: ExtensionAdapter
  fingerprint: string
  status: ScanStatus
  method: 'filesystem_fallback' | 'none'
  completeness: 'filesystem_partial' | 'not_applicable'
  problems: ScanProblem[]
  instances: DiscoveredInstance[]
  notes: TargetNote[]
  assignBlock: AssignBlock
}

export interface LibraryItem {
  repositoryPath?: string
  repositoryRef?: string
  treeHash?: string
  updateAvailable?: string | null
  locallyEdited?: boolean
  id: string
  kind: ExtensionKind
  name: string
  description: string
  originActor: string
  originPath: string
  shareKey: string | null
  repository: string | null
  pluginId: string | null
  version: string | null
  contentHash: string | null
  libraryPath: string | null
  externalPath: string | null
  createdAt: string
  updatedAt: string
}

export interface TargetBinding {
  id: string
  libraryItemId: string
  actor: string
  targetFingerprint: string
  scope: 'user' | 'project'
  nativePath: string | null
  nativeId: string | null
  desired: 'on' | 'off'
  observed: string
  /** Content hash of what Buddy last wrote (subagent file or hook entry). */
  appliedVersion: string | null
  /** Exact hook entry JSON Buddy wrote, used for safe revoke. */
  appliedEntry: string | null
  shareKey: string | null
  management: 'link' | 'copy' | 'reference' | 'none'
}

export interface ApplyRecord {
  id: string
  at: string
  action: string
  libraryItemId: string | null
  summary: string
  results: Array<{ actor: string; status: 'changed' | 'skipped' | 'failed'; message: string }>
}

export interface LibraryData {
  skillDefaultMode?: SkillAssignMode
  skillAgentModes?: Record<string, SkillAssignMode>
  version: 1
  items: LibraryItem[]
  bindings: TargetBinding[]
  records: ApplyRecord[]
}

export type LibraryReadStatus = 'absent' | 'empty' | 'ok' | 'read_failed'

export interface LibrarySnapshot extends LibraryData {
  status: LibraryReadStatus
  dir: string
  contentDir: string
  backupDir: string
}

export interface ExtensionPage {
  copyDifferences?: Array<{ libraryItemId: string; actor: string }>
  kind: 'skill' | 'mcp'
  cwd: string
  cwdRejected: boolean
  readOnly: true
  generatedAt: string
  targets: TargetScan[]
  library: LibrarySnapshot
  found: DiscoveredInstance[]
}

export type ExtensionActionName = 'import' | 'import_all' | 'find' | 'assign' | 'remove' | 'probe' | 'save' | 'read' | 'sync' | 'skill_mode' | 'check_updates' | 'update'
export type SkillAssignMode = 'link' | 'copy'

export interface ExtensionActionRequest {
  action: ExtensionActionName
  kind?: 'skill' | 'mcp' | 'instruction' | 'subagent' | 'hook'
  instanceId?: string
  instanceIds?: string[]
  libraryItemId?: string
  actor?: string
  desired?: 'on' | 'off'
  /** Skill assign: prefer managed copy; symlink_failed also falls back to copy. */
  mode?: SkillAssignMode
  inherit?: boolean
  replace?: boolean
  source?: string
  name?: string
  description?: string
  content?: string
  event?: string
  matcher?: string
  command?: string
  timeoutSeconds?: number
  cwd?: string
  taskId?: string
  workspaceKey?: string
}

export interface ExtensionActionResult {
  accepted: boolean
  code: 'ok' | 'unknown_action' | 'missing_target' | 'find_not_ready' | 'library_unreadable'
  results: Array<{
    actor: string
    status: 'changed' | 'skipped' | 'failed'
    code: string
    libraryItemId: string | null
  }>
  found?: DiscoveredInstance[]
  tools?: string[]
  content?: string
  name?: string
  copyDifferences?: Array<{ libraryItemId: string; actor: string }>
}

export interface ExtensionLibraryDir {
  dir: string
  contentDir: string
  backupDir: string
  backupCount: number
}

/** True when an Agent-found row may be imported into the library (not plugin-owned / read-only). */
export function isImportableFoundInstance(item: Pick<DiscoveredInstance, 'readOnly' | 'ownership' | 'scope'>): boolean {
  if (item.readOnly) return false
  if (item.ownership === 'plugin' || item.scope === 'plugin') return false
  return true
}
