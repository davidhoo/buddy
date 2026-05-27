import { useCallback, useEffect, useRef, useState } from 'react'
import { TaskDetail } from '../../shared/types'
import { MessageBubble } from './MessageBubble'
import { RunningStatusMessage } from './RunningStatusMessage'
import { Composer } from './Composer'
import { isTaskReadyToStart } from '../lib/taskState'
import { useT } from '../hooks/useI18n'
import { renderMarkdown } from '../lib/markdown'

interface ChatAreaProps {
  task: TaskDetail | null
  onSendMessage: (message: string, actor?: string) => void
  onStartTask: (actor?: string) => void
  onInterrupt: () => void
  autoStartSeconds: number
  draft: string
  onDraftChange: (value: string) => void
}

export function ChatArea({ task, onSendMessage, onStartTask, onInterrupt, autoStartSeconds, draft, onDraftChange }: ChatAreaProps) {
  const t = useT()
  const transcriptRef = useRef<HTMLDivElement>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const userScrolledUp = useRef(false)

  const isNearBottom = useCallback(() => {
    const el = transcriptRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }, [])

  const handleScroll = useCallback(() => {
    const near = isNearBottom()
    userScrolledUp.current = !near
    setShowScrollBtn(!near)
  }, [isNearBottom])

  const scrollToBottom = useCallback(() => {
    const el = transcriptRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
      userScrolledUp.current = false
      setShowScrollBtn(false)
    }
  }, [])

  useEffect(() => {
    const el = transcriptRef.current
    if (!el) return
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  useEffect(() => {
    if (transcriptRef.current && !userScrolledUp.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
    }
  }, [task?.transcript, task?.state?.status, task?.state?.active_run?.actor])

  const isRunning = task?.state?.status?.startsWith('RUNNING_') ?? false
  const isReady = isTaskReadyToStart(task?.state)
  const hasTranscript = (task?.transcript?.length ?? 0) > 0
  const taskText = (task?.task_text || '').trim()
  const showTaskBrief = !!task && !!taskText

  return (
    <div className="flex-1 flex flex-col bg-bg-elevated min-w-0">
      <div ref={transcriptRef} className="flex-1 overflow-y-auto px-6 py-4">
        {!task ? (
          <div className="flex items-center justify-center h-full min-h-[60vh]">
            <div className="text-center text-fg-muted">
              <div className="text-lg font-medium mb-2">{t('chat.empty.title')}</div>
              <div className="text-sm">{t('chat.empty.desc')}</div>
            </div>
          </div>
        ) : (
          <>
            {showTaskBrief && (
              <div className="flex mb-3 justify-start">
                <div className="message task-brief-card w-full">
                  <div className="message-head">
                    <span className="role">{t('chat.taskBrief')}</span>
                  </div>
                  <div
                    className="message-body"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(taskText) }}
                  />
                </div>
              </div>
            )}
            {!hasTranscript && !isRunning && (
              <div className="flex items-center justify-center h-full min-h-[45vh]">
                <div className="text-center text-fg-muted">
                  <div className="text-lg font-medium mb-2">{t('chat.created.title')}</div>
                  <div className="text-sm">{t('chat.created.desc')}</div>
                </div>
              </div>
            )}
            {task.transcript.map((entry, index) => (
              <MessageBubble key={index} entry={entry} />
            ))}
            {isRunning && task.state.active_run?.actor && (
              <RunningStatusMessage
                actor={task.state.active_run.actor}
                startedAt={task.state.active_run.started_at}
                round={task.state.round}
              />
            )}
          </>
        )}
      </div>

      {showScrollBtn && (
        <div className="flex justify-center -mt-2 mb-1 relative z-10">
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label={t('chat.scrollToBottom')}
            title={t('chat.scrollToBottom')}
            className="w-8 h-8 rounded-full bg-bg-elevated border border-border-primary shadow-md flex items-center justify-center text-fg-muted hover:text-fg-primary hover:border-accent transition-colors cursor-pointer"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      )}

      <Composer
        onSend={onSendMessage}
        onStart={onStartTask}
        onInterrupt={onInterrupt}
        isRunning={isRunning}
        isReady={isReady}
        settings={task?.settings ?? null}
        taskState={task?.state ?? null}
        autoStartSeconds={autoStartSeconds}
        draft={draft}
        onDraftChange={onDraftChange}
      />
    </div>
  )
}
