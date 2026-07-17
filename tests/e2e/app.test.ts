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
      isFullScreen: async () => false,
      updateMenuLanguage: () => undefined,
      onMenuAction: () => () => undefined
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

test('keyboard shortcuts page opens from shortcut and supports search', async ({ page }) => {
  await page.goto('/')

  // First open settings, then trigger showShortcuts
  await page.keyboard.press('Meta+,')
  await page.waitForTimeout(500)
  await page.keyboard.press('Meta+Shift+/')

  await expect(page.getByText('键盘快捷键').first()).toBeVisible({ timeout: 10000 })
  await expect(page.getByPlaceholder('搜索快捷键')).toBeVisible()
  await expect(page.getByText('切换侧边栏')).toBeVisible()

  await page.getByPlaceholder('搜索快捷键').fill('中断')
  await expect(page.getByText('中断任务')).toBeVisible()
  await expect(page.getByText('新建任务')).not.toBeVisible()
})

test('sidebar toggle shortcut works', async ({ page }) => {
  await page.goto('/')

  // Ensure no text input has focus by clicking on the main area first
  await page.click('body')
  await page.waitForTimeout(300)
  await page.keyboard.press('Meta+B')
  await expect(page.locator('text=新建任务')).not.toBeVisible({ timeout: 10000 })

  await page.keyboard.press('Meta+B')
  await expect(page.locator('text=新建任务')).toBeVisible()
})

test('custom shortcut binding is saved and used', async ({ page }) => {
  await page.goto('/')

  await page.keyboard.press('Meta+,')
  await page.keyboard.press('Meta+Shift+/')

  const row = page.getByText('打开设置').locator('xpath=ancestor::div[contains(@class, "grid")][1]')
  const bindingButton = row.getByRole('button').first()
  await bindingButton.click()
  await page.keyboard.press('Meta+Shift+S')
  await expect(bindingButton).toContainText('⇧⌘S')

  await page.keyboard.press('Escape')
  await expect(page.getByText('新建任务')).toBeVisible()

  await page.keyboard.press('Meta+,')
  await expect(page.getByText('CLI 配置')).not.toBeVisible()

  await page.keyboard.press('Meta+Shift+S')
  await expect(page.getByText('CLI 配置')).toBeVisible()
})
