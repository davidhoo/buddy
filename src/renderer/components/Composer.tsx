import { useState, useRef, useEffect } from 'react'
import { ArrowUp, ChevronDown, Square } from 'lucide-react'
import { TaskSettings, TaskState } from '../../shared/types'
import { taskActors, ACTOR_LABEL_KEY, Actor } from '../lib/format'
import { useT, useSendShortcut } from '../hooks/useI18n'

interface ComposerProps {
  onSend: (message: string, actor?: string) => void
  onStart: (actor?: string) => void
  onInterrupt: () => void
  isRunning: boolean
  isReady: boolean
  settings: TaskSettings | null
  taskState: TaskState | null
  draft: string
  onDraftChange: (value: string) => void
}

export function Composer({ onSend, onStart, onInterrupt, isRunning, isReady, settings, taskState, draft, onDraftChange }: ComposerProps) {
  const t = useT()
  const { shortcut } = useSendShortcut()
  const { impl, participants } = taskActors(settings)
  const [nextActor, setNextActor] = useState<Actor>(impl)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prevStateNextRef = useRef<string | undefined>()

  // 计算真正的"下一轮承接方"
  // 运行中 → 取当前运行 actor 的另一方
  // 其他状态 → 用 next_actor || impl
  const computedNext = (() => {
    if (isRunning && taskState?.active_run?.actor) {
      return participants.find(a => a !== taskState.active_run!.actor) || impl
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
    if (e.key !== 'Enter') return
    // 让 IME 组合输入正常完成 (Chinese/Japanese 输入法)
    const ne = e.nativeEvent as KeyboardEvent & { isComposing?: boolean }
    if (ne.isComposing || ne.keyCode === 229) return
    // Cmd+Enter always sends/starts (regardless of send mode)
    if (e.metaKey) {
      e.preventDefault()
      e.stopPropagation()
      if (isRunning) return
      if (draft.trim()) {
        handleSend()
      } else if (isReady) {
        onStart(nextActor)
      }
      return
    }
    if (shortcut === 'cmd-enter') return
    const shouldSend = shortcut === 'enter' ? !e.shiftKey : e.shiftKey
    if (!shouldSend) return
    e.preventDefault()
    if (isRunning) return
    handleSend()
  }

  // 按钮逻辑：运行中显示 stop，就绪无内容显示开始，其他显示发送
  const showStop = isRunning
  const showStart = isReady && !draft.trim() && !isRunning
  const handlePrimary = showStop ? onInterrupt : showStart ? () => onStart(nextActor) : handleSend
  const primaryDisabled = showStop ? false : showStart ? false : !draft.trim()

  const placeholder = isRunning
    ? t('composer.placeholder.running')
    : t('composer.placeholder.idle')
  const sendHint = shortcut === 'enter' ? t('composer.hint.enter') : shortcut === 'shift-enter' ? t('composer.hint.shiftEnter') : t('composer.hint.cmdEnter')

  return (
    <div className="px-4 pb-4 pt-2">
      <div className="rounded-2xl border border-border bg-bg-elevated px-4 pt-3 pb-2 shadow-sm">
        {/* 输入区 */}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="w-full resize-none bg-transparent border-0 outline-none text-sm leading-relaxed placeholder:text-fg-muted"
          rows={2}
        />

        {/* 工具栏 */}
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-1 text-xs text-fg-muted select-none">
            {isRunning ? (
              t('composer.hint.running')
            ) : (
              sendHint
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* 「下一轮承接方」标签 */}
            <span className="text-xs text-fg-secondary select-none">
              {t('composer.nextHandoff')}
            </span>

            {/* 承接方下拉 */}
            <div className="relative">
              <select
                value={nextActor}
                onChange={(e) => setNextActor(e.target.value as Actor)}
                className="appearance-none bg-transparent text-sm font-medium pr-5 pl-1 py-1 outline-none cursor-pointer hover:text-accent"
              >
                {participants.map(a => (
                  <option key={a} value={a}>{t(ACTOR_LABEL_KEY[a])}</option>
                ))}
              </select>
              <ChevronDown
                size={10}
                strokeWidth={2}
                className="absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none text-fg-muted"
              />
            </div>

            {/* 圆形按钮：运行中=stop，就绪=开始，其他=发送 */}
            <button
              onClick={handlePrimary}
              disabled={primaryDisabled}
              title={showStop ? t('composer.button.interrupt') : showStart ? t('composer.button.start') : t('composer.button.send')}
              className={`w-9 h-9 flex items-center justify-center rounded-full transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                showStop
                  ? 'bg-danger hover:bg-danger-hover text-fg-inverse'
                  : 'bg-accent-primary text-fg-inverse hover:bg-accent-primary-hover'
              }`}
            >
              {showStop ? (
                <Square size={14} fill="currentColor" stroke="none" />
              ) : (
                <ArrowUp size={16} strokeWidth={2.5} />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
