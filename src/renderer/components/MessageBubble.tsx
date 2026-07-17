import { useState, useEffect } from 'react'
import { ChevronDown, ChevronUp, Wrench, Terminal, FilePen, FileText, Brain, FileCode2, File, FileJson, FileArchive, FileSpreadsheet, Image as ImageIcon, RotateCw } from 'lucide-react'
import { AttachmentMeta, TranscriptEntry, RoundEventSummary, RoundEventEntry, TaskStats } from '../../shared/types'
import { renderMarkdown } from '../lib/markdown'
import { formatDuration, formatTimeWithRelativeDate, decodeErrorText, unescapeText, ACTOR_LABEL_KEY, actorText } from '../lib/format'
import { useLanguage, useT } from '../hooks/useI18n'
import { useRoundEvents } from '../hooks/useBuddy'
import { translate } from '../lib/i18n'

interface MessageBubbleProps {
  entry: TranscriptEntry
  taskId?: string
  workspaceKey?: string
  onRetryHealthCheck?: () => void
  isRetryingHealthCheck?: boolean
}

const roleClasses: Record<string, string> = {
  human: 'msg-human',
  claude: 'msg-claude',
  codex: 'msg-codex',
  opencode: 'msg-opencode',
  kimi: 'msg-kimi',
  cursor: 'msg-cursor',
  'cursor-agent': 'msg-cursor',
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
  const [error, setError] = useState(false)

  useEffect(() => {
    let revoked = false
    setError(false)
    window.api.readFileAsDataURL(path, mimeType).then(url => {
      if (!revoked) setSrc(url)
    }).catch(() => {
      if (!revoked) setError(true)
    })
    return () => { revoked = true }
  }, [path, mimeType])

  if (error) {
    const name = path.split('/').pop() ?? path
    return (
      <div className="h-20 w-20 flex flex-col items-center justify-center bg-bg-subtle rounded-lg gap-1">
        <ImageIcon size={16} className="text-fg-muted" />
        <span className="text-[9px] text-fg-muted truncate max-w-[72px]">{name}</span>
      </div>
    )
  }

  if (!src) {
    return (
      <div className="h-20 w-20 flex items-center justify-center bg-bg-subtle rounded-lg">
        <ImageIcon size={20} className="text-fg-muted animate-pulse" />
      </div>
    )
  }

  return <img src={src} alt="" className="h-20 w-auto max-w-[160px] rounded-lg object-cover" />
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])

function isImageAttachmentMeta(a: AttachmentMeta): boolean {
  if (a.mimeType.startsWith('image/')) return true
  if (!a.mimeType) {
    const ext = a.name.split('.').pop()?.toLowerCase() ?? ''
    if (IMAGE_EXTS.has(ext)) return true
  }
  return false
}

function resolveMimeType(a: AttachmentMeta): string {
  if (a.mimeType) return a.mimeType
  const ext = a.name.split('.').pop()?.toLowerCase() ?? ''
  if (IMAGE_EXTS.has(ext)) return `image/${ext === 'jpg' ? 'jpeg' : ext}`
  return 'application/octet-stream'
}

function AttachmentPreviews({ attachments }: { attachments: AttachmentMeta[] }) {
  const imageAtts = attachments.filter(a => isImageAttachmentMeta(a))
  const fileAtts = attachments.filter(a => !isImageAttachmentMeta(a))

  return (
    <div className="space-y-2 mb-2">
      {imageAtts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {imageAtts.map((att, i) => (
            <div key={i} className="rounded-lg overflow-hidden border border-border bg-bg-base">
              <ImagePreview path={att.path} mimeType={resolveMimeType(att)} />
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

function renderHealthCheckText(entry: TranscriptEntry, lang: ReturnType<typeof useLanguage>): string | null {
  const meta = entry.meta as Record<string, unknown> | undefined
  if (!meta) return null
  const kind = meta.kind as string | undefined
  if (kind !== 'health_check' && kind !== 'health_check_failed') return null

  const content = entry.content
  if (content === 'health_check.started') {
    const actors = (meta.actors as string[]) || []
    const actorNames = actors.map(a => actorText(a, lang)).join(lang === 'en' ? ' and ' : ' 和 ')
    if (lang === 'en') return `Checking ${actorNames} connectivity…`
    if (lang === 'zh-TW') return `正在檢查 ${actorNames} 的連通性…`
    return `正在检查 ${actorNames} 的连通性…`
  }
  if (content === 'health_check.passed') {
    const sessionIds = (meta.session_ids as { actor: string; session_id: string | null }[]) || []
    const details = sessionIds.map(({ actor, session_id }) => {
      const name = actorText(actor, lang)
      const ready = translate(lang, 'health_check.actorPassed').replace('{actor}', name)
      if (session_id) return `${ready}，${lang === 'en' ? 'session' : '会话'} ID: ${session_id.slice(0, 12)}...`
      return ready
    })
    return details.join(lang === 'en' ? '; ' : '；') + '。' + translate(lang, 'health_check.allPassed')
  }
  if (content === 'health_check.failed') {
    const failedActor = (meta.failed_actor as string) || ''
    const failedReason = (meta.failed_reason as string) || ''
    const name = actorText(failedActor, lang)
    const reason = failedReason || (lang === 'en' ? 'Unknown error' : '未知错误')
    const failed = translate(lang, 'health_check.actorFailed').replace('{actor}', name).replace('{reason}', reason)
    return failed + '。' + translate(lang, 'health_check.failed') + (lang === 'en' ? '. Please check if the CLI is installed and available.' : '。请检查对应 CLI 是否已安装并可用。')
  }
  return null
}

export function MessageBubble({ entry, taskId, workspaceKey, onRetryHealthCheck, isRetryingHealthCheck }: MessageBubbleProps) {
  const t = useT()
  const lang = useLanguage()
  const isSystem = entry.role === 'system'
  const isHuman = entry.role === 'human'
  const meta = entry.meta || ({} as Record<string, unknown>)
  const isRoundNotice = isSystem && meta.kind === 'round_notice'
  const isHealthCheck = isSystem && (meta.kind === 'health_check' || meta.kind === 'health_check_failed')
  const isHealthCheckFailed = isSystem && meta.kind === 'health_check_failed'
  const metaAttachments = (meta.attachments as AttachmentMeta[] | undefined)
  const runId = meta.run_id as string | undefined

  let bodyText = isSystem && !isRoundNotice && !isHealthCheck ? decodeErrorText(entry.content) : unescapeText(entry.content)

  // Health check messages: render via i18n if structured key detected
  if (isHealthCheck) {
    const i18nText = renderHealthCheckText(entry, lang)
    if (i18nText) bodyText = i18nText
  }

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
  const cls = roleClasses[entry.role]
    || (entry.meta?.backend === 'cursor' || entry.role.startsWith('cursor-agent-') ? 'msg-cursor' : 'msg-default')
  const metaText = formatMessageMeta(entry, lang)

  const roleLabel = isRoundNotice || isHealthCheck
    ? t('actor.systemNotice')
    : typeof entry.meta?.display_name === 'string' && entry.meta.display_name
      ? entry.meta.display_name
    : ACTOR_LABEL_KEY[entry.role]
      ? t(ACTOR_LABEL_KEY[entry.role])
      : entry.role

  const noticeClass = isRoundNotice ? 'round-notice' : isHealthCheckFailed ? 'health-check-failed' : isHealthCheck ? 'health-check' : ''
  const isTaskDone = isRoundNotice && meta.done_reason === 'dual_break_confirmed'
  const taskDoneStats = isTaskDone ? (meta.stats as TaskStats | undefined) : undefined

  return (
    <div className={`flex mb-3 ${isHuman ? 'justify-end' : 'justify-start'}`}>
      <div className={`message ${cls} ${noticeClass} ${isHuman ? 'min-w-[66.666667%] max-w-[82%]' : 'w-full'}`}>
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
        {isHealthCheckFailed && onRetryHealthCheck && (
          <div className="mt-2">
            <button
              type="button"
              onClick={onRetryHealthCheck}
              disabled={isRetryingHealthCheck}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-danger/40 bg-bg-base text-danger hover:bg-danger/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RotateCw size={12} strokeWidth={2.5} className={isRetryingHealthCheck ? 'animate-spin' : ''} />
              {t('health_check.retry')}
            </button>
          </div>
        )}
        {runId && !isHuman && !isSystem && taskId && workspaceKey && (
          <RoundEvents taskId={taskId} runId={runId} workspaceKey={workspaceKey} actor={entry.role} elapsedMs={meta.elapsed_ms as number | undefined} />
        )}
        {taskDoneStats ? (
          <TaskDoneStats stats={taskDoneStats} />
        ) : null}
      </div>
    </div>
  )
}

function RoundEvents({ taskId, runId, workspaceKey, actor, elapsedMs }: { taskId: string; runId: string; workspaceKey: string; actor: string; elapsedMs?: number }) {
  const t = useT()
  const lang = useLanguage()
  const [expanded, setExpanded] = useState(false)
  const { data, isLoading } = useRoundEvents(taskId, runId, workspaceKey, actor)

  // No data or empty events + no stats → hide the button entirely
  if (!data && !isLoading) return null
  if (data && data.events.length === 0 && data.inputTokens === 0 && data.outputTokens === 0) return null

  const toggleLabel = expanded
    ? t('common.collapse')
    : t('roundEvents.expand')

  return (
    <div className="round-events-section">
      <button
        type="button"
        className="round-events-toggle"
        onClick={() => setExpanded(prev => !prev)}
      >
        <Wrench size={12} />
        <span>{toggleLabel}</span>
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {expanded && (
        <div className="round-events-content">
          {isLoading ? (
            <div className="round-events-loading">...</div>
          ) : !data ? null : (
            <>
              <div className="round-events-timeline">
                {data.events.map((entry, i) => (
                  <RoundEventItem key={i} entry={entry} lang={lang} />
                ))}
              </div>
              <div className="round-events-stats">
                {(data.inputTokens > 0 || data.outputTokens > 0) && (
                  <span>In: {data.inputTokens.toLocaleString()} · Out: {data.outputTokens.toLocaleString()}</span>
                )}
                {(elapsedMs != null || data.durationMs != null) && (
                  <span>{formatDuration(elapsedMs ?? data.durationMs!)}</span>
                )}
                {data.model && (
                  <span className="round-events-model">{data.model}</span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function TaskDoneStats({ stats }: { stats: TaskStats }) {
  const t = useT()
  const lang = useLanguage()

  if (!stats || stats.actors.length === 0) return null

  return (
    <div className="task-done-stats">
      <table className="task-done-stats-table">
        <thead>
          <tr>
            <th />
            <th>{t('taskStats.model')}</th>
            <th>{t('taskStats.input')}</th>
            <th>{t('taskStats.output')}</th>
            <th>{t('taskStats.cache')}</th>
            <th>{t('taskStats.duration')}</th>
            <th>{t('taskStats.rounds')}</th>
          </tr>
        </thead>
        <tbody>
          {stats.actors.map((a) => (
            <tr key={a.actor}>
              <td className="task-done-stats-actor">{actorText(a.actor, lang)}</td>
              <td className="task-done-stats-model">{a.model ?? '-'}</td>
              <td className="task-done-stats-num">{a.inputTokens.toLocaleString()}</td>
              <td className="task-done-stats-num">{a.outputTokens.toLocaleString()}</td>
              <td className="task-done-stats-num">{a.cacheReadTokens.toLocaleString()}</td>
              <td>{formatDuration(a.durationMs)}</td>
              <td className="task-done-stats-num">{a.rounds}</td>
            </tr>
          ))}
          <tr className="task-done-stats-total">
            <td>{t('taskStats.total')}</td>
            <td />
            <td className="task-done-stats-num">{stats.totalInputTokens.toLocaleString()}</td>
            <td className="task-done-stats-num">{stats.totalOutputTokens.toLocaleString()}</td>
            <td className="task-done-stats-num">{stats.totalCacheReadTokens.toLocaleString()}</td>
            <td>{formatDuration(stats.totalDurationMs)}</td>
            <td className="task-done-stats-num">{stats.totalRounds}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function RoundEventItem({ entry, lang }: { entry: RoundEventEntry; lang: 'zh-CN' | 'zh-TW' | 'en' }) {
  if (entry.type === 'thinking') {
    return (
      <div className="round-events-item round-events-thinking">
        <Brain size={12} />
        <span>{lang === 'en' ? 'Reasoning' : '推理中'} ({entry.thinkingLength}ch)</span>
      </div>
    )
  }

  if (entry.type === 'text') {
    const preview = truncate(entry.text ?? '', 120)
    if (!preview) return null
    return (
      <div className="round-events-item round-events-text">
        <FileText size={12} />
        <span>{preview}</span>
      </div>
    )
  }

  if (entry.type === 'tool_use') {
    return (
      <div className="round-events-item round-events-tool">
        {toolIcon(entry.toolName ?? '')}
        <span className="round-events-tool-name">{entry.toolName}</span>
        <span className="round-events-tool-input">
          {formatToolInput(entry.toolName ?? '', entry.toolInput ?? {}, lang)}
        </span>
      </div>
    )
  }

  if (entry.type === 'tool_result') {
    const preview = truncate(entry.toolResultPreview ?? '', 80)
    return (
      <div className={`round-events-item round-events-result ${entry.isError ? 'round-events-result-error' : ''}`}>
        <span className="round-events-result-arrow">↳</span>
        <span>{preview}{entry.isError ? ' (error)' : ''}</span>
      </div>
    )
  }

  return null
}

function toolIcon(name: string) {
  const n = name.toLowerCase()
  if (n === 'bash') return <Terminal size={12} className="shrink-0" />
  if (n === 'edit' || n === 'write') return <FilePen size={12} className="shrink-0" />
  if (n === 'read') return <FileText size={12} className="shrink-0" />
  if (n === 'grep' || n === 'glob') return <FileCode2 size={12} className="shrink-0" />
  return <Wrench size={12} className="shrink-0" />
}

function formatToolInput(name: string, input: Record<string, unknown>, lang: 'zh-CN' | 'zh-TW' | 'en'): string {
  const n = name.toLowerCase()
  if (n === 'bash') {
    const cmd = input.command as string | undefined
    return cmd ? truncate(cmd, 80) : ''
  }
  if (n === 'edit' || n === 'write') {
    const fp = input.file_path as string | undefined
    return fp ? truncate(fp.split('/').pop() ?? fp, 60) : ''
  }
  if (n === 'read') {
    const fp = input.file_path as string | undefined
    return fp ? truncate(fp.split('/').pop() ?? fp, 60) : ''
  }
  if (n === 'grep' || n === 'glob') {
    const pattern = input.pattern as string | undefined
    const path = input.path as string | undefined
    const parts: string[] = []
    if (pattern) parts.push(truncate(pattern, 40))
    if (path) parts.push(truncate(path.split('/').pop() ?? path, 30))
    return parts.join(' → ')
  }
  if (n === 'task' || n === 'agent') {
    const desc = input.description as string | undefined
    return desc ? truncate(desc, 60) : ''
  }
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  const first = input[keys[0]]
  if (typeof first === 'string') return truncate(first, 60)
  return truncate(JSON.stringify(first), 60)
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\n/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max) + '...' : oneLine
}

function formatMessageMeta(entry: TranscriptEntry, lang: ReturnType<typeof useLanguage>): string {
  const meta = entry.meta || ({} as Record<string, unknown>)
  const parts: string[] = []
  const round = meta.round as number | undefined
  const elapsedMs = meta.elapsed_ms as number | null | undefined
  const isRoundNotice = entry.role === 'system' && meta.kind === 'round_notice'
  const isHealthCheck = entry.role === 'system' && (meta.kind === 'health_check' || meta.kind === 'health_check_failed')
  if (round && !isRoundNotice && !isHealthCheck) {
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
