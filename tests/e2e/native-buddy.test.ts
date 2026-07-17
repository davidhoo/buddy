import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'buddy', {
      value: {
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
    })
    Object.defineProperty(window, 'api', {
      value: {
        selectDirectory: async () => null,
        openInFinder: async () => undefined,
        onFullScreenChange: () => () => undefined,
        isFullScreen: async () => false,
        updateMenuLanguage: () => undefined,
        onMenuAction: () => () => undefined
      }
    })
  })
})

test('app boots with native buddy backend', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByText('Buddy').first()).toBeVisible()
  await expect(page.locator('text=新建任务')).toBeVisible()
  await expect(page.locator('text=Buddy 服务未运行')).not.toBeVisible()
})

test('settings keeps CLI launcher configuration visible', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('button', { name: '设置' }).click()

  await expect(page.getByText('CLI 配置')).toBeVisible()
  await expect(page.getByText('Claude 配置')).toBeVisible()
  await expect(page.getByText('Cursor Agent 配置')).toBeVisible()
  await expect(page.locator('input').nth(0)).toHaveValue('claude')
  await expect(page.locator('input').nth(1)).toHaveValue('codex')
})
