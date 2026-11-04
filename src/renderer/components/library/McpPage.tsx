import { FolderOpen, RefreshCw, Archive, Globe, KeyRound, Plus, Terminal } from 'lucide-react'
import { useState } from 'react'
import { useT } from '../../hooks/useI18n'
import { useLibraryActions, useLibrarySnapshot } from '../../hooks/useLibrary'
import { McpServerEditor } from './McpServerEditor'
import { AgentChips } from './AgentChips'
import './library.css'

export function McpPage() {
  const t = useT()
  const { data, isFetching } = useLibrarySnapshot()
  const { refresh, setServer } = useLibraryActions()
  const [adding, setAdding] = useState(false)
  const [order, setOrder] = useState<'asc' | 'desc'>('asc')
  const [guide, setGuide] = useState<{ title: string; steps: string[] } | null>(null)
  const busy = refresh.isPending || setServer.isPending
  const servers = data?.servers || []
  const visibleServers = [...servers].sort((a, b) =>
    order === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
  )
  const targets = (data?.targets || []).filter((x) => x.capabilities.readMcp || x.capabilities.writeMcp || x.pendingInit)

  return (
    <div className="library-page">
      <div className="library-toolbar">
        <span className="library-count">{t('library.mcp.count', { n: servers.length })}</span>
        <div className="library-toolbar-actions">
          <button className="library-btn" disabled={busy} onClick={() => refresh.mutate()}>
            <RefreshCw size={13} className={isFetching || refresh.isPending ? 'animate-spin' : ''} />{t('library.refresh')}
          </button>
          <button className="library-btn" disabled={busy} onClick={async () => {
            const path = await window.buddy.openLibraryDir()
            await window.api.openInFinder(path)
          }}><FolderOpen size={13} />{t('library.openDir')}</button>
          <button className="library-btn" disabled={busy} onClick={async () => {
            const path = await window.buddy.openLibraryBackupsDir()
            await window.api.openInFinder(path)
          }}><Archive size={13} />{t('library.backups')}</button>
        </div>
      </div>
      {data?.scannedAt && <p className="library-banner">{t('library.lastScan', { time: new Date(data.scannedAt).toLocaleString() })}</p>}
      {data?.error && <p className="library-banner" role="alert">{data.error}</p>}
      <p className="library-banner">{t('library.mcp.authNote')}</p>

      <section className="library-catalog" aria-label={t('library.mcp.managed')}>
        <p className="skills-intro">{t('library.mcp.intro')}</p>
        {!servers.length ? (
          <div className="mcp-empty">
            <strong>{t('library.mcp.emptyManaged')}</strong>
            <p>{t('library.mcp.emptyHint')}</p>
            <button className="library-btn" type="button" disabled={busy} onClick={() => setAdding(true)}>
              <Plus size={13} />{t('library.mcp.add')}
            </button>
          </div>
        ) : (
          <>
            <div className="library-section-title">
              <span id="mcp-catalog-title">{t('library.mcp.managed')}</span>
              <div className="library-sort">
                <button type="button" className="library-btn" aria-pressed={order === 'asc'} onClick={() => setOrder('asc')}>A–Z</button>
                <button type="button" className="library-btn" aria-pressed={order === 'desc'} onClick={() => setOrder('desc')}>Z–A</button>
              </div>
            </div>
            <div className="library-list library-list-compact">
              {visibleServers.map((server) => (
                <div className="library-row" key={server.id}>
                  <span className="library-row-icon" aria-hidden="true">
                    {server.transport === 'stdio' ? <Terminal size={15} /> : <Globe size={15} />}
                  </span>
                  <div className="library-row-main">
                    <div className="library-row-title">{server.name}</div>
                    {server.note && <div className="library-row-sub" title={server.note}>{server.note}</div>}
                    <div className="library-row-sub" title={server.summary}>{server.transport} · {server.summary}</div>
                    {!!server.assignedTargetIds.length && (
                      <div className="mcp-auth-actions">
                        {server.assignedTargetIds.map((targetId) => {
                          const auth = data?.auth.find((a) => a.targetId === targetId && a.serverName === server.name)
                          const target = targets.find((x) => x.targetId === targetId)
                          return (
                            <button
                              key={targetId}
                              type="button"
                              className="library-btn"
                              onClick={async () => setGuide(await window.buddy.openLibraryAuthGuidance(targetId, server.name))}
                            >
                              <KeyRound size={12} />
                              {target?.displayName || targetId}: {auth?.status || 'unknown'}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <AgentChips
                    targets={targets}
                    assigned={server.assignedTargetIds}
                    onToggle={(targetId, enabled) => setServer.mutate({ serverId: server.id, targetId, enabled })}
                  />

                </div>
              ))}
            </div>
            <button className="library-btn mcp-add" type="button" disabled={busy} onClick={() => setAdding(true)}>
              <Plus size={13} />{t('library.mcp.add')}
            </button>
          </>
        )}
      </section>

      {adding && <McpServerEditor targets={targets} onClose={() => setAdding(false)} />}
      {setServer.data && setServer.data.status !== 'ok' && (
        <p className="library-banner" role="alert">{setServer.data.message || t('library.mcp.saveError')}</p>
      )}
      {guide && (
        <div className="library-banner" role="status">
          <strong>{guide.title}</strong>
          <ul>{guide.steps.map((step) => <li key={step}>{step}</li>)}</ul>
        </div>
      )}
    </div>
  )
}
