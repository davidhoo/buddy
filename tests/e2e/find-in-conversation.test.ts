import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const taskId = 'needle sidebar task'
    const workspaceKey = 'findscope1234'
    const task = {
      task_id: taskId,
      workspace_key: workspaceKey,
      state: {
        status: 'DONE',
        round: 2,
        next_actor: 'claude',
        active_run: null,
        updated_at: new Date().toISOString(),
        repo_root: '/tmp/find-in-conversation',
        pending_break: null
      },
      settings: {
        protocol_version: '1',
        flow_policy: 'claude_then_codex',
        role_mode: 'claude_implements',
        implementer_actor: 'claude',
        reviewer_actor: 'codex',
        launchers: {
          claude: { command: 'claude', env: {}, timeout_seconds: 7200 },
          codex: { command: 'codex', env: {}, timeout_seconds: 7200 }
        }
      },
      task_text: 'Verify conversation-scoped search.',
      context_text: '',
      transcript: [
        {
          role: 'human',
          content: 'first needle in the conversation',
          ts: new Date().toISOString(),
          meta: {}
        },
        {
          role: 'claude',
          content: 'second nee**dle** across inline formatting',
          ts: new Date().toISOString(),
          meta: {}
        }
      ],
      events: [],
      latest_failure: null
    }

    Object.defineProperty(window, 'buddy', {
      value: {
        checkHealth: async () => true,
        bootstrap: async () => ({
          version: 'native',
          repo_root: '',
          data_root: '',
          tasks: []
        }),
        getTasks: async () => [{
          task_id: taskId,
          workspace_key: workspaceKey,
          status: 'DONE',
          updated_at: new Date().toISOString(),
          repo_root: '/tmp/find-in-conversation',
          round: 2,
          active_run: null
        }],
        getTaskDetail: async () => task,
        createTask: async () => ({ task: taskId, path: '/tmp/find-in-conversation', workspace_key: workspaceKey }),
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

test('finds only conversation text and preserves keyboard behavior', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('first needle in the conversation')).toBeVisible()

  await page.keyboard.press('Meta+f')
  const input = page.getByRole('textbox', { name: '在对话中查找' })
  await expect(input).toBeFocused()
  await input.fill('needle')

  const status = page.getByRole('status')
  await expect(status).toHaveText('1/2')
  await expect.poll(() => page.evaluate(() => {
    let count = 0
    CSS.highlights.get('buddy-find-match')?.forEach(() => { count += 1 })
    return count
  })).toBe(2)

  await input.press('Enter')
  await expect(status).toHaveText('2/2')
  await input.press('Shift+Enter')
  await expect(status).toHaveText('1/2')

  const previous = page.getByRole('button', { name: '上一个' })
  await previous.focus()
  await previous.press('Enter')
  await expect(status).toHaveText('2/2')

  const close = page.getByRole('button', { name: '关闭' })
  await close.focus()
  await close.press('Enter')
  await expect(input).not.toBeVisible()
  await expect.poll(() => page.evaluate(() => CSS.highlights.has('buddy-find-match'))).toBe(false)

  await page.keyboard.press('Meta+f')
  await input.fill('needle')
  await page.getByText('first needle in the conversation').click()
  await page.keyboard.press('Meta+f')
  await expect(input).toBeFocused()
  await expect.poll(() => input.evaluate((element) => {
    const field = element as HTMLInputElement
    return field.selectionStart === 0 && field.selectionEnd === field.value.length
  })).toBe(true)

  await page.getByText('first needle in the conversation').click()
  await page.keyboard.press('Escape')
  await expect(input).not.toBeVisible()

  await page.keyboard.press('Meta+f')
  await input.fill('needle')
  await page.keyboard.press('Meta+,')
  await expect(page.getByText('CLI 配置')).toBeVisible()
  await expect.poll(() => page.evaluate(() => CSS.highlights.has('buddy-find-match'))).toBe(false)
})
