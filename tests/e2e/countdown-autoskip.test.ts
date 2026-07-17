import { expect, test } from '@playwright/test'

test('auto-skips a running countdown once when its deadline elapses', async ({ page }) => {
  const expectedTaskId = 'auto countdown'
  const expectedWorkspaceKey = 'abc123def456'

  await page.addInitScript(() => {
    const workspaceKey = 'abc123def456'
    const taskId = 'auto countdown'
    const deadline = new Date(Date.now() + 200).toISOString()
    const skipCountdownCalls: Array<{ taskId: string; input: unknown; at: number }> = []

    Object.defineProperty(window, '__skipCountdownCalls', {
      value: skipCountdownCalls
    })
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
          status: 'COUNTDOWN',
          updated_at: new Date().toISOString(),
          repo_root: '/tmp/buddy-autoskip',
          round: 1,
          active_run: null
        }],
        getTaskDetail: async () => ({
          task_id: taskId,
          workspace_key: workspaceKey,
          state: {
            status: 'COUNTDOWN',
            round: 1,
            next_actor: 'codex',
            active_run: null,
            updated_at: new Date().toISOString(),
            repo_root: '/tmp/buddy-autoskip',
            pending_break: null,
            countdown: {
              status: 'running',
              started_at: new Date().toISOString(),
              after_actor: 'claude',
              default_next_actor: 'codex',
              deadline
            }
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
          task_text: 'Continue automatically after countdown.',
          context_text: '',
          transcript: [],
          events: [],
          latest_failure: null
        }),
        createTask: async () => ({ task: taskId, path: '/tmp/buddy-autoskip', workspace_key: workspaceKey }),
        deleteTask: async () => undefined,
        startTask: async () => undefined,
        sendMessage: async () => undefined,
        skipCountdown: async (calledTaskId: string, input: unknown) => {
          skipCountdownCalls.push({ taskId: calledTaskId, input, at: Date.now() })
          return new Promise(() => {})
        },
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

  await page.goto('/')
  await page.getByText('auto countdown').click()

  await page.waitForFunction(() => (window as typeof window & {
    __skipCountdownCalls: unknown[]
  }).__skipCountdownCalls.length >= 1)
  await page.waitForTimeout(500)

  const calls = await page.evaluate(() => (window as typeof window & {
    __skipCountdownCalls: Array<{ taskId: string; input: unknown }>
  }).__skipCountdownCalls)

  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    taskId: expectedTaskId,
    input: { workspace_key: expectedWorkspaceKey }
  })
})
