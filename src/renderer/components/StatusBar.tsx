import { useEffect, useState } from 'react'
import { Copy, Play, RotateCw } from 'lucide-react'
import { TaskState, TaskSettings, TaskStatus, Event, Failure, GlobalSettings } from '../../shared/types'
import { ResizeHandle } from './ResizeHandle'
import { FileStatus as FileStatusSection, CommitModal, type CommitFeedback } from './FileStatus'
import { useGitStatus, type GitStatusResult } from '../hooks/useBuddy'
import {
  ACTOR_LABEL_KEY,
  Actor,
  actorColorVar,
  actorDisplayName,
  taskActors,
  formatTimeWithRelativeDate,
  decodeErrorText,
  eventPayloadSummary,
  eventTypeLabel
} from '../lib/format'
import { useLanguage, useT } from '../hooks/useI18n'
import type { TFunction } from '../hooks/useI18n'
import type { Language, TranslationKey } from '../lib/i18n'

interface StatusBarProps {
  isOpen: boolean
  width: number
  taskState: TaskState | null
  taskSettings: TaskSettings | null
  events: Event[]
  latestFailure: Failure | null
  globalSettings: GlobalSettings | null
  onInterrupt: () => void
  onRetry: () => void
  onResume: () => void
  onRetryHealthCheck: () => void
  isRetryingHealthCheck: boolean
  onResize: (delta: number) => void
}

interface CompactStatusInfo {
  cls: 'running' | 'paused' | 'done' | 'danger' | 'ready'
  labelKey: TranslationKey
  pulse: boolean
}

function compactStatusInfo(status: TaskStatus | null | undefined): CompactStatusInfo | null {
  if (!status) return null
  if (status.startsWith('RUNNING_')) {
    return { cls: 'running', labelKey: 'titleBar.status.running', pulse: true }
  }
  if (status === 'PAUSED') return { cls: 'paused', labelKey: 'status.PAUSED', pulse: false }
  if (status === 'DONE') return { cls: 'done', labelKey: 'status.DONE', pulse: false }
  if (status === 'FAILED') return { cls: 'danger', labelKey: 'status.FAILED', pulse: false }
  if (status === 'READY') return { cls: 'ready', labelKey: 'status.READY', pulse: false }
  if (status === 'QUEUED') return { cls: 'ready', labelKey: 'status.QUEUED', pulse: false }
  return null
}

const SESSION_FIELD: Record<string, keyof TaskState> = {
  claude: 'claude_session_id',
  codex: 'codex_thread_id',
  opencode: 'opencode_session_id',
  kimi: 'kimi_session_id'
}

const SEED_SESSION_FIELD: Record<string, keyof TaskSettings> = {
  claude: 'seed_claude_session_id',
  codex: 'seed_codex_thread_id',
  opencode: 'seed_opencode_session_id',
  kimi: 'seed_kimi_session_id'
}

export function StatusBar({
  isOpen,
  width,
  taskState,
  taskSettings,
  events,
  latestFailure,
  globalSettings,
  onInterrupt: _onInterrupt,
  onRetry,
  onResume,
  onRetryHealthCheck,
  isRetryingHealthCheck,
  onResize
}: StatusBarProps) {
  const t = useT()
  const lang = useLanguage()
  void _onInterrupt
  // 1s tick 让耗时随时间走
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const repoRoot = taskState?.repo_root || null
  const { data: gitStatus, isLoading: isGitLoading } = useGitStatus(repoRoot)
  const [showCommitModal, setShowCommitModal] = useState(false)
  const [commitFeedback, setCommitFeedback] = useState<CommitFeedback | null>(null)

  // Listen for ⌘M shortcut: open commit modal on user request
  useEffect(() => {
    const handler = () => { setCommitFeedback(null); setShowCommitModal(true) }
    window.addEventListener('buddy:commit', handler)
    return () => window.removeEventListener('buddy:commit', handler)
  }, [])

  if (!isOpen) return null

  const { participants } = taskActors(taskSettings)
  const activeRun = taskState?.active_run || null
  const runningActor = activeRun?.actor || ''

  const completedRound = taskState?.round ?? 0
  const roundLabel = taskState
    ? t('statusBar.roundCount', { n: completedRound })
    : t('statusBar.roundDash')

  const updatedText = taskState?.updated_at
    ? formatTimeWithRelativeDate(taskState.updated_at, lang)
    : t('statusBar.updatedWaiting')

  // Connectivity check failed: status FAILED with a populated health_check that recorded a failed actor.
  const healthCheck = taskState?.health_check
  const isHealthCheckFailed = taskState?.status === 'FAILED' && !!healthCheck?.failed_actor

  return (
    <div className="flex h-full">
      <ResizeHandle direction="left" onResize={onResize} />
      <div
        className="bg-bg-elevated border-l border-border flex flex-col h-full overflow-y-auto"
        style={{ width: `${width}px` }}
      >
        {/* 运行状态 */}
        <section className="p-4 border-b border-border">
          <div className="flex items-center justify-between gap-3 mb-2">
            <h3 className="text-sm font-semibold min-w-0">{t('statusBar.runStatus')}</h3>
            <InlineStatus
              status={taskState?.status}
              onRetry={onRetry}
              onResume={onResume}
              t={t}
            />
          </div>

          <FailureDetail
            status={taskState?.status}
            failure={latestFailure}
            t={t}
            lang={lang}
          />

          {isHealthCheckFailed && (
            <button
              onClick={onRetryHealthCheck}
              disabled={isRetryingHealthCheck}
              className="mb-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border-primary bg-bg-base text-fg hover:bg-bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RotateCw size={12} strokeWidth={2.5} className={isRetryingHealthCheck ? 'animate-spin' : ''} />
              {t('health_check.retry')}
            </button>
          )}

          <div className="flex items-center justify-between text-xs text-fg-secondary mb-3">
            <span>{roundLabel}</span>
            <span>{t('statusBar.updated', { time: updatedText })}</span>
          </div>

          <div className="space-y-2">
            {participants.map((actor) => (
              <ActorCard
                key={actor}
                actor={actor}
                taskSettings={taskSettings}
                taskState={taskState}
                running={runningActor === actor}
                t={t}
              />
            ))}
          </div>

        </section>

        {/* 文件状态 */}
        <FileStatusSection
          gitStatus={gitStatus}
          isLoading={isGitLoading}
          repoRoot={repoRoot}
          onOpenCommit={() => { setCommitFeedback(null); setShowCommitModal(true) }}
          commitFeedback={commitFeedback}
          onDismissFeedback={() => setCommitFeedback(null)}
        />

        {/* 过程事件 */}
        <details open className="border-b border-border">
          <summary className="px-4 py-3 text-sm font-semibold cursor-pointer flex items-center justify-between hover:bg-bg-subtle select-none">
            <span>{t('statusBar.events')}</span>
            <span className="text-xs font-normal text-fg-secondary">{t('common.collapse')}</span>
          </summary>
          <EventLog events={events} t={t} lang={lang} />
        </details>
      </div>

      {/* 提交弹窗 */}
      {showCommitModal && gitStatus && repoRoot && (
        <CommitModal
          gitStatus={gitStatus}
          repoRoot={repoRoot}
          globalSettings={globalSettings}
          onClose={() => {
            setShowCommitModal(false)
            requestAnimationFrame(() => {
              const active = document.activeElement
              if (active instanceof HTMLElement && active.closest('details')) {
                active.blur()
              }
            })
          }}
          onSuccess={(msg) => { setCommitFeedback({ type: 'success', message: msg, repoRoot: repoRoot || '' }); setShowCommitModal(false) }}
          onError={(msg) => { setCommitFeedback({ type: 'error', message: msg, repoRoot: repoRoot || '' }) }}
        />
      )}
    </div>
  )
}

function actorLabel(actor: string | undefined, t: TFunction): string {
  if (!actor) return '-'
  return ACTOR_LABEL_KEY[actor] ? t(ACTOR_LABEL_KEY[actor]) : actor
}

function InlineStatus({
  status,
  onRetry,
  onResume,
  t
}: {
  status: TaskStatus | undefined
  onRetry: () => void
  onResume: () => void
  t: TFunction
}) {
  const info = compactStatusInfo(status)
  if (!info) return null
  return (
    <div className="h-5 flex flex-shrink-0 items-center gap-1.5">
      <span className={`status-dot status-dot-${info.cls} ${info.pulse ? 'status-dot-pulse' : ''}`} />
      <span className={`text-xs font-medium status-text-${info.cls}`}>{t(info.labelKey)}</span>
      {status === 'PAUSED' && (
        <button
          onClick={onResume}
          title={t('statusBar.tooltipResume')}
          className="ml-0.5 w-5 h-5 flex items-center justify-center rounded text-fg-secondary hover:text-fg hover:bg-bg-muted"
        >
          <Play size={12} strokeWidth={2.5} fill="currentColor" />
        </button>
      )}
      {status === 'FAILED' && (
        <button
          onClick={onRetry}
          title={t('statusBar.tooltipRetry')}
          className="ml-0.5 w-5 h-5 flex items-center justify-center rounded text-fg-secondary hover:text-fg hover:bg-bg-muted"
        >
          <RotateCw size={12} strokeWidth={2.5} />
        </button>
      )}
    </div>
  )
}

function FailureDetail({
  status,
  failure,
  t,
  lang
}: {
  status: TaskStatus | undefined
  failure: Failure | null
  t: TFunction
  lang: Language
}) {
  if (status !== 'FAILED' || !failure?.message) return null
  const failureSnippet = truncate(decodeErrorText(failure.message), 240)
  const failureActor = failure.actor ? actorLabel(failure.actor, t) : ''
  const failureWhen = failure.ts ? formatTimeWithRelativeDate(failure.ts, lang) : ''
  return (
    <div className="mb-3 rounded-lg border border-danger bg-bg-subtle px-3 py-2 text-xs text-fg-secondary">
      {(failureActor || failureWhen) && (
        <div className="text-fg-muted mb-1">
          {failureActor}{failureActor && failureWhen ? ' · ' : ''}{failureWhen}
        </div>
      )}
      <pre className="whitespace-pre-wrap break-words font-sans leading-relaxed">
        {failureSnippet}
      </pre>
    </div>
  )
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}

function ActorCard({
  actor,
  taskSettings,
  taskState,
  running,
  t
}: {
  actor: Actor
  taskSettings: TaskSettings | null
  taskState: TaskState | null
  running: boolean
  t: TFunction
}) {
  const sessionField = SESSION_FIELD[actor]
  const hasProfileSession = Object.prototype.hasOwnProperty.call(taskState?.agent_sessions ?? {}, actor)
  const seedField = SEED_SESSION_FIELD[actor]
  const seedSession = taskSettings?.seed_agent_sessions?.[actor]
    || (seedField ? taskSettings?.[seedField] as string | undefined : undefined)
    || ''
  const session = hasProfileSession
    ? (taskState?.agent_sessions?.[actor] ?? '')
    : (sessionField ? (taskState?.[sessionField] as string | undefined) || seedSession : seedSession)
  const { impl, rev } = taskActors(taskSettings)
  const roleKey: TranslationKey | null =
    actor === impl ? 'statusBar.summary.implementer'
    : actor === rev ? 'statusBar.summary.reviewer'
    : null

  const handleCopy = () => {
    if (!session) return
    navigator.clipboard.writeText(session).catch(() => {})
  }

  return (
    <div className={`rounded-lg border p-3 bg-bg-elevated ${running ? '' : 'border-border-subtle'}`} style={running ? { borderColor: actorColorVar(actor, taskSettings) } : undefined}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm font-medium">{actorDisplayName(actor, taskSettings)}</span>
        {roleKey && <span className="text-xs text-fg-secondary">{t(roleKey)}</span>}
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-fg-secondary">
        <span className="min-w-0 truncate">{t('statusBar.actor.session', { id: session || '-' })}</span>
        {session && (
          <button
            onClick={handleCopy}
            title={t('statusBar.actor.copy')}
            className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-fg-muted hover:text-fg hover:bg-bg-muted"
          >
            <Copy size={12} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  )
}

function EventLog({ events, t, lang }: { events: Event[]; t: TFunction; lang: Language }) {
  const [expanded, setExpanded] = useState(false)
  if (!events.length) {
    return <div className="px-4 pb-4 text-xs text-fg-muted">{t('statusBar.eventsEmpty')}</div>
  }
  const canExpand = events.length > 10
  const displayed = expanded ? [...events].reverse() : events.slice(-10).reverse()
  return (
    <div className="px-4 pb-3 space-y-2">
      {displayed.map((event) => {
        const failed =
          event.type?.endsWith('.failed') ||
          event.type?.endsWith('.error') ||
          Boolean((event.payload || {}).error)
        const summary = eventPayloadSummary(event, lang)
        return (
          <div key={event.seq} className="text-xs">
            <div className="flex items-baseline justify-between gap-3">
              <span className={`truncate ${failed ? 'text-danger' : ''}`}>
                {event.seq} · {eventTypeLabel(event.type, lang)}
              </span>
              <span className="text-fg-secondary flex-shrink-0">
                {event.actor ? `${actorLabel(event.actor, t)} ` : ''}
                {formatTimeWithRelativeDate(event.ts, lang)}
              </span>
            </div>
            {summary && (
              <pre className="mt-1 text-xs text-fg-secondary bg-bg-subtle rounded p-1.5 whitespace-pre-wrap break-words">
                {summary}
              </pre>
            )}
          </div>
        )
      })}
      {canExpand && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="text-xs text-fg-secondary hover:text-fg py-1"
        >
          {expanded ? t('statusBar.eventsCollapse') : t('statusBar.eventsExpand')}
        </button>
      )}
    </div>
  )
}
