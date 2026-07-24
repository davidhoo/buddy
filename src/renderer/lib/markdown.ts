import { marked, Tokenizer } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ breaks: true, gfm: true })

// marked's GFM autolink only backpedals trailing ASCII punctuation, so CJK
// punctuation (，。（） etc.) right after a bare URL gets swallowed into the
// link. Such characters can never appear unencoded in a URL, so trim the
// match at the first non-ASCII-printable char, then re-run the default
// tokenizer on the trimmed text to keep escaping / www. handling intact.
const defaultUrl = Tokenizer.prototype.url
const NON_URL_CHAR = /[^\x21-\x7e]/

marked.use({
  tokenizer: {
    url(src: string) {
      const token = defaultUrl.call(this, src)
      if (!token) return undefined
      if (!token.href.startsWith('mailto:')) {
        const cut = token.raw.search(NON_URL_CHAR)
        if (cut > 0) return defaultUrl.call(this, token.raw.slice(0, cut))
      }
      return token
    },
  },
})

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
