import { useState } from 'react'
import { FolderOpen, RefreshCw, Archive, FileText, Download, Undo2 } from 'lucide-react'
import { useT } from '../../hooks/useI18n'
import { useLibraryActions, useLibrarySnapshot } from '../../hooks/useLibrary'
import { AgentChips } from './AgentChips'
import { groupSkillTargets } from '../../../shared/library'
import './library.css'

export function SkillsPage() {
  const t = useT()
  const { data, isFetching } = useLibrarySnapshot()
  const [order, setOrder] = useState<'asc' | 'desc'>('asc')
  const { refresh, importSkills, setSkill, eject } = useLibraryActions()
  const busy = refresh.isPending || importSkills.isPending || setSkill.isPending || eject.isPending
  const skills = data?.skills || []
  const discovered = data?.discoveredSkills || []
  const targets = groupSkillTargets(data?.targets || [])

  const visibleSkills = [...skills]
    .sort((a, b) => order === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name))

  return (
    <div className="library-page">
      <div className="library-toolbar">
        <span className="library-count">{t('library.skills.count', { n: skills.length })}</span>
        <div className="library-toolbar-actions">
          <button className="library-btn" disabled={busy} onClick={() => refresh.mutate()} title={t('library.refresh')}>
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

      <section className="library-catalog" aria-labelledby="skills-catalog-title">
        <p className="skills-intro">{t('library.skills.intro')}</p>
        <div className="library-section-title">
          <span id="skills-catalog-title">{t('library.skills.managed')}</span>
          <div className="library-sort">
            <button type="button" className="library-btn" aria-pressed={order === 'asc'} onClick={() => setOrder('asc')}>A–Z</button>
            <button type="button" className="library-btn" aria-pressed={order === 'desc'} onClick={() => setOrder('desc')}>Z–A</button>
          </div>
        </div>
        <div className="library-list library-list-compact">
          {visibleSkills.map((skill) => (
            <div className="library-row" key={skill.id}>
              <span className="library-row-icon"><FileText size={15} aria-hidden="true" /></span>
              <div className="library-row-main">
                <div className="library-row-title">{skill.name}</div>
                <div className="library-row-sub">{skill.description || skill.libraryPath}</div>
                {skill.originPath && <div className="library-row-sub skills-origin" title={skill.originPath}>{skill.originPath}</div>}
              </div>
              <AgentChips
                targets={targets}
                assigned={skill.assignedTargetIds}
                linkSkillPhysicalKeys
                onToggle={(targetId, enabled) => setSkill.mutate({ skillId: skill.id, targetId, enabled })}
              />
              <div className="library-row-actions">
                <button className="library-btn danger" disabled={busy} aria-label={t('library.skills.eject')} title={t('library.skills.eject')} onClick={() => {
                  if (confirm(t('library.skills.ejectConfirm', { name: skill.name }))) eject.mutate(skill.id)
                }}><Undo2 size={13} /></button>
              </div>
            </div>
          ))}
          {!visibleSkills.length && (
            <div className="library-empty">
              {t('library.skills.emptyManaged')}
            </div>
          )}
        </div>
      </section>

      <div className="library-section-title">
        <span>{t('library.skills.discovered', { n: discovered.length })}</span>
        <button
          className="library-btn"
          disabled={busy || !discovered.length}
          onClick={() => importSkills.mutate(discovered.map((d) => d.discoveryId))}
        ><Download size={13} />{t('library.importAll')}</button>
      </div>
      <div className="library-list">
        {discovered.map((item) => (
          <div className="library-row" key={item.discoveryId}>
            <div className="library-row-main">
              <div className="library-row-title">{item.name}</div>
              <div className="library-row-sub">
                {item.agentId} · {item.path}
                {item.importBlockedReason === 'git-root' ? ` · ${t('library.skills.gitRoot')}` : ''}
                {item.importBlockedReason === 'symlink' ? ` · ${t('library.skills.symlink')}` : ''}
              </div>
            </div>
            <div />
            <div className="library-row-actions">
              <button className="library-btn" disabled={busy} onClick={() => importSkills.mutate([item.discoveryId])}>
                <Download size={13} />{t('library.import')}
              </button>
            </div>
          </div>
        ))}
        {!discovered.length && <div className="library-empty">{t('library.skills.emptyDiscovered')}</div>}
      </div>
    </div>
  )
}
