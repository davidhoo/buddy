import { useEffect, useState } from 'react'
import { TaskState, TaskSettings, Event } from '../../shared/types'
import { ResizeHandle } from './ResizeHandle'
import {
  ACTOR_TEXT,
  ACTOR_DISPLAY_NAME,
  Actor,
  taskActors,
  shortId,
  elapsedText,
  formatTime,
  decodeErrorText
} from '../lib/format'

interface StatusBarProps {
  isOpen: boolean
  width: number
  taskState: TaskState | null
  taskSettings: TaskSettings | null
  events: Event[]
  onSkipCountdown: () => void
  onPauseCountdown: () => void
  onInterrupt: () => void
  onResize: (delta: number) => void
}

const SESSION_FIELD: Record<Actor, keyof TaskState> = {
  claude: 'claude_session_id',
  codex: 'codex_thread_id',
  opencode: 'opencode_session_id',
  kimi: 'kimi_session_id'
}

export function StatusBar({
  isOpen,
  width,
  taskState,
  taskSettings,
  events,
  onSkipCountdown,
  onPauseCountdown,
  onInterrupt,
  onResize
}: StatusBarProps) {
  // 1s tick 让耗时/倒计时随时间走
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (!isOpen) return null

  const isRunning = taskState?.status?.startsWith('RUNNING_') ?? false
  const isCountdown = taskState?.status === 'COUNTDOWN' && taskState?.countdown?.status === 'running'

  const { participants } = taskActors(taskSettings)
  const activeRun = taskState?.active_run || null
  const runningActor = activeRun?.actor || ''
  const pendingBreak = taskState?.pending_break || null

  return (
    <div className="flex h-full">
      <ResizeHandle direction="left" onResize={onResize} />
      <div
        className="bg-bg-elevated border-l border-border flex flex-col h-full overflow-y-auto"
        style={{ width: `${width}px` }}
      >
        {/* 运行状态 */}
        <section className="p-4 border-b border-border">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">运行状态</h3>
          </div>
          <div className="flex items-center gap-3 text-xs text-fg-secondary mb-3">
            <span>轮次：{taskState?.round ?? '-'}</span>
            <span>更新：{taskState?.updated_at ? formatTime(taskState.updated_at) : '等待加载'}</span>
          </div>

          <div className="space-y-2">
            {participants.map((actor) => (
              <ActorCard
                key={actor}
                actor={actor}
                taskState={taskState}
                running={runningActor === actor}
                pendingBreak={pendingBreak}
              />
            ))}
          </div>

          {/* 倒计时 */}
          {isCountdown && taskState?.countdown && (
            <div className="mt-3 p-3 rounded-lg bg-bg-subtle flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">
                  {taskState.countdown.deadline
                    ? `${Math.max(0, Math.ceil((new Date(taskState.countdown.deadline).getTime() - Date.now()) / 1000))} 秒后继续`
                    : `${Math.max(0, Math.ceil(taskState.countdown.remaining ?? 0))} 秒后继续`
                  }
                </div>
                <div className="text-xs text-fg-secondary mt-0.5">
                  下一轮：{ACTOR_TEXT[taskState.countdown.default_next_actor || taskState.next_actor] || '-'}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={onPauseCountdown}
                  className="px-2 py-1 text-xs bg-bg-muted text-fg rounded hover:bg-bg-subtle"
                >
                  暂停
                </button>
                <button
                  onClick={onSkipCountdown}
                  className="px-2 py-1 text-xs bg-accent text-fg-inverse rounded hover:bg-accent-hover"
                >
                  跳过
                </button>
              </div>
            </div>
          )}

        </section>

        {/* 任务设置 */}
        <details open className="border-b border-border">
          <summary className="px-4 py-3 text-sm font-semibold cursor-pointer flex items-center justify-between hover:bg-bg-subtle select-none">
            <span>任务设置</span>
            <span className="text-xs font-normal text-fg-secondary">收起</span>
          </summary>
          <SettingsSummary settings={taskSettings} taskState={taskState} />
        </details>

        {/* 过程事件 */}
        <details open className="border-b border-border">
          <summary className="px-4 py-3 text-sm font-semibold cursor-pointer flex items-center justify-between hover:bg-bg-subtle select-none">
            <span>过程事件</span>
            <span className="text-xs font-normal text-fg-secondary">收起</span>
          </summary>
          <EventLog events={events} />
        </details>
      </div>
    </div>
  )
}

function ActorCard({
  actor,
  taskState,
  running,
  pendingBreak
}: {
  actor: Actor
  taskState: TaskState | null
  running: boolean
  pendingBreak: { actor?: string } | null
}) {
  const sessionField = SESSION_FIELD[actor]
  const session = (taskState?.[sessionField] as string | undefined) || ''
  const isRunningStatus = taskState?.status === `RUNNING_${actor.toUpperCase()}`
  const confirmNeeded = pendingBreak && pendingBreak.actor !== actor
  const stateText = isRunningStatus
    ? '运行中'
    : confirmNeeded
      ? '待确认结束'
      : session
        ? '已绑定会话'
        : '空闲'

  const stateBadgeClass = isRunningStatus
    ? 'bg-success-bg text-success-fg'
    : session
      ? 'bg-bg-muted text-fg-secondary'
      : 'text-fg-muted'

  const handleCopy = () => {
    if (!session) return
    navigator.clipboard.writeText(session).catch(() => {})
  }

  return (
    <div className={`rounded-lg border border-border-subtle p-3 ${running ? 'bg-bg-subtle' : 'bg-bg-elevated'}`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm font-medium">{ACTOR_DISPLAY_NAME[actor]}</span>
        <span className={`text-xs px-2 py-0.5 rounded ${stateBadgeClass}`}>{stateText}</span>
      </div>
      <div className="flex items-center gap-1 text-xs text-fg-secondary">
        <span>会话：{session ? shortId(session) : '未绑定'}</span>
        {session && (
          <button
            onClick={handleCopy}
            title="复制会话 ID"
            className="w-5 h-5 flex items-center justify-center rounded text-fg-muted hover:text-fg hover:bg-bg-muted"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        )}
      </div>
      <div className="text-xs text-fg-secondary mt-0.5">
        耗时：{running ? elapsedText(taskState?.active_run?.started_at) : '-'}
      </div>
    </div>
  )
}

function SettingsSummary({
  settings,
  taskState
}: {
  settings: TaskSettings | null
  taskState: TaskState | null
}) {
  const launchers = settings?.launchers || {}
  const hasCommands = Boolean(
    launchers.claude?.command && (launchers.codex?.command || launchers.opencode?.command)
  )
  const { impl, rev, participants } = taskActors(settings)
  const display = (v?: string) => (v ? ACTOR_TEXT[v] || v : '-')
  const repoRoot = taskState?.repo_root || '-'

  const isRunningInSettings = taskState?.status?.startsWith('RUNNING_') ?? false
  const nextActorDisplay = (() => {
    if (isRunningInSettings && taskState?.active_run?.actor) {
      return participants.find(a => a !== taskState.active_run!.actor) || taskState?.next_actor
    }
    if (taskState?.status === 'COUNTDOWN' && taskState?.countdown?.status === 'running' && taskState.countdown.default_next_actor) {
      return taskState.countdown.default_next_actor
    }
    return taskState?.next_actor
  })()

  const rows: Array<[string, string]> = [
    ['执行方', display(impl)],
    ['Reviewer', display(rev)],
    ['工作目录', repoRoot],
    ['启动命令', hasCommands ? '自定义命令' : '-'],
    ['倒计时', `${settings?.countdown_seconds ?? 30}s`],
    ['自动轮次', String(settings?.max_rounds ?? 10)],
    ['下一轮', display(nextActorDisplay)]
  ]

  return (
    <dl className="px-4 pb-3 space-y-1.5">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3 text-xs">
          <dt className="text-fg-secondary flex-shrink-0">{label}</dt>
          <dd className="font-medium text-right break-all">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function EventLog({ events }: { events: Event[] }) {
  if (!events.length) {
    return <div className="px-4 pb-4 text-xs text-fg-muted">暂无事件。</div>
  }
  const recent = events.slice(-10).reverse()
  return (
    <div className="px-4 pb-3 space-y-2">
      {recent.map((event) => {
        const failed =
          event.type?.endsWith('.failed') ||
          event.type?.endsWith('.error') ||
          Boolean((event.payload || {}).error)
        const summary = eventPayloadSummary(event)
        return (
          <div
            key={event.seq}
            className={`pl-2 border-l-2 ${failed ? 'border-danger' : 'border-border'}`}
          >
            <div className="text-xs font-medium">
              #{event.seq} · {event.type}
            </div>
            <div className="text-xs text-fg-secondary mt-0.5">
              {formatTime(event.ts)}
              {event.actor ? ` · ${ACTOR_TEXT[event.actor] || event.actor}` : ''}
            </div>
            {summary && (
              <pre className="mt-1 text-xs text-fg-secondary bg-bg-subtle rounded p-1.5 whitespace-pre-wrap break-words">
                {summary}
              </pre>
            )}
          </div>
        )
      })}
    </div>
  )
}

function eventPayloadSummary(event: Event): string {
  const payload = event.payload || {}
  const value = (payload.error as string | undefined) || (payload.text as string | undefined) || ''
  if (!value) return ''
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  const text = decodeErrorText(raw)
  return text.length > 1200 ? `${text.slice(0, 1200).trimEnd()}\n...（已截断）` : text
}
