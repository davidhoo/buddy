import { Circle, Loader2, X } from 'lucide-react'
import type { TaskStatus } from '../../shared/types'

export function statusClass(status: TaskStatus): string {
  if (status === 'READY') return 'ready'
  if (status === 'QUEUED') return 'queued'
  if (status.startsWith('RUNNING_')) return 'running'
  if (status === 'PINGING') return 'running'
  if (status === 'FAILED') return 'danger'
  if (status === 'PAUSED') return 'paused'
  if (status === 'DONE') return 'done'
  return 'neutral'
}

/**
 * 任务状态指示器:进行中=强调色转圈,完成=绿色圆圈,出错=红色叉;
 * 图标始终使用主题全色(与原小圆点颜色一致),不做透明度弱化;
 * 其余状态沿用原有小圆点,dimmed 用于已读任务的空心圆点显示。
 */
export function TaskStatusIcon({ status, dimmed = false }: { status: TaskStatus; dimmed?: boolean }) {
  const cls = statusClass(status)
  if (cls === 'running') {
    return (
      <Loader2
        size={11}
        strokeWidth={2.5}
        className="flex-shrink-0 animate-spin"
        style={{ color: 'var(--status-running)' }}
      />
    )
  }
  if (cls === 'done') {
    return (
      <Circle
        size={12}
        strokeWidth={2.5}
        className="flex-shrink-0"
        style={{ color: 'var(--success-fg)' }}
      />
    )
  }
  if (cls === 'danger') {
    return (
      <X
        size={12}
        strokeWidth={2.5}
        className="flex-shrink-0"
        style={{ color: 'var(--danger)' }}
      />
    )
  }
  // 小圆点外套一个 12×12 居中盒,与转圈/圆圈/叉(11-12px)保持相同的占位宽度,
  // 使不同状态的图标在列表中左缘对齐
  return (
    <span className="flex-shrink-0 inline-flex items-center justify-center" style={{ width: 12, height: 12 }}>
      <span
        className={`status-dot status-dot-${cls} ${dimmed ? 'status-dot-read' : 'status-dot-unread'}`}
      />
    </span>
  )
}
