import { useCallback, useEffect, useRef, useState } from 'react'
import { ListOrdered, CornerDownRight, Trash2, Sparkles, Paperclip, Plus } from 'lucide-react'
import { TaskDetail, InstructionQueueItem, Attachment } from '../../shared/types'
import { MessageBubble } from './MessageBubble'
import { RunningStatusMessage, RunningDetailPanel } from './RunningStatusMessage'
import { Composer } from './Composer'
import { QueueMenu } from './InstructionQueue'
import { isTaskReadyToStart } from '../lib/taskState'
import { useActorStream } from '../hooks/useBuddy'

import { useT } from '../hooks/useI18n'
import { renderMarkdown } from '../lib/markdown'

interface ChatAreaProps {
  task: TaskDetail | null
  hasAnyTasks: boolean
  onSendMessage: (message: string, actor?: string, attachments?: Attachment[]) => void
  onStartTask: (actor?: string) => void
  onInterrupt: () => void
  onEnqueueInstruction: (content: string, attachments?: Attachment[]) => void
  onInterruptAndInsert: (itemId: string) => void
  onDequeueInstruction: (itemId: string) => void
  onEditInstruction: (item: InstructionQueueItem) => void
  onClearInstructionQueue: () => void
  onCreateTask: () => void
  draft: string
  onDraftChange: (value: string) => void
  attachments: Attachment[]
  onAttachmentsChange: (attachments: Attachment[]) => void
}

export function ChatArea({ task, hasAnyTasks, onSendMessage, onStartTask, onInterrupt, onEnqueueInstruction, onInterruptAndInsert, onDequeueInstruction, onEditInstruction, onClearInstructionQueue, onCreateTask, draft, onDraftChange, attachments, onAttachmentsChange }: ChatAreaProps) {
  const t = useT()
  const transcriptRef = useRef<HTMLDivElement>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [detailExpanded, setDetailExpanded] = useState(false)
  const userScrolledUp = useRef(false)

  const isRunning = task?.state?.status?.startsWith('RUNNING_') ?? false
  const activeRunId = isRunning ? task?.state?.active_run?.run_id : null
  const activeActor = isRunning ? task?.state?.active_run?.actor : null
  const streamLines = useActorStream(task?.task_id ?? null, activeRunId ?? null)

  // Collapse detail panel when actor stops running
  useEffect(() => {
    if (!isRunning) setDetailExpanded(false)
  }, [isRunning])

  const handleToggleExpand = useCallback(() => {
    setDetailExpanded(prev => {
      if (!prev) {
        setTimeout(() => {
          const el = transcriptRef.current
          if (el) el.scrollTop = el.scrollHeight
        }, 0)
      }
      return !prev
    })
  }, [])

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

  useEffect(() => {
    userScrolledUp.current = false
    setShowScrollBtn(false)
  }, [task?.task_id])

  const isReady = isTaskReadyToStart(task?.state)
  const hasTranscript = (task?.transcript?.length ?? 0) > 0
  const taskText = (task?.task_text || '').trim()
  const showTaskBrief = !!task && !!taskText

  return (
    <div className="flex-1 flex flex-col bg-bg-elevated min-w-0">
      <div ref={transcriptRef} className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
        {!task ? (
          !hasAnyTasks ? (
            <div className="flex items-center justify-center h-full min-h-[60vh]">
              <div className="text-center text-fg-muted max-w-xs">
                <Sparkles size={36} strokeWidth={1.25} className="mx-auto mb-4 text-fg-muted/60" />
                <div className="text-lg font-medium mb-2">{t('chat.onboarding.title')}</div>
                <div className="text-sm leading-relaxed mb-2">{t('chat.onboarding.desc')}</div>
                <div className="text-xs text-fg-muted/70 mb-5">{t('chat.onboarding.cliHint')}</div>
                <button
                  type="button"
                  onClick={onCreateTask}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-accent-primary text-fg-inverse hover:bg-accent-primary-hover transition-colors cursor-pointer"
                >
                  <Plus size={16} />
                  {t('chat.onboarding.createTask')}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full min-h-[60vh]">
              <div className="text-center text-fg-muted">
                <div className="text-lg font-medium mb-2">{t('chat.empty.title')}</div>
                <div className="text-sm">{t('chat.empty.desc')}</div>
              </div>
            </div>
          )
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
                expanded={detailExpanded}
                onToggleExpand={handleToggleExpand}
              />
            )}
            {detailExpanded && isRunning && activeActor && (
              <RunningDetailPanel
                actor={activeActor}
                streamLines={streamLines}
                onCollapse={handleToggleExpand}
              />
            )}
          </>
        )}
      </div>

      {showScrollBtn && !detailExpanded && (
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

      {!task && !hasAnyTasks ? null : (
      <div className="px-4 pb-4">
        {(task?.state?.instruction_queue?.length ?? 0) > 0 && (
          <div className="mx-8 -mb-px relative z-[2]">
            <div className="border-t border-l border-r border-b-0 border-border rounded-t-lg bg-bg-elevated px-3 py-2 space-y-0.5">
              {task!.state.instruction_queue!.map((item) => {
                const cleanedContent = item.content.replace(/\n*\[Attachments\]\n(?:- .*\n?)+/g, '').trim()
                const attCount = item.attachments?.length ?? 0
                return (
                  <div key={item.id} className="flex items-center gap-2 px-1 py-1 text-xs group">
                    <ListOrdered size={14} className="text-fg-muted shrink-0" />
                    <span className="flex-1 truncate text-fg-secondary">{cleanedContent}</span>
                    {attCount > 0 && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-bg-subtle text-fg-muted text-[10px] shrink-0">
                        <Paperclip size={10} />
                        {attCount}
                      </span>
                    )}
                  <div className="flex items-center gap-1.5 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => onInterruptAndInsert(item.id)}
                      title={t('queue.interruptAndInsert')}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:text-accent text-fg-muted transition-colors cursor-pointer"
                    >
                      <CornerDownRight size={13} />
                      <span className="text-[11px]">{t('queue.interruptAndInsert')}</span>
                    </button>
                    <button
                      onClick={() => onDequeueInstruction(item.id)}
                      title={t('common.delete')}
                      className="p-1 rounded hover:text-danger text-fg-muted transition-colors cursor-pointer"
                    >
                      <Trash2 size={12} />
                    </button>
                    <QueueMenu
                      item={item}
                      onEdit={onEditInstruction}
                      onClearQueue={onClearInstructionQueue}
                    />
                  </div>
                </div>
              )})}
            </div>
          </div>
        )}
        <Composer
          onSend={onSendMessage}
          onStart={onStartTask}
          onInterrupt={onInterrupt}
          onEnqueueInstruction={onEnqueueInstruction}
          isRunning={isRunning}
          isReady={isReady}
          settings={task?.settings ?? null}
          taskState={task?.state ?? null}
          draft={draft}
          onDraftChange={onDraftChange}
          attachments={attachments}
          onAttachmentsChange={onAttachmentsChange}
        />
      </div>
      )}
    </div>
  )
}
