import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const buddy = {
      checkHealth: async () => true,
      bootstrap: async () => ({
        version: 'native',
        repo_root: '',
        data_root: '',
        tasks: []
      }),
      getTasks: async () => [],
      getTaskDetail: async () => {
        throw new Error('not found')
      },
      createTask: async () => ({ task: 'demo', path: '/tmp/demo', workspace_key: 'abc123def456' }),
      deleteTask: async () => undefined,
      startTask: async () => undefined,
      sendMessage: async () => undefined,
      skipCountdown: async () => undefined,
      pauseCountdown: async () => undefined,
      interrupt: async () => undefined,
      getEvents: async () => ({ events: [] }),
      updateGlobalSettings: async (settings: unknown) => settings,
      onTaskEvent: () => () => undefined
    }
    const api = {
      selectDirectory: async () => null,
      openInFinder: async () => undefined,
      onFullScreenChange: () => () => undefined,
      isFullScreen: async () => false
    }
    Object.defineProperty(window, 'buddy', { value: buddy })
    Object.defineProperty(window, 'api', { value: api })
  })
})

test('app should launch and show title bar', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Buddy').first()).toBeVisible()
})

test('should show sidebar by default', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('text=新建任务')).toBeVisible()
})

test('should toggle sidebar', async ({ page }) => {
  await page.goto('/')

  // 点击切换按钮
  await page.locator('button[title="收起侧边栏"]').click()

  // 验证侧边栏隐藏
  await expect(page.locator('text=新建任务')).not.toBeVisible()

  // 再次点击展开
  await page.locator('button[title="展开侧边栏"]').click()

  // 验证侧边栏显示
  await expect(page.locator('text=新建任务')).toBeVisible()
})
