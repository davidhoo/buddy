import { useState } from 'react'
import { Download, Loader2, X, ChevronDown, AlertCircle } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { agentUpdateCounts, isAgentUpdateTerminal } from '../../../shared/agents'
import type { AgentUpdateBatch, AgentUpdateItemStatus } from '../../../shared/agents'
import { useT } from '../../hooks/useI18n'
import type { TranslationKey } from '../../lib/i18n'
import { startAgentUpdates } from '../../hooks/useAgentUpdates'

export const updateStatusKey = (status:AgentUpdateItemStatus):TranslationKey => `agents.job.${status}` as TranslationKey
export function AgentUpdateSummary({batch}:{batch:AgentUpdateBatch}) {
  const t=useT(),counts=agentUpdateCounts(batch)
  return <span>{t('agents.batchSummary',{updated:counts.updated,latest:counts.upToDate,failed:counts.failed,cancelled:counts.cancelled,skipped:counts.skipped})}</span>
}
export function AgentUpdateStatus({batch,active,disabled=false}:{batch:AgentUpdateBatch;active:boolean;disabled?:boolean}) {
  const t=useT(),cache=useQueryClient(),[error,setError]=useState(''),[pending,setPending]=useState(false)
  const counts=agentUpdateCounts(batch)
  const current=batch.items.find(item=>!isAgentUpdateTerminal(item.status))
  const retry=batch.items.filter(item=>['failed','interrupted'].includes(item.status)).map(item=>item.agentId)
  const action=async(fn:()=>Promise<unknown>)=>{setPending(true);setError('');try{await fn()}catch(e){setError(String(e))}finally{setPending(false)}}
  const details=<ul className="agent-update-items">{batch.items.map(item=><li key={item.id}>
    <div><strong>{item.name}{item.target==='wecode' ? ' · WeCode' : ''}</strong><span>{t(updateStatusKey(item.status))}</span></div>
    {(item.before || item.after) && <p>{item.before || '—'}{item.after?` → ${item.after}`:''}{item.startedAt&&item.finishedAt?` · ${Math.max(0,Math.round((Date.parse(item.finishedAt)-Date.parse(item.startedAt))/1000))}s`:''}</p>}
    {item.error&&<p className="text-danger">{item.error}</p>}
  </li>)}</ul>
  return <section className="agent-update-card" aria-label={t(active?'agents.activeUpdates':'agents.lastUpdate')} id={active?'agent-active-updates':'agent-last-update'}>
    <div className="agent-update-card-title"><strong>{t(active?'agents.activeUpdates':'agents.lastUpdate')}</strong>
      {!active&&<span>{batch.finishedAt?new Date(batch.finishedAt).toLocaleString():t('agents.legacyUpdate')}</span>}
      {active?<button className="agent-text-button" disabled={pending||batch.cancelRequested} onClick={()=>action(()=>window.buddy.cancelAgentUpdates())}>{t(batch.cancelRequested?'agents.cancelling':'agents.cancelRemaining')}</button>:retry.length>0&&<button className="agent-text-button" disabled={pending||disabled} onClick={()=>action(()=>startAgentUpdates(cache,retry))}>{t('agents.retryFailed')}</button>}
    </div>
    {active?<><p role="status" className="agent-update-progress"><Loader2 size={13} className="animate-spin"/>{t('agents.processed',{n:counts.processed,total:counts.total})} · {batch.status==='waiting'?t('agents.waitingForRuns'):batch.status==='preparing'?t('agents.job.preparing'):current?`${current.name} · ${t(updateStatusKey(current.status))}`:t('agents.finishing')}</p><p className="agent-update-hint">{t('agents.backgroundHint')}</p>{details}</>:<><AgentUpdateSummary batch={batch}/><details className="agent-update-details"><summary><ChevronDown size={13}/>{t('agents.updateDetails')}</summary>{details}</details></>}
    {(error||batch.error)&&<p role="alert" className="text-danger">{error||batch.error}</p>}
  </section>
}
export function AgentUpdateIndicator({batch,onOpen}:{batch:AgentUpdateBatch;onOpen:()=>void}) {
  const t=useT(),counts=agentUpdateCounts(batch)
  const active=!['completed','interrupted'].includes(batch.status)
  return <button onClick={onOpen} className="agent-global-update no-drag" title={t(active?'agents.backgroundHint':'agents.lastUpdate')}>{active?<Loader2 size={13} className="animate-spin"/>:<AlertCircle size={13}/>} {t(active?'agents.globalProgress':'agents.globalFailed',{n:active?counts.processed:counts.failed,total:counts.total})}</button>
}
export function AgentUpdateNotice({batch,onOpen,onDismiss}:{batch:AgentUpdateBatch;onOpen:()=>void;onDismiss:()=>void}) {
  const t=useT()
  return <div role="status" className="agent-update-notice"><Download size={16}/><button onClick={onOpen}><strong>{t('agents.updatesFinished')}</strong><AgentUpdateSummary batch={batch}/></button><button aria-label={t('agents.dismissNotice')} onClick={onDismiss}><X size={14}/></button></div>
}
