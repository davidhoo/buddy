import { FolderOpen, RefreshCw, Archive, Download, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { useT } from '../../hooks/useI18n'
import { useLibraryActions, useLibrarySnapshot } from '../../hooks/useLibrary'
import { AgentChips } from './AgentChips'
import './library.css'

export function McpPage() {
  const t = useT()
  const { data, isFetching } = useLibrarySnapshot()
  const { refresh, importServers, setServer } = useLibraryActions()
  const [guide, setGuide] = useState<{ title: string; steps: string[] } | null>(null)
  const busy = refresh.isPending || importServers.isPending || setServer.isPending
  const servers = data?.servers || []
  const discovered = data?.discoveredServers || []
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

      <div className="library-section-title">{t('library.mcp.managed')}</div>
      <div className="library-list">
        {servers.map((server) => (
          <div className="library-row" key={server.id}>
            <div className="library-row-main">
              <div className="library-row-title">{server.name}</div>
              <div className="library-row-sub">{server.transport} · {server.summary}</div>
              {!!server.assignedTargetIds.length && (
                <div className="library-row-sub">
                  {server.assignedTargetIds.map((targetId) => {
                    const auth = data?.auth.find((a) => a.targetId === targetId && a.serverName === server.name)
                    const target = targets.find((x) => x.targetId === targetId)
                    return (
                      <button
                        key={targetId}
                        type="button"
                        className="library-btn"
                        style={{ marginTop: 4 }}
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
            <div />
          </div>
        ))}
        {!servers.length && <div className="library-empty">{t('library.mcp.emptyManaged')}</div>}
      </div>

      <div className="library-section-title">
        <span>{t('library.mcp.discovered', { n: discovered.length })}</span>
        <button
          className="library-btn"
          disabled={busy || !discovered.length}
          onClick={() => importServers.mutate(discovered.map((d) => d.discoveryId))}
        ><Download size={13} />{t('library.importAll')}</button>
      </div>
      <div className="library-list">
        {discovered.map((item) => (
          <div className="library-row" key={item.discoveryId}>
            <div className="library-row-main">
              <div className="library-row-title">{item.name}</div>
              <div className="library-row-sub">{item.agentId} · {item.transport} · {item.summary}</div>
            </div>
            <div />
            <div className="library-row-actions">
              <button className="library-btn" disabled={busy} onClick={() => importServers.mutate([item.discoveryId])}>
                <Download size={13} />{t('library.import')}
              </button>
            </div>
          </div>
        ))}
        {!discovered.length && <div className="library-empty">{t('library.mcp.emptyDiscovered')}</div>}
      </div>

      {guide && (
        <div className="library-banner" role="status">
          <strong>{guide.title}</strong>
          <ul>{guide.steps.map((step) => <li key={step}>{step}</li>)}</ul>
        </div>
      )}
    </div>
  )
}
