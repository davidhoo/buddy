import { useMemo, useState } from 'react'
import { FileText, HeartPulse, RefreshCw, Trash2, X } from 'lucide-react'
import type { ExtensionActionRequest, ExtensionActionResult, ExtensionPage, LibraryItem } from '../../../shared/extensions'
import type { TFunction } from '../../hooks/useI18n'
import { ACTOR_LABEL_KEY } from '../../lib/format'
import { AgentIcon } from './AgentIcon'

interface Props {
  kind: 'skill' | 'mcp'
  items: LibraryItem[]
  page: ExtensionPage
  busy: boolean
  onAction: (request: ExtensionActionRequest) => Promise<ExtensionActionResult>
  t: TFunction
}

export function LibraryResourceList({ kind, items, page, busy, onAction, t }: Props) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('name')
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [folded, setFolded] = useState(false)
  const [howOpen, setHowOpen] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const actorName = (actor: string) => ACTOR_LABEL_KEY[actor] ? t(ACTOR_LABEL_KEY[actor]) : actor
  const groups = useMemo(() => {
    const rows = items.filter(i => `${i.name} ${i.description} ${i.repository ?? ''}`.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => sort === 'newest' ? b.createdAt.localeCompare(a.createdAt) : a.name.localeCompare(b.name))
    const result = new Map<string, LibraryItem[]>()
    for (const row of rows) {
      const group = row.repository || t(kind === 'skill' ? 'library.list.local' : 'library.section.mcp')
      result.set(group, [...(result.get(group) ?? []), row])
    }
    return result
  }, [items, query, sort, t])
  const pending = busy || batchBusy
  const run = async (request: ExtensionActionRequest) => {
    try { return await onAction(request) } catch {
      setFeedback(t('library.error.generic'))
      return null
    }
  }
  const batch = async (desired: 'on' | 'off') => {
    setConfirmOff(false)
    setBatchBusy(true)
    let changed = 0, failed = 0
    try {
      for (const rows of groups.values()) for (const item of rows) {
        if (selecting && !selected.includes(item.id)) continue
        const result = await run({ action: 'assign', kind, libraryItemId: item.id, actor: '*', desired })
        changed += result?.results.filter(r => r.status === 'changed').length ?? 0
        failed += result ? result.results.filter(r => r.status === 'failed').length : 1
      }
      setFeedback(t('library.list.batchResult', { changed, failed }))
    } finally { setBatchBusy(false) }
  }
  return <section className="mb-6" aria-label={t('library.managed.title')}>
    <div className="flex items-center flex-wrap gap-2 mb-3">
      <h2 className="text-sm font-medium text-fg mr-auto">{t('library.managed.title')}</h2>
      <input className="bg-bg border border-border rounded-md px-2 py-1 text-xs text-fg" aria-label={t('library.list.filter')} placeholder={t('library.list.filter')} value={query} onChange={e => setQuery(e.target.value)} />
      <select className="bg-bg text-fg text-xs" aria-label={t('library.list.name')} value={sort} onChange={e => setSort(e.target.value)}>
        <option value="name">{t('library.list.name')}</option><option value="newest">{t('library.list.newest')}</option>
      </select>
      <button className="text-xs text-fg-secondary" onClick={() => setFolded(v => !v)}>{t(folded ? 'library.list.unfold' : 'library.list.fold')}</button>
      <button className="text-xs text-fg-secondary" aria-pressed={selecting} onClick={() => { setSelecting(v => !v); setSelected([]) }}>{t('library.list.select')}</button>
      <button className="text-xs text-fg-secondary" disabled={pending || (selecting && !selected.length)} onClick={() => void batch('on')}>{t('library.list.allOn')}</button>
      <button className="text-xs text-fg-secondary" disabled={pending || (selecting && !selected.length)} onClick={() => setConfirmOff(true)}>{t('library.list.allOff')}</button>
      {kind === 'skill' && items.some(i => i.repository) && <button className="text-xs text-fg-secondary inline-flex items-center gap-1" disabled={pending} onClick={() => void run({ action: 'check_updates', kind })}><RefreshCw size={13} />{t('library.list.check')}</button>}
    </div>
    {selecting && <p className="text-xs text-fg-secondary mb-2">{t('library.list.selected', { n: selected.length })}</p>}
    {feedback && <p role="status" className="text-xs text-fg-secondary mb-2">{feedback}</p>}
    {page.library.status === 'read_failed' && <p role="alert">{t('library.libraryStatus.read_failed')}</p>}
    {!groups.size && <p className="text-xs text-fg-secondary">{t('library.list.empty')}</p>}
    {[...groups].map(([group, rows]) => <details key={`${group}:${folded}`} open={!folded} className="mb-3">
      <summary className="text-xs text-fg-secondary cursor-pointer py-2 truncate" title={group}>{group} · {rows.length}</summary>
      <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
        {rows.map(item => {
          const bindings = page.library.bindings.filter(b => b.libraryItemId === item.id)
          const targets = page.targets.filter(target => target.assignBlock === 'none' || bindings.some(b => b.actor === target.actor && b.desired === 'on'))
          const allOn = targets.length > 0 && targets.every(target => bindings.some(b => b.actor === target.actor && b.desired === 'on'))
          const behind = page.copyDifferences?.some(d => d.libraryItemId === item.id)
          return <article key={item.id} className="px-3 py-3 flex items-center gap-3 flex-wrap lg:flex-nowrap" aria-label={item.name}>
            {selecting && <input type="checkbox" aria-label={item.name} checked={selected.includes(item.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))} />}
            <FileText size={20} className="text-fg-secondary shrink-0" />
            <button className="min-w-[160px] flex-1 text-left" disabled={kind !== 'skill'} onClick={async () => {
              const result = await run({ action: 'read', kind, libraryItemId: item.id })
              if (result?.accepted && result.content !== undefined) setPreview({ name: item.name, content: result.content })
            }}>
              <span className="text-sm font-medium text-fg block truncate">{item.name}</span>
              <span className="text-xs text-fg-secondary block truncate" title={item.description}>{item.description}</span>
              {item.version && <span className="text-xs text-fg-secondary">{item.version.slice(0, 8)}</span>}
            </button>
            {behind && <button className="text-xs text-accent shrink-0" disabled={pending} onClick={() => void run({ action: 'sync', kind, libraryItemId: item.id })}>{t('library.list.behind')}</button>}
            {item.locallyEdited && <span className="text-xs text-fg-secondary">{t('library.list.edited')}</span>}
            {item.updateAvailable && <button className="text-xs text-accent" disabled={pending} onClick={() => { if (!item.locallyEdited || window.confirm(t('library.list.replace'))) void run({ action: 'update', kind, libraryItemId: item.id, replace: Boolean(item.locallyEdited) }) }}>{t('library.list.updateAvailable')}</button>}
            <div className="flex items-center flex-wrap gap-1 max-w-full" aria-label={item.name}>
              <button className={`text-xs rounded-md px-2 py-1 ${allOn ? 'bg-bg-muted text-fg' : 'text-fg-secondary'}`} disabled={pending || !targets.length} aria-pressed={allOn} onClick={() => void run({ action: 'assign', kind, libraryItemId: item.id, actor: '*', desired: allOn ? 'off' : 'on' })}>All</button>
              {page.targets.map(target => {
                const binding = bindings.find(b => b.actor === target.actor)
                const on = binding?.desired === 'on'
                const mode = binding?.management === 'copy' ? 'copy' : 'link'
                return <button key={target.actor} className={`text-xs inline-flex gap-1 items-center px-1.5 py-1 rounded-md disabled:opacity-30 ${on ? 'bg-bg-muted text-fg' : 'text-fg-secondary hover:bg-bg-subtle'}`} aria-label={actorName(target.actor)} aria-pressed={on}
                  title={`${actorName(target.actor)} · ${on ? t(`library.list.${mode}`) : t('library.status.' + target.status as 'library.status.ok')}`}
                  disabled={pending || (!on && target.assignBlock !== 'none')}
                  onClick={() => void run({ action: 'assign', kind, libraryItemId: item.id, actor: target.actor, desired: on ? 'off' : 'on' })}>
                  <AgentIcon actor={target.actor} active={on} />{target.actor.startsWith('wecode_') && <span className="text-[9px]">W</span>}
                </button>
              })}
            </div>
            {kind === 'mcp' && <button aria-label={t('library.probe.run')} title={t('library.probe.run')} disabled={pending} onClick={() => void run({ action: 'probe', kind, libraryItemId: item.id })}><HeartPulse size={16} /></button>}
            <button className="text-fg-secondary hover:text-danger shrink-0" aria-label={t('library.managed.remove')} title={t('library.managed.remove')} disabled={pending} onClick={() => void run({ action: 'remove', kind, libraryItemId: item.id })}><Trash2 size={16} /></button>
          </article>
        })}
      </div>
    </details>)}
    {kind === 'skill' && <div className="flex flex-wrap items-center gap-3 py-3 text-xs text-fg-secondary">
      <span>{t('library.list.giveAs')}</span>
      <div className="inline-flex border border-border rounded-lg overflow-hidden">{(['link', 'copy'] as const).map(mode => <button key={mode} className={`px-3 py-1.5 ${(page.library.skillDefaultMode ?? 'link') === mode ? 'bg-bg-muted text-fg' : ''}`} disabled={pending} aria-pressed={(page.library.skillDefaultMode ?? 'link') === mode} onClick={() => void run({ action: 'skill_mode', kind, mode })}>{t(`library.list.${mode}`)}</button>)}</div>
      <button className="border border-border rounded-md px-2 py-1" onClick={() => setHowOpen(true)}>{t('library.list.byAgent')}{Object.keys(page.library.skillAgentModes ?? {}).length ? ` (${Object.keys(page.library.skillAgentModes!).length})` : ''}</button>
      <button className="inline-flex gap-1 items-center" disabled={pending} onClick={() => void run({ action: 'sync', kind })}><RefreshCw size={13} />{t('library.list.sync')}</button>
      <p className="w-full">{t('library.list.howNote')}</p>
    </div>}
    {(howOpen || preview || confirmOff) && <div className="fixed inset-0 z-50 bg-black/25 flex items-center justify-center p-4" onKeyDown={e => {
      e.stopPropagation()
      if (e.key === 'Escape') { setHowOpen(false); setPreview(null); setConfirmOff(false) }
      if (e.key === 'Tab') {
        const focusable = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)')]
        const next = e.shiftKey ? focusable.at(-1) : focusable[0]
        if ((e.shiftKey && document.activeElement === focusable[0]) || (!e.shiftKey && document.activeElement === focusable.at(-1))) { e.preventDefault(); next?.focus() }
      }
    }}>
      <div data-buddy-modal role="dialog" aria-modal="true" aria-label={preview?.name ?? t(confirmOff ? 'library.list.confirmOff' : 'library.list.byAgent')} className="bg-bg border border-border rounded-xl shadow-xl p-5 w-full max-w-2xl max-h-[85vh] overflow-auto text-fg">
        <div className="flex items-center justify-between gap-3 mb-4"><h3 className="font-medium">{preview?.name ?? t(confirmOff ? 'library.list.confirmOff' : 'library.list.byAgent')}</h3><button autoFocus aria-label={t('library.list.done')} onClick={() => { setHowOpen(false); setPreview(null); setConfirmOff(false) }}><X size={18} /></button></div>
        {preview ? <pre className="text-xs whitespace-pre-wrap break-words">{preview.content}</pre> : confirmOff ? <button disabled={pending} onClick={() => void batch('off')}>{t('common.confirm')}</button> : <>
          <p className="text-xs text-fg-secondary mb-3">{t('library.list.howNote')}</p>
          {page.targets.map(target => <div key={target.actor} className="flex items-center justify-between py-2 border-b border-border gap-3"><div><span className="text-sm inline-flex items-center gap-2"><AgentIcon actor={target.actor} />{actorName(target.actor)}</span><p className="text-xs text-fg-secondary">{t(`library.list.${page.library.bindings.some(b => b.actor === target.actor && b.management === 'copy' && b.desired === 'on') ? 'copy' : (page.library.skillAgentModes?.[target.actor] ?? page.library.skillDefaultMode ?? 'link')}`)}</p></div><select aria-label={actorName(target.actor)} className="bg-bg text-fg text-xs border border-border rounded-md p-1" value={page.library.skillAgentModes?.[target.actor] ?? ''} disabled={pending} onChange={e => void run({ action: 'skill_mode', kind, actor: target.actor, ...(e.target.value ? { mode: e.target.value as 'link' | 'copy' } : { inherit: true }) })}><option value="">{t('library.list.inherit')}</option><option value="link">{t('library.list.link')}</option><option value="copy">{t('library.list.copy')}</option></select></div>)}
        </>}
      </div>
    </div>}
  </section>
}
