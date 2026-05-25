import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ breaks: true, gfm: true })

export function renderMarkdown(text: string): string {
  try {
    const raw = marked.parse(text, { async: false }) as string
    return DOMPurify.sanitize(raw, { ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):)/i })
  } catch {
    return escapeHtml(text)
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
