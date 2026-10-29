import { useId, useRef } from 'react'
import { Braces } from 'lucide-react'
import { useT } from '../../hooks/useI18n'

/** Highlight tokens as React text nodes: values are never interpreted as HTML. */
function highlightJson(value: string) {
  const tokens = value.split(/("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b|[{}\[\],:])/g)
  return tokens.map((token, index) => {
    const kind = /^".*:\s*$/s.test(token) ? 'key' : token.startsWith('"') ? 'string'
      : /^-?\d/.test(token) ? 'number' : /^(true|false|null)$/.test(token) ? 'literal' : 'punctuation'
    return <span key={index} className={`json-token-${kind}`}>{token}</span>
  })
}

export function JsonEditor({ label, value, onChange, error }: {
  label: string
  value: string
  onChange: (value: string) => void
  error: string
}) {
  const t = useT(), id = useId()
  const highlight = useRef<HTMLPreElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  let validJson = true
  try { JSON.parse(value) } catch { validJson = false }
  const format = () => {
    if (!validJson) return
    onChange(JSON.stringify(JSON.parse(value), null, 2))
    input.current?.focus()
  }
  return <div className="agent-advanced-field">
    <div className="json-editor-toolbar">
      <label htmlFor={id}>{label}</label>
      <button type="button" className="agent-text-button" disabled={!validJson} aria-label={`${label} · ${t('agents.formatJson')}`} onClick={format}><Braces size={12} />{t('agents.formatJson')}</button>
    </div>
    <div className="json-editor" data-invalid={!!error}>
      <pre ref={highlight} aria-hidden="true">{highlightJson(value)}{'\n'}</pre>
      <textarea ref={input} id={id} value={value} onChange={event => onChange(event.target.value)}
        rows={Math.min(12, Math.max(4, value.split('\n').length))} wrap="off" spellCheck={false} autoComplete="off" autoCapitalize="off"
        aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined}
        onScroll={event => { if (highlight.current) { highlight.current.scrollTop = event.currentTarget.scrollTop; highlight.current.scrollLeft = event.currentTarget.scrollLeft } }}
      />
    </div>
    {error && <span id={`${id}-error`} role="alert" className="text-danger">{validJson ? error : t('agents.invalidJson')}</span>}
  </div>
}
