import { useState, useRef, useEffect } from 'react'
import { TaskSettings, TaskState } from '../../shared/types'
import { taskActors, ACTOR_TEXT, Actor } from '../lib/format'

interface ComposerProps {
  onSend: (message: string, actor?: string) => void
  onStart: (actor?: string) => void
  onInterrupt: () => void
  isRunning: boolean
  isReady: boolean
  settings: TaskSettings | null
  taskState: TaskState | null
  autoStartSeconds: number
  draft: string
  onDraftChange: (value: string) => void
}

export function Composer({ onSend, onStart, onInterrupt, isRunning, isReady, settings, taskState, autoStartSeconds, draft, onDraftChange }: ComposerProps) {
  const { impl, participants } = taskActors(settings)
  const [nextActor, setNextActor] = useState<Actor>(impl)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prevStateNextRef = useRef<string | undefined>()

  // 计算真正的"下一轮承接方"
  // 运行中 → 取当前运行 actor 的另一方
  // 倒计时进行中 → 用 countdown.default_next_actor
  // 其他状态 → 用 next_actor || impl
  const computedNext = (() => {
    if (isRunning && taskState?.active_run?.actor) {
      return participants.find(a => a !== taskState.active_run!.actor) || impl
    }
    if (taskState?.status === 'COUNTDOWN' && taskState?.countdown?.status === 'running' && taskState.countdown.default_next_actor) {
      return taskState.countdown.default_next_actor
    }
    return taskState?.next_actor || impl
  })()

  // 只在后端状态目标 actor 变化时自动同步下拉框，用户手动选择不被覆盖
  useEffect(() => {
    if (computedNext && computedNext !== prevStateNextRef.current) {
      prevStateNextRef.current = computedNext
      if (participants.includes(computedNext as Actor)) {
        setNextActor(computedNext as Actor)
      }
    }
  }, [computedNext, participants])

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
    }
  }, [draft])

  const handleSend = () => {
    if (draft.trim()) {
      onSend(draft.trim(), nextActor)
      onDraftChange('')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      if (isRunning) return
      handleSend()
    }
  }

  // 按钮逻辑：运行中显示 stop，就绪无内容显示开始，其他显示发送
  const showStop = isRunning
  const showStart = isReady && !draft.trim() && !isRunning
  const showAutoStart = autoStartSeconds > 0 && isReady
  const handlePrimary = showStop ? onInterrupt : showStart ? () => onStart(nextActor) : handleSend
  const primaryDisabled = showStop ? false : showStart ? false : !draft.trim()

  return (
    <div className="px-4 pb-4 pt-2">
      <div className="rounded-2xl border border-border bg-bg-elevated px-4 pt-3 pb-2 shadow-sm">
        {/* 输入区 */}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isRunning ? '可先输入补充指令，打断后再发送' : '给下一轮的补充指令\n例如：先别改配置文件，下一轮只做审验。'}
          className="w-full resize-none bg-transparent border-0 outline-none text-sm leading-relaxed placeholder:text-fg-muted"
          rows={2}
        />

        {/* 工具栏 */}
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-1 text-xs text-fg-muted select-none">
            {showAutoStart ? (
              <span className="text-success-fg font-medium">{autoStartSeconds} 秒后自动开始…</span>
            ) : isRunning ? (
              '点击 ■ 打断当前运行'
            ) : (
              'Enter 换行，Shift+Enter 发送'
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* 「下一轮承接方」标签 */}
            <span className="text-xs text-fg-secondary select-none">
              下一轮承接方
            </span>

            {/* 承接方下拉 */}
            <div className="relative">
              <select
                value={nextActor}
                onChange={(e) => setNextActor(e.target.value as Actor)}
                className="appearance-none bg-transparent text-sm font-medium pr-5 pl-1 py-1 outline-none cursor-pointer hover:text-accent"
              >
                {participants.map(a => (
                  <option key={a} value={a}>{ACTOR_TEXT[a] || a}</option>
                ))}
              </select>
              <svg
                viewBox="0 0 16 16"
                width="10"
                height="10"
                className="absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none text-fg-muted"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="3 6 8 11 13 6" />
              </svg>
            </div>

            {/* 圆形按钮：运行中=stop，就绪=开始，其他=发送 */}
            <button
              onClick={handlePrimary}
              disabled={primaryDisabled}
              title={showStop ? '打断' : showStart ? '开始' : '发送'}
              className={`w-9 h-9 flex items-center justify-center rounded-full transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                showStop
                  ? 'bg-danger hover:bg-danger-hover text-fg-inverse'
                  : 'bg-accent text-fg-inverse hover:bg-accent-hover'
              }`}
            >
              {showStop ? (
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
