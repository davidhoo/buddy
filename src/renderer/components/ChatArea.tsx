import { useEffect, useRef } from 'react'
import { TaskDetail } from '../../shared/types'
import { MessageBubble } from './MessageBubble'
import { RunningStatusMessage } from './RunningStatusMessage'
import { Composer } from './Composer'
import { isTaskReadyToStart } from '../lib/taskState'
import { useT } from '../hooks/useI18n'

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

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
    }
  }, [task?.transcript, task?.state?.status, task?.state?.active_run?.actor])

  const isRunning = task?.state?.status?.startsWith('RUNNING_') ?? false
  const isReady = isTaskReadyToStart(task?.state)
  const hasTranscript = (task?.transcript?.length ?? 0) > 0

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
        ) : !hasTranscript && !isRunning ? (
          <div className="flex items-center justify-center h-full min-h-[60vh]">
            <div className="text-center text-fg-muted">
              <div className="text-lg font-medium mb-2">{t('chat.created.title')}</div>
              <div className="text-sm">{t('chat.created.desc')}</div>
            </div>
          </div>
        ) : (
          <>
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
