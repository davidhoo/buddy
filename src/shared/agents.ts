import type { Launcher } from './types'
export interface AgentRecipe {
  id: string; name: string; command: string; aliases?: string[]; npm?: string; brew?: string; app?: string
  acp?: string[]; adapter?: string; modelFlag?: string
}
export const AGENT_RECIPES: AgentRecipe[] = [
  { id:'claude', name:'Claude Code', command:'claude', npm:'@anthropic-ai/claude-code', brew:'claude-code', adapter:'claude-agent-acp', modelFlag:'--model' },
  { id:'codex', name:'Codex', command:'codex', npm:'@openai/codex', brew:'codex', app:'Codex', adapter:'codex-acp', modelFlag:'--model' },
  { id:'cursor', name:'Cursor CLI', command:'cursor-agent', aliases:['agent'], acp:['acp'], modelFlag:'--model' },
  { id:'agy', name:'Antigravity CLI', command:'agy', aliases:['antigravity'], modelFlag:'--model' },
  { id:'opencode', name:'OpenCode', command:'opencode', npm:'opencode-ai', brew:'opencode', acp:['acp'], modelFlag:'--model' },
  { id:'kimi', name:'Kimi Code', command:'kimi', modelFlag:'--model' },
  { id:'dsh', name:'DeepSeek Harness', command:'dsh', npm:'@deepseek-ai/dsh', app:'DeepSeek Harness', acp:['acp'], modelFlag:'--model' },
  { id:'wecode_claude', name:'WeCode Claude', command:'wecode', adapter:'claude-agent-acp', modelFlag:'--model' },
  { id:'wecode_codex', name:'WeCode Codex', command:'wecode codex', adapter:'codex-acp', modelFlag:'--model' },
  { id:'wecode_opencode', name:'WeCode OpenCode', command:'wecode opencode', acp:['opencode','acp'], modelFlag:'--model' },
  { id:'codebuddy', name:'CodeBuddy', command:'codebuddy', acp:['--acp'], npm:'@tencent-ai/codebuddy-code', modelFlag:'--model' },
  { id:'gemini', name:'Gemini CLI', command:'gemini', npm:'@google/gemini-cli', brew:'gemini-cli', acp:['--experimental-acp'], modelFlag:'--model' },
  { id:'claude_desktop', name:'Claude Desktop', command:'', app:'Claude' },
  { id:'zed', name:'Zed', command:'', app:'Zed' },
  { id:'vscode', name:'VS Code', command:'', app:'Visual Studio Code' },
  { id:'workbuddy', name:'WorkBuddy', command:'', app:'WorkBuddy' }
]
export interface AgentConfiguration {
  contract?: boolean
  enabled?: boolean
  protocol?: 'cli' | 'acp'
  cli?: Launcher
  acp?: Launcher
}
export interface LocalAgent {
  id: string; installationId: string; name: string; path: string; realPath: string; version?: string; appVersion?: string
  source: 'npm' | 'pnpm' | 'bun' | 'brew' | 'uv' | 'pipx' | 'self' | 'unknown'
  prefix?: string; manager?: string; package?: string; selectedProtocol?: 'cli'|'acp'
  runnable: boolean; enabled: boolean; error?: string
  cli?: Launcher; acp?: Launcher; modelFlag?: string
  installations?: Array<{id:string;path:string;realPath:string;version?:string}>
  automaticCli?: Launcher
  automaticAcp?: Launcher
  latest?: string; updateError?: string; checkedAt?: string
  nativeUpdate?: { command: string; args: string[]; versionArgs: string[]; version: string; target: 'agent' | 'wecode' }
  acpError?:string
  acpStatus?: 'verified' | 'unverified' | 'missing' | 'incompatible' | 'failed'
}
export interface AgentUpdateJob { id: string; agentId: string; status: 'queued'|'updating'|'verifying'|'success'|'failed'|'skipped'|'cancelled'|'interrupted'; before?: string; after?: string; error?: string }

export function isNewerStableVersion(a: string, b: string): boolean {
  const parse = (v: string) => /^(?:v)?(\d+)\.(\d+)\.(\d+)$/.exec(v)
  const x = parse(a), y = parse(b)
  if (!x || !y) return false
  for(let i=1;i<4;i++) { if(+x[i] !== +y[i]) return +x[i] > +y[i] }
  return false
}

/** Transport changes need fresh discovery; model/default/enable changes do not. */
export function agentLaunchChanged(agent: LocalAgent, config: AgentConfiguration): boolean {
  const key = (launcher?: Launcher) => JSON.stringify([launcher?.command, launcher?.args ?? [], Object.entries(launcher?.env ?? {}).sort(([a], [b]) => a.localeCompare(b))])
  return (config.cli !== undefined && key(config.cli) !== key(agent.cli)) ||
    (config.acp !== undefined && key(config.acp) !== key(agent.acp))
}

export function applyAgentConfiguration(agent: LocalAgent, config: AgentConfiguration): LocalAgent {
  return {
    ...agent,
    enabled: config.enabled ?? agent.enabled,
    selectedProtocol: config.protocol ?? agent.selectedProtocol,
    cli: config.cli ?? agent.cli,
    acp: config.acp ?? agent.acp
  }
}

export interface AgentInventorySnapshot {
  revision: number
  agents: LocalAgent[]
  scannedAt?: string
  refreshing: boolean
  error?: string
}
export type AgentUpdateItemStatus = 'queued' | 'preparing' | 'installing' | 'verifying' | 'updated' | 'up_to_date' | 'failed' | 'skipped' | 'cancelled' | 'interrupted'
export interface AgentUpdateItem {
  id: string
  agentId: string
  name: string
  installationId?: string
  targetKey?: string
  target?: 'agent' | 'wecode'
  source?: LocalAgent['source']
  status: AgentUpdateItemStatus
  before?: string
  after?: string
  startedAt?: string
  finishedAt?: string
  error?: string
  process?: { pid: number; started: string; command: string }
}
export interface AgentUpdateBatch {
  id: string
  requestId: string
  createdAt?: string
  finishedAt?: string
  status: 'queued' | 'preparing' | 'waiting' | 'running' | 'cancelling' | 'completed' | 'interrupted'
  cancelRequested: boolean
  items: AgentUpdateItem[]
  error?: string
}
export interface AgentUpdateSnapshot {
  schemaVersion: 2
  revision: number
  activeBatch?: AgentUpdateBatch
  lastCompletedBatch?: AgentUpdateBatch
}
export const isAgentUpdateTerminal = (status: AgentUpdateItemStatus) => !['queued', 'preparing', 'installing', 'verifying'].includes(status)
export function agentUpdateCounts(batch: AgentUpdateBatch) {
  const count = (status: AgentUpdateItemStatus) => batch.items.filter(item => item.status === status).length
  return { total: batch.items.length, processed: batch.items.filter(item => isAgentUpdateTerminal(item.status)).length,
    updated: count('updated'), upToDate: count('up_to_date'), failed: count('failed') + count('interrupted'), cancelled: count('cancelled'), skipped: count('skipped') }
}
