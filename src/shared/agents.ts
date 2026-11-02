import type { Launcher } from './types'
export interface AgentRecipe {
  id: string; name: string; command: string; aliases?: string[]; npm?: string; brew?: string; app?: string
  /** Known relative CLI paths inside the macOS .app bundle (not recursive guesses). */
  appCli?: string[]
  acp?: string[]; adapter?: string; modelFlag?: string
}
export const AGENT_RECIPES: AgentRecipe[] = [
  { id:'claude', name:'Claude Code', command:'claude', npm:'@anthropic-ai/claude-code', brew:'claude-code', adapter:'claude-agent-acp', modelFlag:'--model' },
  { id:'codex', name:'Codex', command:'codex', npm:'@openai/codex', brew:'codex', app:'Codex', appCli:['Contents/Resources/codex', 'Contents/MacOS/codex'], adapter:'codex-acp', modelFlag:'--model' },
  { id:'cursor', name:'Cursor CLI', command:'cursor-agent', aliases:['agent'], acp:['acp'], modelFlag:'--model' },
  { id:'agy', name:'Antigravity CLI', command:'agy', aliases:['antigravity'], modelFlag:'--model' },
  { id:'opencode', name:'OpenCode', command:'opencode', npm:'opencode-ai', brew:'opencode', acp:['acp'], modelFlag:'--model' },
  { id:'kimi', name:'Kimi Code', command:'kimi', modelFlag:'--model' },
  { id:'dsh', name:'DeepSeek Harness', command:'dsh', npm:'@deepseek-ai/dsh', app:'DeepSeek Harness', appCli:['Contents/Resources/dsh', 'Contents/MacOS/dsh'], acp:['acp'], modelFlag:'--model' },
  { id:'wecode_claude', name:'WeCode Claude', command:'wecode', adapter:'claude-agent-acp', modelFlag:'--model' },
  { id:'wecode_codex', name:'WeCode Codex', command:'wecode codex', adapter:'codex-acp', modelFlag:'--model' },
  { id:'wecode_opencode', name:'WeCode OpenCode', command:'wecode opencode', acp:['opencode','acp'], modelFlag:'--model' },
  { id:'codebuddy', name:'CodeBuddy', command:'codebuddy', aliases:['cbc'], acp:['--acp'], npm:'@tencent-ai/codebuddy-code', modelFlag:'--model' },
  { id:'gemini', name:'Gemini CLI', command:'gemini', npm:'@google/gemini-cli', brew:'gemini-cli', acp:['--experimental-acp'], modelFlag:'--model' },
  { id:'qwen', name:'Qwen Code', command:'qwen', acp:['--acp'], modelFlag:'--model' },
  { id:'copilot', name:'GitHub Copilot CLI', command:'copilot', acp:['--acp','--stdio'] },
  { id:'goose', name:'Goose', command:'goose', acp:['acp'] },
  { id:'droid', name:'Factory Droid', command:'droid', acp:['exec','--output-format','acp'], modelFlag:'--model' },
  // P2 — ACP-first where docs/adapters exist; Pi uses adapter, omp is native ACP.
  { id:'pi', name:'Pi', command:'pi', npm:'@earendil-works/pi-coding-agent', adapter:'pi-acp', modelFlag:'--model' },
  { id:'omp', name:'Oh My Pi', command:'omp', npm:'@oh-my-pi/pi-coding-agent', acp:['acp'], modelFlag:'--model' },
  { id:'cline', name:'Cline CLI', command:'cline', aliases:['cline-cli'], npm:'cline', brew:'cline', acp:['--acp'], modelFlag:'--model' },
  { id:'crush', name:'Crush', command:'crush', npm:'@charmland/crush', brew:'crush', adapter:'crush-acp', acp:['acp'] },
  { id:'qoder', name:'Qoder', command:'qoder', aliases:['qodercli'], acp:['--acp'] },
  { id:'qoder_cn', name:'Qoder CN', command:'qodercn', aliases:['qoderclicn'], acp:['--acp'] },
  { id:'hermes', name:'Hermes Agent', command:'hermes', adapter:'hermes-acp', acp:['acp'] },
  // P3 — declare discovery; ACP only when public docs name a stdio entry.
  { id:'mimo', name:'MiMo Code', command:'mimo', aliases:['mimocode'], acp:['acp'], modelFlag:'--model' },
  { id:'mcode', name:'MiniMax Code', command:'mcode', acp:['acp'], modelFlag:'--model' },
  { id:'deveco', name:'DevEco Code', command:'deveco', acp:['acp'], modelFlag:'--model' },
  // StepCode's shipped binary is often named `step`, but that collides with
  // unrelated tools; only accept the product-specific name until package identity exists.
  { id:'stepcode', name:'StepCode', command:'stepcode' },
  { id:'commandcode', name:'Command Code', command:'command-code', aliases:['commandcode'] },
  // Grok Build installs under ~/.grok/bin; bare `grok` collides with Homebrew's regex tool — skip PATH guess.
  { id:'atomcode', name:'AtomCode', command:'atomcode', npm:'@atomgit.com/atomcode', brew:'atomcode' },
  { id:'snow', name:'Snow CLI', command:'snow', aliases:['snow-cli'], npm:'snow-ai' },
  { id:'jcode', name:'jcode', command:'jcode' },
  { id:'devin', name:'Devin', command:'devin' },
  { id:'mothx', name:'MothX', command:'mothx', npm:'mothx-installer' },
  { id:'penguin', name:'PenguinHarness', command:'penguin', npm:'@prismshadow/penguin-cli' },
  { id:'omo', name:'OmO', command:'omo', aliases:['omo-ai'], npm:'omo-ai' },
  { id:'prime_agent', name:'Prime Agent', command:'prime-agent' },
  { id:'empryo', name:'Empryo', command:'empryo', aliases:['soulforge'] },
  { id:'ante', name:'Ante', command:'ante' },
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
/** Where an ACP probe failed — handshake failures are recoverable; session/auth are not. */
export type AcpFailureStage = 'spawn' | 'handshake' | 'session' | 'unknown'

export interface LocalAgent {
  id: string; installationId: string; name: string; path: string; realPath: string; version?: string; appVersion?: string
  source: 'npm' | 'pnpm' | 'bun' | 'brew' | 'uv' | 'pipx' | 'self' | 'unknown'
  prefix?: string; manager?: string; package?: string; selectedProtocol?: 'cli'|'acp'
  runnable: boolean; enabled: boolean; error?: string
  cli?: Launcher; acp?: Launcher; modelFlag?: string
  installations?: Array<{
    id: string
    path: string
    realPath: string
    version?: string
    shim?: boolean
    sourceHint?: 'nvm' | 'fnm' | 'mise' | 'asdf' | 'volta' | 'npm' | 'unknown'
    runtime?: { kind: 'node'; binDir: string }
  }>
  automaticCli?: Launcher
  automaticAcp?: Launcher
  latest?: string; updateError?: string; checkedAt?: string
  nativeUpdate?: { command: string; args: string[]; versionArgs: string[]; version: string; target: 'agent' | 'wecode'; sharedKey?: string }
  acpError?:string
  acpStatus?: 'verified' | 'unverified' | 'missing' | 'incompatible' | 'failed'
  /** Layer that produced the current ACP failure; omitted on success. */
  acpFailureStage?: AcpFailureStage
  /** Launch fingerprint the failure/status applies to; config changes invalidate it. */
  acpLaunchFingerprint?: string
}
export interface AgentUpdateJob { id: string; agentId: string; status: 'queued'|'updating'|'verifying'|'success'|'failed'|'skipped'|'cancelled'|'interrupted'; before?: string; after?: string; error?: string }

export function isNewerStableVersion(a: string, b: string): boolean {
  const parse = (v: string) => /^(?:v)?(\d+)\.(\d+)\.(\d+)$/.exec(v)
  const x = parse(a), y = parse(b)
  if (!x || !y) return false
  for(let i=1;i<4;i++) { if(+x[i] !== +y[i]) return +x[i] > +y[i] }
  return false
}

/** Detect ACP probe failures that ask the user to sign in, and optional login command. */
export function parseAcpAuthFailure(error?: string): { command?: string } | undefined {
  if (!error) return undefined
  if (!/(authentication(?:\s+token)?|token\s+has\s+expired|not\s+logged\s+in|please\s+(?:run|login|sign\s*in)|(?:^|[^\w])login(?:[^\w]|$)|sign[\s-]?in\s+required|unauthorized)/i.test(error)) {
    return undefined
  }
  const command = error.match(/\b((?:wecode|claude|codex|agy|antigravity|opencode|kimi|dsh|gemini|codebuddy|cbc|cursor-agent|qwen|copilot|goose|droid|qoder|qodercn|qodercli|qoderclicn|cline|omp|pi|hermes|mimo|mimocode|mcode|crush)(?:\s+[a-z0-9_-]+)?\s+login)\b/i)?.[1]
    || error.match(/^\s*((?:[\w./-]+\/)?[\w.-]+\s+login)\s*$/im)?.[1]
  return { command: command?.trim() }
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

/** Prefer an adapted CLI; otherwise ACP when that is the only usable entry. */
export function resolveAgentProtocol(agent: LocalAgent): 'cli' | 'acp' {
  if (agent.selectedProtocol === 'cli' || agent.selectedProtocol === 'acp') return agent.selectedProtocol
  if (agent.runnable) return 'cli'
  if (agent.acp) return 'acp'
  return agent.cli ? 'cli' : 'acp'
}

/** Readiness for the selected (or resolved) protocol — not a loose OR across both. */
export function agentProtocolReady(agent: LocalAgent, protocol = resolveAgentProtocol(agent)): boolean {
  if (protocol === 'cli') return !!agent.runnable
  return agent.acpStatus === 'verified'
}

/** Task picker: enabled and the currently selected protocol can actually run. */
export function agentTaskSelectable(agent: LocalAgent): boolean {
  return !!agent.enabled && agentProtocolReady(agent)
}

/** Post-update verification accepts either an adapted CLI or a verified ACP entry. */
export function agentUpdateRuntimeReady(agent: LocalAgent): boolean {
  return !!agent.runnable || agent.acpStatus === 'verified'
}

/** Default protocol for a freshly discovered row when the user has not saved one. */
export function defaultSelectedProtocol(agent: Pick<LocalAgent, 'runnable' | 'acp'>): 'cli' | 'acp' {
  return agent.runnable ? 'cli' : agent.acp ? 'acp' : 'cli'
}

/** Stable fingerprint for an ACP launch config — scopes failure state to that target. */
export function acpLaunchFingerprint(launcher?: Pick<Launcher, 'command' | 'args' | 'env'> | null): string {
  if (!launcher?.command) return ''
  return JSON.stringify([
    launcher.command,
    launcher.args ?? [],
    Object.entries(launcher.env ?? {}).sort(([a], [b]) => a.localeCompare(b))
  ])
}

type AgentLaunchOptions = {
  agentConfig?: AgentConfiguration | null
  savedLauncher?: Partial<Launcher> | null
}

/**
 * Launcher for a specific protocol, independent of the currently selected one.
 * Model catalog APIs must use this so switching/saving the active protocol
 * cannot empty the other protocol's directory.
 */
export function resolveProtocolLauncher(
  protocol: 'cli' | 'acp',
  agent: LocalAgent | undefined,
  options?: AgentLaunchOptions
): (Partial<Launcher> & { protocol?: 'cli' | 'acp' }) | undefined {
  const config = options?.agentConfig
  const saved = options?.savedLauncher
  const fromConfig = config?.[protocol]
  const fromAgent = agent?.[protocol]
  const fromSaved =
    saved && (saved.protocol === protocol || (!saved.protocol && protocol === 'cli'))
      ? saved
      : undefined
  const launcher = fromConfig || fromAgent || fromSaved
  if (!launcher) return undefined
  return { ...launcher, protocol }
}

/**
 * Resolve protocol + launcher for new tasks, model queries, and configure saves.
 * Explicit agent_management / raw saved launcher wins; otherwise use discovery
 * selectedProtocol. Do not pass normalizeLaunchers() defaults here — those are
 * not user choices and would force CLI for ACP-first products.
 */
export function resolveEffectiveAgentLaunch(
  agent: LocalAgent | undefined,
  options?: AgentLaunchOptions
): { protocol: 'cli' | 'acp'; launcher: (Partial<Launcher> & { protocol?: 'cli' | 'acp' }) | undefined } {
  const config = options?.agentConfig
  const saved = options?.savedLauncher
  const explicitProtocol =
    config?.protocol ||
    (saved?.protocol === 'cli' || saved?.protocol === 'acp' ? saved.protocol : undefined)
  const protocol: 'cli' | 'acp' =
    explicitProtocol ||
    (agent ? resolveAgentProtocol(agent) : 'cli')
  const launcher = resolveProtocolLauncher(protocol, agent, options)
  if (!launcher) return { protocol, launcher: undefined }
  return { protocol, launcher }
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
  updateKey?: string
  targetKey?: string
  /** Digest of the requested CLI selection, before discovery resolves its executable path. */
  selectionKey?: string
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

/** Shared public component identity; inner Agent argv must not split a WeCode update. */
export function agentUpdateGroupKey(agent: LocalAgent): string {
  return agent.nativeUpdate?.target === 'wecode'
    ? 'wecode:' + (agent.nativeUpdate.sharedKey || agent.nativeUpdate.command)
    : agent.id
}
export function hasAgentUpdate(agent: LocalAgent): boolean {
  const version = agent.nativeUpdate?.version || agent.version
  return !!(agent.latest && version && (agent.manager || agent.nativeUpdate) && isNewerStableVersion(agent.latest, version))
}
