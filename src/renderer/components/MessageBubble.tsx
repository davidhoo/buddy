import { useState, useEffect } from 'react'
import { FileText, FileCode2, File, FileJson, FileArchive, FileSpreadsheet, Image as ImageIcon } from 'lucide-react'
import { AttachmentMeta, TranscriptEntry } from '../../shared/types'
import { renderMarkdown } from '../lib/markdown'
import { formatDuration, formatTimeWithRelativeDate, decodeErrorText, unescapeText, ACTOR_LABEL_KEY } from '../lib/format'
import { useLanguage, useT } from '../hooks/useI18n'

interface MessageBubbleProps {
  entry: TranscriptEntry
}

const roleClasses: Record<string, string> = {
  human: 'msg-human',
  claude: 'msg-claude',
  codex: 'msg-codex',
  opencode: 'msg-opencode',
  kimi: 'msg-kimi',
  system: 'msg-system'
}

function fileExt(name: string): string {
  return name.split('.').pop()?.toUpperCase() ?? ''
}

const EXT_ICON_MAP: Record<string, typeof File> = {
  json: FileJson,
  zip: FileArchive, tar: FileArchive, gz: FileArchive, rar: FileArchive, '7z': FileArchive,
  csv: FileSpreadsheet, xls: FileSpreadsheet, xlsx: FileSpreadsheet,
  ts: FileCode2, tsx: FileCode2, js: FileCode2, jsx: FileCode2,
  py: FileCode2, go: FileCode2, rs: FileCode2, rb: FileCode2,
  java: FileCode2, c: FileCode2, cpp: FileCode2, h: FileCode2,
  swift: FileCode2, kt: FileCode2,
  md: FileText, txt: FileText, rtf: FileText,
  doc: FileText, docx: FileText, pdf: FileText,
  xml: FileText, yaml: FileText, yml: FileText, toml: FileText,
  png: ImageIcon, jpg: ImageIcon, jpeg: ImageIcon, gif: ImageIcon,
  webp: ImageIcon, svg: ImageIcon, bmp: ImageIcon, ico: ImageIcon,
}

function fileIconForName(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return EXT_ICON_MAP[ext] ?? File
}

function ImagePreview({ path, mimeType }: { path: string; mimeType: string }) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let revoked = false
    window.api.readFileAsDataURL(path, mimeType).then(url => {
      if (!revoked) setSrc(url)
    }).catch(() => {})
    return () => { revoked = true }
  }, [path, mimeType])

  if (!src) {
    return (
      <div className="h-20 w-20 flex items-center justify-center bg-bg-subtle rounded-lg">
        <ImageIcon size={20} className="text-fg-muted" />
      </div>
    )
  }

  return <img src={src} alt="" className="h-20 w-auto max-w-[160px] rounded-lg object-cover" />
}

function AttachmentPreviews({ attachments }: { attachments: AttachmentMeta[] }) {
  const imageAtts = attachments.filter(a => a.mimeType.startsWith('image/'))
  const fileAtts = attachments.filter(a => !a.mimeType.startsWith('image/'))

  return (
    <div className="space-y-2 mb-2">
      {imageAtts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {imageAtts.map((att, i) => (
            <div key={i} className="rounded-lg overflow-hidden border border-border bg-bg-base">
              <ImagePreview path={att.path} mimeType={att.mimeType} />
            </div>
          ))}
        </div>
      )}
      {fileAtts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {fileAtts.map((att, i) => {
            const Icon = fileIconForName(att.name)
            const ext = fileExt(att.name)
            return (
              <div
                key={i}
                className="rounded-lg border border-border bg-bg-base px-2.5 py-1.5 flex items-center gap-2.5 max-w-[220px]"
              >
                <Icon size={28} className="flex-shrink-0 text-fg-muted" />
                <div className="flex-1 min-w-0">
                  <div className="truncate text-xs text-fg-secondary">{att.name}</div>
                  {ext && <div className="text-[10px] text-fg-muted">{ext}</div>}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function parseAttachmentsFromContent(content: string): { attachments: AttachmentMeta[]; cleaned: string } {
  const match = content.match(/\n*\[Attachments\]\n((?:- .*\n?)+)/)
  if (!match) return { attachments: [], cleaned: content }

  const lines = match[1].split('\n').filter(l => l.startsWith('- '))
  const attachments: AttachmentMeta[] = []
  for (const line of lines) {
    const raw = line.slice(2).trim()
    let path = raw
    try {
      const url = new URL(raw)
      if (url.protocol === 'file:') path = decodeURIComponent(url.pathname)
    } catch {}
    const name = path.split('/').pop() ?? path
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']
    const mimeType = imageExts.includes(ext) ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream'
    attachments.push({ path, name, mimeType, size: 0 })
  }

  const cleaned = content.replace(/\n*\[Attachments\]\n(?:- .*\n?)+/g, '').trim()
  return { attachments, cleaned }
}

export function MessageBubble({ entry }: MessageBubbleProps) {
  const t = useT()
  const lang = useLanguage()
  const isSystem = entry.role === 'system'
  const isHuman = entry.role === 'human'
  const meta = entry.meta || ({} as Record<string, unknown>)
  const isRoundNotice = isSystem && meta.kind === 'round_notice'
  const metaAttachments = (meta.attachments as AttachmentMeta[] | undefined)

  let bodyText = isSystem && !isRoundNotice ? decodeErrorText(entry.content) : unescapeText(entry.content)

  // Resolve attachments: prefer meta.attachments, fall back to parsing from content
  let displayAttachments = metaAttachments
  if (displayAttachments && displayAttachments.length > 0) {
    bodyText = bodyText.replace(/\n*\[Attachments\]\n(?:- .*\n?)+/g, '').trim()
  } else if (bodyText.includes('[Attachments]')) {
    const parsed = parseAttachmentsFromContent(bodyText)
    displayAttachments = parsed.attachments.length > 0 ? parsed.attachments : undefined
    bodyText = parsed.cleaned
  }

  const html = renderMarkdown(bodyText)
  const cls = roleClasses[entry.role] || 'msg-default'
  const metaText = formatMessageMeta(entry, lang)

  const roleLabel = isRoundNotice
    ? t('actor.systemNotice')
    : ACTOR_LABEL_KEY[entry.role]
      ? t(ACTOR_LABEL_KEY[entry.role])
      : entry.role

  return (
    <div className={`flex mb-3 ${isHuman ? 'justify-end' : 'justify-start'}`}>
      <div className={`message ${cls} ${isRoundNotice ? 'round-notice' : ''} ${isHuman ? 'min-w-[66.666667%] max-w-[82%]' : 'w-full'}`}>
        <div className="message-head">
          <span className="role">{roleLabel}</span>
          {metaText && <span>{metaText}</span>}
        </div>
        {displayAttachments && displayAttachments.length > 0 && (
          <AttachmentPreviews attachments={displayAttachments} />
        )}
        <div
          className="message-body"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  )
}

function formatMessageMeta(entry: TranscriptEntry, lang: ReturnType<typeof useLanguage>): string {
  const meta = entry.meta || ({} as Record<string, unknown>)
  const parts: string[] = []
  const round = meta.round as number | undefined
  const elapsedMs = meta.elapsed_ms as number | null | undefined
  const isRoundNotice = entry.role === 'system' && meta.kind === 'round_notice'
  if (round && !isRoundNotice) {
    const roundLabel =
      lang === 'en' ? `Round ${round}`
        : lang === 'zh-TW' ? `第 ${round} 輪`
          : `第 ${round} 轮`
    parts.push(roundLabel)
  }
  if (elapsedMs != null) parts.push(formatDuration(elapsedMs))
  if (entry.ts) parts.push(formatTimeWithRelativeDate(entry.ts, lang))
  return parts.join(' · ')
}
