import { Notification } from 'electron'
import type { TaskStats } from '../../shared/types'
import type { BuddyStore } from './store'
import { actorDisplayName } from './prompts'

/** Maximum length for error reason in notification body */
const MAX_ERROR_LENGTH = 120

export interface TaskNotifier {
  notifyTaskDone(taskId: string, workspaceKey: string, reason: 'dual_break_confirmed' | 'break_confirmed_on_failure', actors?: { first?: string; second?: string }): Promise<void>
  notifyTaskFailed(taskId: string, workspaceKey: string, actor: string, error: string): Promise<void>
  notifyTaskPaused(taskId: string, workspaceKey: string, actor: string, consecutiveFailures: number, maxFailures: number): Promise<void>
}

/**
 * Create a TaskNotifier that reads settings from the store and sends
 * macOS system notifications via Electron's Notification API.
 */
export function createTaskNotifier(store: BuddyStore): TaskNotifier {
  const isEnabled = async (): Promise<boolean> => {
    try {
      const settings = await store.readGlobalSettings()
      return settings.system_notifications_enabled ?? true
    } catch {
      return true
    }
  }

  const sendNotification = (title: string, body: string): void => {
    try {
      if (!Notification.isSupported()) return
      const notification = new Notification({ title, body })
      notification.show()
    } catch {
      // Swallow notification errors — they are never critical
    }
  }

  const getTaskStats = async (taskId: string, workspaceKey: string): Promise<TaskStats | null> => {
    try {
      return await store.getTaskStats(taskId, workspaceKey)
    } catch {
      return null
    }
  }

  return {
    async notifyTaskDone(taskId, workspaceKey, reason, actors) {
      if (!(await isEnabled())) return

      const title = 'Buddy - 任务已完成'
      let body: string

      if (reason === 'break_confirmed_on_failure' && actors?.first && actors?.second) {
        body = `任务：${taskId}\n状态：已完成\n${actorDisplayName(actors.first)} 请求结束，${actorDisplayName(actors.second)} 执行失败后自动确认结束。`
      } else {
        const stats = await getTaskStats(taskId, workspaceKey)
        if (stats) {
          body = `任务：${taskId}\n状态：已完成\n合计：${stats.totalRounds} 轮 · ${formatDuration(stats.totalDurationMs)} · 输入 ${formatNumber(stats.totalInputTokens)} · 输出 ${formatNumber(stats.totalOutputTokens)} · Cache ${formatNumber(stats.totalCacheReadTokens)}`
        } else {
          body = `任务：${taskId}\n状态：已完成\n双方均已确认任务结束。`
        }
      }

      sendNotification(title, body)
    },

    async notifyTaskFailed(taskId, _workspaceKey, actor, error) {
      if (!(await isEnabled())) return

      const truncatedError = error.length > MAX_ERROR_LENGTH
        ? error.slice(0, MAX_ERROR_LENGTH) + '...'
        : error

      const title = 'Buddy - 任务失败'
      const body = `任务：${taskId}\n状态：失败\nActor：${actorDisplayName(actor)}\n原因：${truncatedError}`

      sendNotification(title, body)
    },

    async notifyTaskPaused(taskId, _workspaceKey, actor, consecutiveFailures, maxFailures) {
      if (!(await isEnabled())) return

      const title = 'Buddy - 任务已暂停'
      const body = `任务：${taskId}\n状态：已暂停\n${actorDisplayName(actor)} 连续失败 ${consecutiveFailures} 次，已达到上限 (${maxFailures})，等待用户处理。`

      sendNotification(title, body)
    }
  }
}

/** Format milliseconds into a human-readable duration string (xdxhxmxs) */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.floor(ms))}ms`
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (days > 0 || hours > 0) parts.push(`${hours}h`)
  if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join('')
}

/** Format a number with locale-appropriate thousands separators */
function formatNumber(n: number): string {
  return n.toLocaleString()
}
