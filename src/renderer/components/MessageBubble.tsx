import { TranscriptEntry } from '../../shared/types'
import { renderMarkdown } from '../lib/markdown'
import { formatDuration, formatTime, decodeErrorText } from '../lib/format'

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

function formatMessageMeta(entry: TranscriptEntry): string {
  const meta = entry.meta || ({} as Record<string, unknown>)
  const parts: string[] = []
  const round = meta.round as number | undefined
  const elapsedMs = meta.elapsed_ms as number | null | undefined
  if (round) parts.push(`第 ${round} 轮`)
  if (elapsedMs != null) parts.push(formatDuration(elapsedMs))
  if (entry.ts) parts.push(formatTime(entry.ts))
  return parts.join(' · ')
}

export function MessageBubble({ entry }: MessageBubbleProps) {
  const isSystem = entry.role === 'system'
  const isHuman = entry.role === 'human'
  const meta = entry.meta || ({} as Record<string, unknown>)
  const isRoundNotice = isSystem && meta.kind === 'round_notice'

  if (isSystem && !isRoundNotice) {
    return (
      <div className="flex justify-center my-2">
        <div className="text-xs text-fg-muted bg-bg-muted px-3 py-1 rounded-full">
          {decodeErrorText(entry.content)}
        </div>
      </div>
    )
  }

  const html = renderMarkdown(entry.content)
  const cls = roleClasses[entry.role] || 'msg-default'
  const metaText = formatMessageMeta(entry)

  return (
    <div className={`flex mb-3 ${isHuman ? 'justify-end' : 'justify-start'}`}>
      <div className={`message ${cls} ${isRoundNotice ? 'round-notice' : ''} ${isHuman ? 'max-w-[82%]' : 'w-full'}`}>
        <div className="message-head">
          <span className="role">{isRoundNotice ? '系统通知' : formatRole(entry.role)}</span>
          {metaText && <span>{metaText}</span>}
        </div>
        <div
          className="message-body"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  )
}

function formatRole(role: string): string {
  const roleMap: Record<string, string> = {
    human: '你',
    claude: 'Claude',
    codex: 'Codex',
    opencode: 'OpenCode',
    kimi: 'Kimi'
  }
  return roleMap[role] || role
}
