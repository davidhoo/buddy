import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Plus, Terminal, X } from 'lucide-react'
import type { LibraryTarget } from '../../../shared/library'
import { useT } from '../../hooks/useI18n'
import { useLibraryActions } from '../../hooks/useLibrary'
import { AgentIcon } from '../settings/AgentIcon'

export function McpServerEditor({ targets, onClose }: { targets: LibraryTarget[]; onClose: () => void }) {
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  const [jsonMode, setJsonMode] = useState(false)
  const [transport, setTransport] = useState('stdio')
  const [pairs, setPairs] = useState<number[]>([])
  const nextPair = useRef(0)
  const [selected, setSelected] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [savedId, setSavedId] = useState<string>()
  const [error, setError] = useState('')
  const { addServer, setServer } = useLibraryActions()
  const available = targets.filter((target) => (target.capabilities.writeMcp || target.pendingInit) &&
    (jsonMode || transport !== 'sse' || target.mcpFormat !== 'toml-mcp_servers'))
  const chosen = available.filter((target) => selected.includes(target.targetId))

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    let id = savedId
    setSaving(true)
    setError('')
    try {
      if (!id) {
        let name = String(fields.get('name') || '').trim()
        let raw: Record<string, unknown>
        if (jsonMode) {
          try {
            const config = JSON.parse(String(fields.get('config')))
            const entries = Object.entries(config.mcpServers ?? config)
            if (entries.length !== 1) throw new Error()
            const [entryName, entry] = entries[0]
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error()
            name = entryName
            raw = entry as Record<string, unknown>
            raw = { ...raw, type: raw.type ?? raw.transport ?? (raw.url ? 'http' : 'stdio') }
          } catch {
            setError(t('library.mcp.invalidJson'))
            return
          }
        } else {
          const entries = Object.fromEntries(pairs.map((key) => [
            String(fields.get(`key-${key}`) || '').trim(), String(fields.get(`value-${key}`) || '')
          ]))
          const timeout = fields.get('timeout')
          raw = {
            type: transport,
            note: fields.get('note'),
            ...(timeout ? { startup_timeout_sec: Number(timeout) } : {}),
            ...(transport === 'stdio'
              ? { commandLine: fields.get('command'), env: entries }
              : { url: fields.get('url'), headers: entries })
          }
        }
        const result = await addServer.mutateAsync({ name, raw })
        if (result.status !== 'ok' || !result.id) {
          setError(result.message || t('library.mcp.saveError'))
          return
        }
        id = result.id
        setSavedId(id)
      }

      const failures: string[] = []
      for (const target of chosen) {
        try {
          const result = await setServer.mutateAsync({ serverId: id, targetId: target.targetId, enabled: true })
          if (result.status !== 'ok') {
            failures.push(`${target.displayName}: ${result.message || t('library.mcp.saveError')}`)
            continue
          }
          setSelected((current) => current.filter((key) => key !== target.targetId))
        } catch {
          failures.push(`${target.displayName}: ${t('library.mcp.saveError')}`)
        }
      }
      if (failures.length) setError(failures.join('\n'))
      else onClose()
    } catch {
      setError(t('library.mcp.saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <dialog ref={dialog} className="mcp-editor" aria-labelledby="mcp-editor-title"
      onCancel={(event) => { event.preventDefault(); if (!saving) onClose() }}>
      <form onSubmit={save}>
        <header className="mcp-editor-head">
          <h3 id="mcp-editor-title"><Terminal size={15} />{t('library.mcp.newServer')}</h3>
          <div className="mcp-segments">
            <button type="button" aria-pressed={!jsonMode} disabled={saving || !!savedId} onClick={() => setJsonMode(false)}>{t('library.mcp.form')}</button>
            <button type="button" aria-pressed={jsonMode} disabled={saving || !!savedId} onClick={() => setJsonMode(true)}>JSON</button>
          </div>
        </header>
        <fieldset className="mcp-editor-body" disabled={saving}>
          <fieldset className="mcp-editor-fields" disabled={!!savedId}>
            {jsonMode ? (
              <label className="mcp-field">{t('library.mcp.pasteJson')}
                <textarea name="config" rows={8} required placeholder={'{"mcpServers":{"my-server":{"url":"https://example.com/mcp"}}}'} />
              </label>
            ) : (
              <>
                <label className="mcp-field">{t('library.mcp.name')}
                  <span><input name="name" required autoFocus placeholder="github" /><small>{t('library.mcp.nameHint')}</small></span>
                </label>
                <label className="mcp-field">{t('library.mcp.note')}
                  <span><input name="note" maxLength={500} /><small>{t('library.mcp.noteHint')}</small></span>
                </label>
                <div className="mcp-field">
                  <span>{t('library.mcp.transport')}</span>
                  <div className="mcp-segments">
                    {['stdio', 'http', 'sse'].map((type) => (
                      <button key={type} type="button" aria-pressed={transport === type}
                        onClick={() => { if (type !== transport) setPairs([]); setTransport(type) }}>
                        {type === 'stdio' ? t('library.mcp.command') : type.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
                {transport === 'stdio' ? (
                  <label className="mcp-field">{t('library.mcp.command')}<input name="command" required placeholder="npx -y @example/mcp-server" /></label>
                ) : (
                  <label className="mcp-field">URL<input name="url" type="url" required placeholder="https://example.com/mcp" /></label>
                )}
                <div className="mcp-field">
                  <span>{t(transport === 'stdio' ? 'library.mcp.envLabel' : 'library.mcp.headersLabel')}</span>
                  <div className="mcp-pairs">
                    {pairs.map((key) => (
                      <div key={key} className="mcp-pair">
                        <input name={`key-${key}`} required aria-label={t('library.mcp.key')} placeholder={t('library.mcp.key')} />
                        <input name={`value-${key}`} aria-label={t('library.mcp.value')} placeholder={t('library.mcp.value')} />
                        <button className="library-btn" type="button" aria-label={t('library.mcp.removePair')}
                          onClick={() => setPairs((current) => current.filter((item) => item !== key))}><X size={13} /></button>
                      </div>
                    ))}
                    <button className="library-btn" type="button" onClick={() => {
                      const key = nextPair.current++
                      setPairs((current) => [...current, key])
                    }}><Plus size={13} />{t('library.mcp.addField')}</button>
                  </div>
                </div>
                <label className="mcp-field">{t('library.mcp.timeout')}
                  <span><input className="mcp-timeout" name="timeout" type="number" min={1} step={1} placeholder="30" />
                    <small>{t('library.mcp.timeoutHint')}</small></span>
                </label>
              </>
            )}
          </fieldset>
          {!!available.length && (
            <div className="mcp-field">
              <span>Agent</span>
              <div className="mcp-agent-options">
                <button className="library-btn" type="button" aria-pressed={chosen.length === available.length}
                  onClick={() => setSelected(chosen.length === available.length ? [] : available.map((target) => target.targetId))}>
                  {t('library.mcp.allAgents')}
                </button>
                {available.map((target) => (
                  <button key={target.targetId} type="button" className="library-btn" aria-pressed={selected.includes(target.targetId)}
                    onClick={() => setSelected((current) => current.includes(target.targetId)
                      ? current.filter((key) => key !== target.targetId) : [...current, target.targetId])}>
                    <AgentIcon id={target.agentId} size={14} />{target.displayName}
                    {target.configContext !== 'native' && ` (${target.configContext})`}
                  </button>
                ))}
              </div>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
        </fieldset>
        <footer className="mcp-editor-footer">
          <button className="library-btn" type="button" disabled={saving} onClick={onClose}>{t(savedId ? 'library.mcp.close' : 'common.cancel')}</button>
          <button className="library-btn mcp-editor-primary" type="submit" disabled={saving}>{t(savedId ? 'library.mcp.retry' : 'library.mcp.addField')}</button>
        </footer>
      </form>
    </dialog>
  )
}
