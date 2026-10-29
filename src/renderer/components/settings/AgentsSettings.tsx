import { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Download, ChevronDown, SlidersHorizontal, Check, Loader2 } from 'lucide-react'
import { isNewerStableVersion, applyAgentConfiguration, agentUpdateCounts } from '../../../shared/agents'
import type { AgentConfiguration, LocalAgent, AgentInventorySnapshot, AgentUpdateItemStatus } from '../../../shared/agents'
import type { Launcher } from '../../../shared/types'
import { useT } from '../../hooks/useI18n'
import { Switch } from '../Switch'
import { AgentIcon } from './AgentIcon'
import { JsonEditor } from './JsonEditor'
import { useAgentInventory, useAgentUpdateState, startAgentUpdates, acceptAgentSnapshot, agentInventoryKey } from '../../hooks/useAgentUpdates'
import { AgentUpdateStatus, updateStatusKey } from './AgentUpdateStatus'
import './agents-settings.css'

const canRun = (a: LocalAgent) => a.runnable || a.acpStatus === 'verified'
const hasExecutionEntry = (a: LocalAgent) => !!(a.cli || a.acp)
const hasUpdate = (a: LocalAgent) => !!(a.manager && a.latest && a.version && isNewerStableVersion(a.latest, a.version))
const modelCatalogKey = (a: LocalAgent, protocol: 'cli' | 'acp') => [
  'agentModels', a.id, a.installationId, protocol, a.version,
  a[protocol]?.command, a[protocol]?.args, a[protocol]?.env
]


export function AgentsSettings() {
  const t = useT(), cache = useQueryClient()
  const { data: snapshot, isFetching, error } = useAgentInventory()
  const { data: updateState, error: updateError } = useAgentUpdateState()
  const inventory=snapshot?.agents || []
  const agents = inventory.filter(hasExecutionEntry)
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set())
  const [message, setMessage] = useState(''), [pending, setBusy] = useState(false)
  const busy=pending || !!updateState?.activeBatch
  const refreshing=!!snapshot?.refreshing
  const progress=updateState?.activeBatch?agentUpdateCounts(updateState.activeBatch):undefined
  const patch=(id:string,change:(agent:LocalAgent)=>LocalAgent)=>cache.setQueryData<AgentInventorySnapshot>(agentInventoryKey,current=>current?{...current,agents:current.agents.map(a=>a.id===id?change(a):a)}:current)
  const refresh=async(mode:'all'|'scan'|'updates')=>{
    if(window.buddy.refreshLocalAgents)acceptAgentSnapshot(cache,agentInventoryKey,await window.buddy.refreshLocalAgents(mode))
    else {
      const agents=mode==='updates'?await window.buddy.checkAgentUpdates(true):await window.buddy.listLocalAgents(true)
      cache.setQueryData(agentInventoryKey,{revision:0,agents,refreshing:false})
    }
  }
  const updates = agents.filter(hasUpdate)
  const updateTargets = agents.filter(a => hasUpdate(a) || a.nativeUpdate)
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true); setMessage('')
    try {
      await fn()
      await Promise.all([cache.invalidateQueries({ queryKey: agentInventoryKey }), cache.invalidateQueries({ queryKey: ['bootstrap'] })])
    } catch (e) { setMessage(String(e)) } finally { setBusy(false) }
  }
  const save = async (a: LocalAgent, config: AgentConfiguration) => {
    setSaving(previous => new Set(previous).add(a.id))
    setMessage('')
    await cache.cancelQueries({ queryKey: agentInventoryKey })
    patch(a.id,row=>applyAgentConfiguration(row,config))
    try {
      await window.buddy.configureAgent(a.id, config)
      patch(a.id,row=>applyAgentConfiguration(row,config))
      void cache.invalidateQueries({ queryKey: ['bootstrap'] })
    } catch (error) {
      patch(a.id,()=>a)
      setMessage(String(error))
    } finally {
      setSaving(previous => { const next = new Set(previous); next.delete(a.id); return next })
    }
  }
  return <div className="agent-catalog">
    <div className="agent-list-toolbar">
      <span role="status">{updates.length ? t('agents.updatesAvailable', { n: updates.length, names: updates.map(a => a.name).join(', ') }) : t('agents.discovered', { n: agents.length })}</span>
      <div className="agent-toolbar-actions">
        <button className="agent-icon-button" disabled={busy || refreshing} title={t('agents.refreshAll')} aria-label={t('agents.rescan')} onClick={()=>action(()=>refresh('all'))}><RefreshCw size={14} className={refreshing?'animate-spin':''}/></button>
        <select className="agent-refresh-options" aria-label={t('agents.refreshOptions')} value="" disabled={busy||refreshing} onChange={event=>action(()=>refresh(event.target.value as 'all'|'scan'|'updates'))}>
          <option value="" disabled>{t('agents.refreshOptions')}</option><option value="scan">{t('agents.scanOnly')}</option><option value="updates">{t('agents.checkOnly')}</option>
        </select>
        <button className="agent-update-pill" disabled={busy || refreshing || !updateTargets.length} onClick={() => action(() => startAgentUpdates(cache,updateTargets.map(a => a.id)))}><Download size={12} />{progress?t('agents.globalProgress',{n:progress.processed,total:progress.total}):t('agents.updateAll')}</button>
      </div>
    </div>
    {snapshot?.scannedAt&&<p className="agent-cache-time">{t(refreshing?'agents.refreshingCache':'agents.lastScan',{time:new Date(snapshot.scannedAt).toLocaleString()})}</p>}
    {(message || error || updateError || snapshot?.error) && <p role="alert" className="text-danger text-sm mb-3">{message || snapshot?.error || String(error || updateError)}</p>}
    {updateState?.activeBatch&&<AgentUpdateStatus batch={updateState.activeBatch} active/>}
    <div className="agent-list-card">
      <div role="list" aria-label={t('settings.tab.agents')}>
        {agents.map(a => <CompactAgentRow key={a.id} agent={a} updateStatus={updateState?.activeBatch?.items.find(item=>item.agentId===a.id)?.status} busy={busy || saving.has(a.id)} onSave={config => save(a, config)} onUpdate={() => action(() => startAgentUpdates(cache,[a.id]))} />)}
        {!agents.length && <div className="agent-list-empty">{isFetching || refreshing ? t('common.loading') : t('agents.empty')}</div>}
      </div>
    </div>
    {updateState?.lastCompletedBatch&&<AgentUpdateStatus key={updateState.lastCompletedBatch.id} batch={updateState.lastCompletedBatch} active={false} disabled={!!updateState.activeBatch}/>}
  </div>
}

function AgentAdvancedSettings({ agent: a, protocol, launcher, disabled, onSave }: {
  agent: LocalAgent
  protocol: 'cli' | 'acp'
  launcher: Launcher
  disabled: boolean
  onSave: (config: AgentConfiguration) => Promise<void>
}) {
  const t = useT()
  const [installation, setInstallation] = useState(a.path)
  const [command, setCommand] = useState(launcher.command)
  const [argsText, setArgsText] = useState(JSON.stringify(launcher.args || [], null, 2))
  const [envText, setEnvText] = useState(JSON.stringify(launcher.env || {}, null, 2))
  let args: string[] = [], env: Record<string, string> = {}
  let argsError = '', envError = ''
  try {
    const parsed = JSON.parse(argsText)
    if (!Array.isArray(parsed) || !parsed.every(value => typeof value === 'string')) throw new Error()
    args = parsed
  } catch { argsError = t('agents.invalidArgs') }
  try {
    const parsed = JSON.parse(envText)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || !Object.values(parsed).every(value => typeof value === 'string')) throw new Error()
    env = parsed
  } catch { envError = t('agents.invalidEnv') }
  const installations = a.installations || []
  return <form className="agent-advanced-form" onSubmit={event => {
    event.preventDefault()
    if (disabled || !command.trim() || argsError || envError) return
    const config: AgentConfiguration = { [protocol]: { ...launcher, command: command.trim(), args, env } }
    // The installation picker selects the underlying CLI; an ACP adapter keeps its own command.
    if (protocol === 'acp' && a.cli && installation !== a.path) config.cli = { ...a.cli, command: installation }
    void onSave(config)
  }}>
    <fieldset disabled={disabled} className="agent-advanced-fields">
      <label className="agent-advanced-field">
        <span>{t('agents.installation')}</span>
        {installations.length > 1 && a.cli ? <select aria-label={t('agents.installation')} value={installation} onChange={event => {
          setInstallation(event.target.value)
          if (protocol === 'cli') setCommand(event.target.value)
        }}>
          {!installations.some(item => item.path === installation) && <option value={installation}>{installation || '—'}</option>}
          {installations.map(item => <option key={item.id} value={item.path}>{item.path}{item.version ? ` · ${item.version}` : ''}</option>)}
        </select> : <span className="agent-installation-path">{a.path || a.realPath || '—'}</span>}
      </label>
      <label className="agent-advanced-field">
        <span>{t('agents.command')}</span>
        <input value={command} onChange={event => setCommand(event.target.value)} spellCheck={false} required />
      </label>
      <JsonEditor label={t('agents.args')} value={argsText} onChange={setArgsText} error={argsError} />
      <JsonEditor label={t('agents.env')} value={envText} onChange={setEnvText} error={envError} />
      {(protocol === 'acp' ? a.acpError || a.error : a.error) && <p role="alert" className="text-danger break-all">{protocol === 'acp' ? a.acpError || a.error : a.error}</p>}
      <div className="agent-advanced-actions"><button type="submit" className="agent-update-pill" disabled={!command.trim() || !!argsError || !!envError}>
        {disabled ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}{t('common.save')}
      </button></div>
    </fieldset>
  </form>
}

function CompactAgentRow({ agent: a, busy, updateStatus, onSave, onUpdate }: { agent: LocalAgent; updateStatus?:AgentUpdateItemStatus; busy: boolean; onSave: (config: AgentConfiguration) => Promise<void>; onUpdate: () => void }) {
  const t = useT()
  const [advanced, setAdvanced] = useState(false)
  const protocol = a.selectedProtocol || (a.cli ? 'cli' : 'acp')
  const available = canRun(a)
  const launcher = a[protocol]
  const advancedId = `agent-advanced-${a.id}`
  return <div className="agent-list-entry" role="listitem" data-agent-id={a.id}>
    <div className="agent-compact-row">
    <AgentIcon id={a.id} />
    <div className="agent-row-identity" title={a.path || a.name}>
      <div className="agent-row-title"><span className="agent-row-name">{a.name}</span>
        {a.version && <span className="agent-row-version">{a.appVersion ? 'CLI ' : ''}{a.version}</span>}
        <span className="agent-row-actions">
        <button className="agent-update-pill" disabled={!launcher} aria-label={`${a.name} ${t('agents.advanced')}`} aria-expanded={advanced} aria-controls={advancedId} onClick={() => setAdvanced(value => !value)}><SlidersHorizontal size={11} />{t('agents.advanced')}</button>
        {updateStatus&&<span className="agent-update-pill" role="status">{t(updateStatusKey(updateStatus))}</span>}
        {!updateStatus && hasUpdate(a) && <button className="agent-update-pill" disabled={busy} onClick={onUpdate} aria-label={`${a.name} ${t('agents.update')} ${a.latest}`}><Download size={11} /><span>{t('agents.update')} {a.latest}</span></button>}
        {!updateStatus && !hasUpdate(a) && a.nativeUpdate && <button className="agent-update-pill" disabled={busy} onClick={onUpdate} title={`${a.nativeUpdate.target === 'wecode' ? 'WeCode ' : ''}${a.nativeUpdate.version}`} aria-label={`${a.name} ${t(a.nativeUpdate.target === 'wecode' ? 'agents.updateWecode' : 'agents.nativeUpdate')}`}><Download size={11} /><span>{t(a.nativeUpdate.target === 'wecode' ? 'agents.updateWecode' : 'agents.nativeUpdate')}</span></button>}
        </span>
        {a.appVersion && <span className="agent-row-version agent-app-version">App {a.appVersion}</span>}
      </div>
      <div className="agent-row-description"><span className={`agent-status-dot ${available && a.enabled ? 'enabled' : ''}`} />
        <span>{available ? `${t(a.enabled ? 'agents.ready' : 'agents.disabled')} · ${a.cli && a.acpStatus === 'verified' ? 'CLI / ACP' : protocol.toUpperCase()}` : t('agents.appOnly')}</span>
        {a.acp && a.acpStatus !== 'verified' && <span title={a.acpError}>· {t(a.acpStatus === 'failed' ? 'agents.status.failed' : a.acpStatus === 'incompatible' ? 'agents.status.incompatible' : 'agents.status.unverified')}</span>}
      </div>
    </div>
    <div className="agent-row-controls">
      {available ? <label className="agent-protocol-control"><span className="sr-only">{a.name} {t('settings.launcher.mode')}</span><select value={protocol} disabled={busy} onChange={e => { const p = e.target.value as 'cli' | 'acp'; void onSave({ protocol: p, [p]: a[p] }) }}>
        <option value="cli" disabled={!a.cli}>CLI</option><option value="acp" disabled={!a.acp}>ACP</option>
      </select><ChevronDown size={10} /></label> : <span className="agent-protocol-placeholder" />}
      <ModelControl agent={a} protocol={protocol} disabled={busy || !available || (protocol === 'cli' && !a.modelFlag)} onSave={onSave} />
      <Switch checked={available && a.enabled} disabled={busy || !available} ariaLabel={`${a.name} ${t('agents.enabled')}`} onChange={enabled => { void onSave({ enabled }) }} />
    </div>
    </div>
    {advanced && launcher && <section id={advancedId} aria-label={`${a.name} ${t('agents.advanced')}`}>
      <AgentAdvancedSettings key={JSON.stringify([protocol, launcher.command, launcher.args, launcher.env, a.path])} agent={a} protocol={protocol} launcher={launcher} disabled={busy} onSave={onSave} />
    </section>}
  </div>
}

function ModelControl({ agent: a, protocol, disabled, onSave }: { agent: LocalAgent; protocol: 'cli' | 'acp'; disabled: boolean; onSave: (config: AgentConfiguration) => Promise<void> }) {
  const t = useT(), [open, setOpen] = useState(false), [custom, setCustom] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const current = a[protocol]?.model || ''
  const models = useQuery({ queryKey: modelCatalogKey(a, protocol), queryFn: () => protocol === 'acp' ? window.buddy.listAcpModels(a.id) : window.buddy.listCliModels(a.id), enabled: open, retry: false, staleTime: query => query.state.data?.models.length ? 300000 : 0 })
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); box.current?.querySelector<HTMLButtonElement>('[aria-haspopup=listbox]')?.focus() } }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape) }
  }, [open])
  const select = (model: string) => {
    const launcher = a[protocol]
    if (!launcher) return
    setOpen(false)
    void onSave({ [protocol]: { ...launcher, model } })
  }
  return <div className="agent-model-control" ref={box} onKeyDown={event => {
    if (!open || !['ArrowDown', 'ArrowUp'].includes(event.key) || event.target instanceof HTMLInputElement) return
    const options = Array.from(box.current?.querySelectorAll<HTMLButtonElement>('[role=option]') || [])
    if (!options.length) return
    event.preventDefault()
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement)
    options[(currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].focus()
  }}>
    <button className="agent-model-trigger" disabled={disabled} aria-label={`${a.name} ${t('agents.model')}`} aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen(value => !value)}>
      <AgentIcon id={a.id} model={current} size={14} /><span>{current || t('agents.default')}</span><ChevronDown size={11} />
    </button>
    {open && <div className="agent-model-popover">
      <div role="listbox" aria-label={`${a.name} ${t('agents.model')}`}>
        <button role="option" aria-selected={!current} onClick={() => select('')}><AgentIcon id={a.id} size={14} /><span>{t('agents.native')}</span>{!current && <Check size={13} />}</button>
        {models.data?.models.map(model => <button role="option" key={model.id} aria-selected={current === model.id} onClick={() => select(model.id)}><span>{model.name}</span>{current === model.id && <Check size={13} />}</button>)}
      </div>
      {models.isFetching && <p className="agent-picker-message"><Loader2 size={12} className="animate-spin" />{t('common.loading')}</p>}
      {(models.error || models.data?.error) && <p role="alert" className="agent-picker-message">{String(models.error || models.data?.error)}</p>}
      <form className="agent-model-custom" onSubmit={e => { e.preventDefault(); if (custom.trim()) select(custom.trim()) }}><input aria-label={`${a.name} ${t('agents.customModel')}`} placeholder={t('agents.customModel')} value={custom} onChange={e => setCustom(e.target.value)} /><button type="submit" disabled={!custom.trim()} aria-label={t('common.save')}><Check size={14} /></button></form>
    </div>}
  </div>
}
