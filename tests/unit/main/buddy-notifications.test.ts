import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TaskNotifier } from '../../../src/main/buddy/notifications'
import type { BuddyStore } from '../../../src/main/buddy/store'
import type { GlobalSettings, TaskSettings, TaskStats } from '../../../src/shared/types'

// Mock electron Notification - factory must not reference external variables
vi.mock('electron', () => {
  const show = vi.fn()
  const ctor = vi.fn(() => ({ show }))
  ctor.isSupported = vi.fn(() => true)
  return { Notification: ctor }
})

function createMockStore(overrides: {
  settings?: Partial<GlobalSettings>
  stats?: TaskStats | null
  taskSettings?: Partial<TaskSettings>
} = {}): BuddyStore {
  const settings: GlobalSettings = {
    system_notifications_enabled: true,
    ...overrides.settings
  }
  return {
    readGlobalSettings: vi.fn().mockResolvedValue(settings),
    getTaskStats: vi.fn().mockResolvedValue(overrides.stats ?? null),
    getTaskDetail: vi.fn().mockResolvedValue({ settings: overrides.taskSettings ?? {} }),
  } as unknown as BuddyStore
}

async function getNotificationMock() {
  const { Notification } = await import('electron')
  return Notification as unknown as ReturnType<typeof vi.fn> & { isSupported: ReturnType<typeof vi.fn> }
}

describe('TaskNotifier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('notifyTaskDone', () => {
    it('sends a completion notification with stats', async () => {
      const stats: TaskStats = {
        actors: [],
        totalInputTokens: 128430,
        totalOutputTokens: 16208,
        totalCacheReadTokens: 52110,
        totalDurationMs: 1122000,
        totalCostUsd: 0.42,
        totalRounds: 6
      }
      const store = createMockStore({ stats })
      const { createTaskNotifier } = await import('../../../src/main/buddy/notifications')
      const notifier = createTaskNotifier(store)

      await notifier.notifyTaskDone('test-task', 'ws1', 'dual_break_confirmed', {
        first: 'claude',
        second: 'codex'
      })

      const Notification = await getNotificationMock()
      expect(Notification).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Buddy - 任务已完成',
          body: expect.stringContaining('合计：6 轮')
        })
      )
      expect(Notification).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('18m42s')
        })
      )
    })

    it('sends a completion notification without stats', async () => {
      const store = createMockStore()
      const { createTaskNotifier } = await import('../../../src/main/buddy/notifications')
      const notifier = createTaskNotifier(store)

      await notifier.notifyTaskDone('test-task', 'ws1', 'dual_break_confirmed', {
        first: 'claude',
        second: 'codex'
      })

      const Notification = await getNotificationMock()
      expect(Notification).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Buddy - 任务已完成',
          body: expect.stringContaining('双方均已确认任务结束')
        })
      )
    })

    it('sends a completion notification for break_confirmed_on_failure', async () => {
      const store = createMockStore()
      const { createTaskNotifier } = await import('../../../src/main/buddy/notifications')
      const notifier = createTaskNotifier(store)

      await notifier.notifyTaskDone('test-task', 'ws1', 'break_confirmed_on_failure', {
        first: 'claude',
        second: 'codex'
      })

      const Notification = await getNotificationMock()
      expect(Notification).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Buddy - 任务已完成',
          body: expect.stringContaining('执行失败后自动确认结束')
        })
      )
    })
  })

  describe('notifyTaskFailed', () => {
    it('sends a failure notification with actor and error', async () => {
      const store = createMockStore()
      const { createTaskNotifier } = await import('../../../src/main/buddy/notifications')
      const notifier = createTaskNotifier(store)

      await notifier.notifyTaskFailed('test-task', 'ws1', 'codex', 'Command failed with exit code 1: pnpm test')

      const Notification = await getNotificationMock()
      expect(Notification).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Buddy - 任务失败',
          body: expect.stringContaining('Codex')
        })
      )
      expect(Notification).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Command failed with exit code 1: pnpm test')
        })
      )
    })

    it('truncates long error messages to ~120 chars', async () => {
      const store = createMockStore()
      const { createTaskNotifier } = await import('../../../src/main/buddy/notifications')
      const notifier = createTaskNotifier(store)
      const longError = 'A'.repeat(200)

      await notifier.notifyTaskFailed('test-task', 'ws1', 'claude', longError)

      const Notification = await getNotificationMock()
      expect(Notification).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('...')
        })
      )
    })

    it('uses the configured actor display name', async () => {
      const store = createMockStore({
        taskSettings: {
          launchers: {
            'cursor-agent': {
              command: 'agent',
              env: {},
              timeout_seconds: 600,
              backend: 'cursor',
              display_name: 'Cursor Reviewer'
            }
          }
        }
      })
      const { createTaskNotifier } = await import('../../../src/main/buddy/notifications')
      const notifier = createTaskNotifier(store)

      await notifier.notifyTaskFailed('test-task', 'ws1', 'cursor-agent', 'connection failed')

      const Notification = await getNotificationMock()
      expect(Notification).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Actor：Cursor Reviewer')
        })
      )
    })
  })

  describe('notifyTaskPaused', () => {
    it('sends a pause notification with failure counts', async () => {
      const store = createMockStore()
      const { createTaskNotifier } = await import('../../../src/main/buddy/notifications')
      const notifier = createTaskNotifier(store)

      await notifier.notifyTaskPaused('test-task', 'ws1', 'claude', 10, 10)

      const Notification = await getNotificationMock()
      expect(Notification).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Buddy - 任务已暂停',
          body: expect.stringContaining('Claude')
        })
      )
      expect(Notification).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('连续失败 10 次')
        })
      )
    })
  })

  describe('when notifications are disabled', () => {
    it('does not send any notification', async () => {
      const store = createMockStore({
        settings: { system_notifications_enabled: false }
      })
      const { createTaskNotifier } = await import('../../../src/main/buddy/notifications')
      const notifier = createTaskNotifier(store)

      await notifier.notifyTaskDone('test-task', 'ws1', 'dual_break_confirmed')
      await notifier.notifyTaskFailed('test-task', 'ws1', 'claude', 'error')
      await notifier.notifyTaskPaused('test-task', 'ws1', 'claude', 10, 10)

      const Notification = await getNotificationMock()
      expect(Notification).not.toHaveBeenCalled()
    })
  })
})
