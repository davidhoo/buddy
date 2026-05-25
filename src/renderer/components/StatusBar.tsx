import { TaskState, TaskSettings } from '../../shared/types'

interface StatusBarProps {
  isOpen: boolean
  taskState: TaskState | null
  taskSettings: TaskSettings | null
  onSkipCountdown: () => void
  onPauseCountdown: () => void
  onInterrupt: () => void
}

export function StatusBar({
  isOpen,
  taskState,
  taskSettings,
  onSkipCountdown,
  onPauseCountdown,
  onInterrupt
}: StatusBarProps) {
  if (!isOpen) return null

  const isRunning = taskState?.status?.startsWith('RUNNING_')
  const isCountdown = taskState?.status === 'COUNTDOWN'
  const countdown = taskState?.countdown

  return (
    <div className="w-70 bg-white border-l border-gray-200 flex flex-col h-full">
      {/* Actor 状态 */}
      <div className="p-4 border-b border-gray-200">
        <div className="text-sm font-medium text-gray-500 mb-3">运行状态</div>
        
        {/* Claude 状态 */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm">Claude</span>
          <span className={`text-xs px-2 py-1 rounded ${
            taskState?.status === 'RUNNING_CLAUDE' 
              ? 'bg-green-100 text-green-800' 
              : 'bg-gray-100 text-gray-600'
          }`}>
            {taskState?.status === 'RUNNING_CLAUDE' ? '运行中' : '空闲'}
          </span>
        </div>
        
        {/* Codex 状态 */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm">Codex</span>
          <span className={`text-xs px-2 py-1 rounded ${
            taskState?.status === 'RUNNING_CODEX' 
              ? 'bg-green-100 text-green-800' 
              : 'bg-gray-100 text-gray-600'
          }`}>
            {taskState?.status === 'RUNNING_CODEX' ? '运行中' : '空闲'}
          </span>
        </div>
        
        {/* 轮次信息 */}
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
          <span className="text-sm text-gray-500">轮次</span>
          <span className="text-sm font-medium">{taskState?.round || 0}</span>
        </div>
      </div>
      
      {/* 倒计时 */}
      {isCountdown && countdown && (
        <div className="p-4 border-b border-gray-200">
          <div className="text-sm font-medium text-gray-500 mb-2">倒计时</div>
          <div className="text-2xl font-bold text-center mb-3">
            {Math.ceil(countdown.remaining)}秒
          </div>
          <div className="flex gap-2">
            <button
              onClick={onSkipCountdown}
              className="flex-1 px-3 py-2 bg-accent-green text-white text-sm rounded hover:bg-brand-green transition-colors"
            >
              跳过
            </button>
            <button
              onClick={onPauseCountdown}
              className="flex-1 px-3 py-2 bg-gray-200 text-gray-700 text-sm rounded hover:bg-gray-300 transition-colors"
            >
              暂停
            </button>
          </div>
        </div>
      )}
      
      {/* 运行中操作 */}
      {isRunning && (
        <div className="p-4 border-b border-gray-200">
          <button
            onClick={onInterrupt}
            className="w-full px-3 py-2 bg-danger text-white text-sm rounded hover:bg-red-700 transition-colors"
          >
            打断运行
          </button>
        </div>
      )}
      
      {/* 任务设置 */}
      {taskSettings && (
        <div className="p-4 border-b border-gray-200">
          <div className="text-sm font-medium text-gray-500 mb-2">任务设置</div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-xs text-gray-500">倒计时</span>
              <span className="text-xs">{taskSettings.countdown_seconds}秒</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-gray-500">执行方</span>
              <span className="text-xs">{taskSettings.role_mode === 'claude_implements' ? 'Claude' : 'Codex'}</span>
            </div>
          </div>
        </div>
      )}
      
      {/* 会话信息 */}
      <div className="p-4 flex-1">
        <div className="text-sm font-medium text-gray-500 mb-2">会话信息</div>
        {taskState?.claude_session_id && (
          <div className="mb-2">
            <span className="text-xs text-gray-500">Claude: </span>
            <span className="text-xs font-mono">{taskState.claude_session_id.slice(0, 8)}...</span>
          </div>
        )}
        {taskState?.codex_thread_id && (
          <div>
            <span className="text-xs text-gray-500">Codex: </span>
            <span className="text-xs font-mono">{taskState.codex_thread_id.slice(0, 8)}...</span>
          </div>
        )}
      </div>
    </div>
  )
}
