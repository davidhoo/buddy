import { useEffect, useRef } from 'react'
import { TaskDetail } from '../../shared/types'
import { MessageBubble } from './MessageBubble'
import { RunningStatusMessage } from './RunningStatusMessage'
import { Composer } from './Composer'
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
  const transcriptRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
    }
  }, [task?.transcript, task?.task_text, task?.state?.status, task?.state?.active_run?.actor])

  const isRunning = task?.state?.status?.startsWith('RUNNING_') ?? false
  const isReady = task?.state?.status === 'READY' && (task?.state?.round ?? 0) === 0
  const taskText = (task?.task_text || '').trim()
  const hasTranscript = (task?.transcript?.length ?? 0) > 0

  return (
    <div className="flex-1 flex flex-col bg-bg-elevated min-w-0">
      <div ref={transcriptRef} className="flex-1 overflow-y-auto px-6 py-4">
        {!task ? (
          <div className="flex items-center justify-center h-full min-h-[60vh]">
            <div className="text-center text-fg-muted">
              <div className="text-lg font-medium mb-2">选择或创建一个任务</div>
              <div className="text-sm">在左侧栏选择任务，或创建新任务开始</div>
            </div>
          </div>
        ) : !hasTranscript && !taskText ? (
          <div className="flex items-center justify-center h-full min-h-[60vh]">
            <div className="text-center text-fg-muted">
              <div className="text-lg font-medium mb-2">任务已创建</div>
              <div className="text-sm">点击下方"开始"让 AI 开始工作</div>
            </div>
          </div>
        ) : (
          <>
            {taskText && (
              <div className="flex mb-3 justify-start">
                <div className="message msg-system w-full">
                  <div className="message-head">
                    <span className="role">任务说明</span>
                  </div>
                  <div
                    className="message-body"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(taskText) }}
                  />
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
