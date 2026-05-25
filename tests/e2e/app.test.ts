import { test, expect } from '@playwright/test'

test('app should launch and show title bar', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('text=buddy')).toBeVisible()
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
