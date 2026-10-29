import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const entries = [
      ['claude','Claude Code','2.1.159','2.1.312'],
      ['claude_desktop','Claude Desktop','',''],
      ['codex','Codex','0.163.0','0.165.0'],
      ['agy','Antigravity CLI','1.4.9',''],
      ['opencode','OpenCode','1.19.4',''],
      ['cursor','Cursor CLI','2026.09.15-d2fe57e',''],
      ['zed','Zed','',''], ['vscode','VS Code','',''],
      ['dsh','DeepSeek Harness','0.2.1-rc.3',''],
      ['kimi','Kimi Code','2.4.0',''],
      ['workbuddy','WorkBuddy','',''],
      ['codebuddy','CodeBuddy','2.155.0','2.178.0'],
      ['wecode_claude','WeCode Claude','2.1.159','']
    ]
    let agents = entries.map(([id,name,version,latest]) => ({
      id, installationId:id+'-test', name, path:version?'/usr/local/bin/'+id:'', realPath:version?'/usr/local/bin/'+id:'',
      installations: id === 'claude' ? [{id:'claude-one',path:'/usr/local/bin/claude',realPath:'/one/claude',version:'2.1.159'},{id:'claude-two',path:'/opt/homebrew/bin/claude',realPath:'/two/claude',version:'2.1.308'}] : undefined,
      version:version||undefined, latest:latest||undefined, appVersion:id==='codex'?'26.1023.51421':id==='dsh'?'0.2.1-rc.3':undefined,
      source:'npm',manager:version?'/usr/local/bin/npm':undefined, runnable:!!version,enabled:!!version,modelFlag:version?'--model':undefined,selectedProtocol:(id==='wecode_claude'?'acp':'cli') as 'cli'|'acp',
      cli:version?{command:'/usr/local/bin/'+id,args:[] as string[],env:{},timeout_seconds:7200,model:id==='codex'?'gpt-6-astra':id==='opencode'?'wecode/weibo-glm-5.1':id==='dsh'?'deepseek-v4.1-flash':undefined}:undefined,
      acp:version?{command:'/usr/local/bin/'+id,args:['acp'],env:{},timeout_seconds:7200}:undefined,acpStatus:version?'verified':'missing'
    }))
    Object.defineProperty(window, 'buddy', {
      value: {
        listLocalAgents: async () => agents,
        checkAgentUpdates: async () => agents,
        getAgentUpdateJobs: async () => [],
        configureAgent: async (id:string, config:{enabled?:boolean;protocol?:'cli'|'acp';cli?:typeof agents[number]['cli'];acp?:typeof agents[number]['acp']}) => {
          agents=agents.map(a=>a.id===id?{...a,...(config.enabled!==undefined?{enabled:config.enabled}:{}),selectedProtocol:config.protocol||a.selectedProtocol,cli:config.cli||a.cli,acp:config.acp||a.acp,path:config.cli?.command||a.path,version:a.installations?.find(i=>i.path===config.cli?.command)?.version||a.version}:a)
        },
        updateLocalAgents: async (ids:string[]) => {agents=agents.map(a=>ids.includes(a.id)&&a.latest?{...a,version:a.latest,latest:undefined}:a);return []},
        listCliModels: async (id:string) => ({models:id==='cursor' ? [{id:'auto',name:'Auto'},{id:'composer-2.5',name:'Composer 2.5'}] : id==='agy' ? [
          {id:'gemini-3.8-flash-high',name:'Gemini 3.8 Flash (High)'},
          {id:'gemini-3.8-flash-medium',name:'Gemini 3.8 Flash (Medium)'},
          {id:'gemini-3.8-flash-low',name:'Gemini 3.8 Flash (Low)'},
          {id:'claude-sonnet-4-6',name:'Claude Sonnet 4.6 (Thinking)'},
          {id:'claude-opus-4-6-thinking',name:'Claude Opus 4.6 (Thinking)'},
          {id:'gpt-oss-120b-medium',name:'GPT-OSS 120B (Medium)'}
        ] : id==='kimi' ? [{id:'kimi-k2-6',name:'Kimi K2.6'},{id:'kimi-k2-5',name:'Kimi K2.5'}] : [{id:'gpt-6-astra',name:'gpt-6-astra'},{id:'test-model',name:'Test model'}]}),
        listAcpModels: async () => ({models:[{id:'acp-model',name:'ACP model'}]}),
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
        onMenuAction: () => () => undefined,
        onUpdaterEvent: () => () => undefined,
        updateMenuLanguage: async () => undefined,
        isFullScreen: async () => false
      }
    })
  })
})

test('app boots with native buddy backend', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByText('Buddy').first()).toBeVisible()
  await expect(page.getByRole('button', { name: '新建任务', exact: true }).first()).toBeVisible()
  await expect(page.locator('text=Buddy 服务未运行')).not.toBeVisible()
})

test('advanced settings are inline and validate, format and save JSON independently', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.setViewportSize({ width: 1280, height: 980 })
  await page.goto('/')
  await expect(page).toHaveTitle(/Buddy/)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Agent' })).toBeVisible()
  await expect(page.getByText('添加自定义本机 Agent', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '管理', exact: true })).toHaveCount(0)
  const row = page.locator('[data-agent-id="claude"]')
  const advanced = row.getByRole('button', { name: 'Claude Code 高级', exact: true })
  await expect(advanced).toHaveAttribute('aria-expanded', 'false')
  await advanced.click()
  const panel = row.getByRole('region', { name: 'Claude Code 高级' })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('checkbox')).toHaveCount(0)
  await expect(panel.getByRole('spinbutton')).toHaveCount(0)
  await expect(panel.getByLabel('默认模型 ID', { exact: true })).toHaveCount(0)
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  const args = panel.getByLabel('参数（JSON 数组）', { exact: true })
  const env = panel.getByLabel('环境变量（JSON 对象）', { exact: true })
  const save = panel.getByRole('button', { name: '保存', exact: true })
  await args.fill('[1]')
  await env.fill('{"PROFILE": false}')
  await expect(save).toBeDisabled()
  await args.fill('["--profile","team"]')
  await expect(save).toBeDisabled()
  await env.fill('{"PROFILE":')
  await expect(panel.getByText('JSON 语法有误')).toBeVisible()
  await expect(panel.getByRole('button', { name: '环境变量（JSON 对象） · 格式化 JSON', exact: true })).toBeDisabled()
  await env.fill('{"PROFILE":"team","NOTE":"<test>"}')
  await panel.getByRole('button', { name: '参数（JSON 数组） · 格式化 JSON', exact: true }).click()
  await panel.getByRole('button', { name: '环境变量（JSON 对象） · 格式化 JSON', exact: true }).click()
  await expect(args).toHaveValue('[\n  "--profile",\n  "team"\n]')
  await expect(env).toHaveValue('{\n  "PROFILE": "team",\n  "NOTE": "<test>"\n}')
  await expect(panel.locator('.json-token-key').first()).toBeVisible()
  await expect(save).toBeEnabled()
  await panel.getByLabel('安装位置', { exact: true }).selectOption('/opt/homebrew/bin/claude')
  await expect(panel.getByLabel('启动命令', { exact: true })).toHaveValue('/opt/homebrew/bin/claude')
  await save.click()
  await expect(save).toBeEnabled()
  const persisted = await page.evaluate(async () => (await window.buddy.listLocalAgents()).find(a => a.id === 'claude'))
  expect(persisted?.cli).toMatchObject({ command: '/opt/homebrew/bin/claude', args: ['--profile', 'team'], env: { PROFILE: 'team', NOTE: '<test>' }, timeout_seconds: 7200 })
  await expect(advanced).toHaveAttribute('aria-expanded', 'true')
  await page.screenshot({ path: '/tmp/buddy-agents-advanced-desktop.png' })
  await page.setViewportSize({ width: 640, height: 980 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(panel.getByLabel('启动命令', { exact: true })).toBeVisible()
  await page.screenshot({ path: '/tmp/buddy-agents-advanced-narrow.png' })
  await row.locator('.agent-protocol-control select').selectOption('acp')
  await expect(args).toHaveValue('[\n  "acp"\n]')
  await panel.getByLabel('安装位置', { exact: true }).selectOption('/usr/local/bin/claude')
  await expect(panel.getByLabel('启动命令', { exact: true })).toHaveValue('/usr/local/bin/claude')
  await save.click()
  await expect(save).toBeEnabled()
  await advanced.click()
  await expect(panel).toHaveCount(0)
  expect(errors).toEqual([])
})

test('compact agents list uses Magpie icons and saves inline controls', async ({page}) => {
  await page.setViewportSize({width:1100,height:876})
  const errors:string[]=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button',{name:'设置',exact:true}).click()
  await page.getByRole('button',{name:'Agent',exact:true}).click()
  const row=page.locator('[data-agent-id="codex"]')
  await expect(page.getByRole('listitem')).toHaveCount(9)
  await expect(row.locator('img')).toHaveAttribute('data-agent-icon','codex')
  expect(await row.locator('img').evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0)).toBe(true)
  await row.getByRole('button',{name:'Codex 默认模型 ID',exact:true}).click()
  await page.getByRole('option',{name:'Test model',exact:true}).click()
  await expect(row.getByRole('button',{name:'Codex 默认模型 ID',exact:true})).toContainText('test-model')
  const toggle=row.getByRole('switch')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked','false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked','true')
  await row.getByRole('combobox').selectOption('acp')
  await expect(row.getByRole('combobox')).toHaveValue('acp')
  await row.getByRole('combobox').selectOption('cli')
  for(const id of ['claude_desktop','vscode','zed','workbuddy'])await expect(page.locator(`[data-agent-id="${id}"]`)).toHaveCount(0)
  await page.screenshot({path:'/tmp/buddy-agents-magpie-light.png'})
  await row.getByRole('button',{name:/Codex 更新到/}).click()
  await expect(row).toContainText('0.165.0')
  await page.getByRole('button',{name:'全部更新',exact:true}).click()
  await expect(page.getByRole('button',{name:'全部更新',exact:true})).toBeDisabled()
  await page.emulateMedia({colorScheme:'dark'})
  await page.waitForTimeout(350)
  await page.screenshot({path:'/tmp/buddy-agents-magpie-dark.png'})
  await page.setViewportSize({width:640,height:850})
  await expect(row.getByRole('button',{name:'Codex 默认模型 ID',exact:true})).toBeVisible()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  await page.screenshot({path:'/tmp/buddy-agents-magpie-narrow.png'})
  expect(errors).toEqual([])
})


test('protocol save only disables the edited row and never refreshes discovery', async ({page}) => {
  await page.goto('/')
  await page.getByRole('button',{name:'设置',exact:true}).click()
  const menu = page.getByRole('button',{name:'Agent',exact:true})
  await expect(menu.locator('svg')).toHaveClass(/lucide-terminal/)
  await menu.click()
  const row = page.locator('[data-agent-id="wecode_claude"]')
  await expect(row.getByRole('combobox')).toHaveValue('acp')
  await page.evaluate(() => {
    const state = window as typeof window & { __finishAgentSave?: () => void; __discoveryCalls?: number }
    const originalSave = window.buddy.configureAgent
    const originalList = window.buddy.listLocalAgents
    state.__discoveryCalls = 0
    window.buddy.listLocalAgents = async (...args) => { state.__discoveryCalls!++; return originalList(...args) }
    window.buddy.configureAgent = async (...args) => {
      await new Promise<void>(resolve => { state.__finishAgentSave = resolve })
      return originalSave(...args)
    }
  })
  await row.getByRole('combobox').selectOption('cli')
  await expect(row.getByRole('combobox')).toHaveValue('cli')
  await expect(row.getByRole('combobox')).toBeDisabled()
  await expect(page.locator('[data-agent-id="codex"]').getByRole('combobox')).toBeEnabled()
  await expect(page.locator('[data-agent-id="claude"]').getByRole('switch')).toBeEnabled()
  await page.evaluate(() => (window as typeof window & {__finishAgentSave?:()=>void}).__finishAgentSave?.())
  await expect(row.getByRole('combobox')).toBeEnabled()
  expect(await page.evaluate(() => (window as typeof window & {__discoveryCalls?:number}).__discoveryCalls)).toBe(0)
})


test('failed protocol save rolls back only the edited row', async ({page}) => {
  await page.goto('/')
  await page.getByRole('button',{name:'设置',exact:true}).click()
  await page.getByRole('button',{name:'Agent',exact:true}).click()
  const row = page.locator('[data-agent-id="wecode_claude"]')
  await expect(row.getByRole('combobox')).toHaveValue('acp')
  await page.evaluate(() => { window.buddy.configureAgent = async () => { throw new Error('test write failure') } })
  await row.getByRole('combobox').selectOption('cli')
  await expect(page.getByRole('alert')).toContainText('test write failure')
  await expect(row.getByRole('combobox')).toHaveValue('acp')
  await expect(row.getByRole('combobox')).toBeEnabled()
  await expect(page.locator('[data-agent-id="codex"]').getByRole('combobox')).toBeEnabled()
})


test('Antigravity shows the native model names and saves the corresponding model ID', async ({page}) => {
  await page.goto('/')
  await page.getByRole('button',{name:'设置',exact:true}).click()
  await page.getByRole('button',{name:'Agent',exact:true}).click()
  const row=page.locator('[data-agent-id="agy"]')
  await row.getByRole('button',{name:'Antigravity CLI 默认模型 ID',exact:true}).click()
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(7)
  await page.getByRole('option',{name:'Gemini 3.8 Flash (High)',exact:true}).click()
  await expect(row.getByRole('button',{name:'Antigravity CLI 默认模型 ID',exact:true})).toContainText('gemini-3.8-flash-high')
  await expect(row.getByRole('combobox')).toBeEnabled()
})

test('Kimi selects native CLI aliases and switches to verified ACP without losing the CLI default', async ({page}) => {
  const errors:string[]=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button',{name:'设置',exact:true}).click()
  await page.getByRole('button',{name:'Agent',exact:true}).click()
  const row=page.locator('[data-agent-id="kimi"]')
  await row.getByRole('button',{name:'Kimi Code 默认模型 ID',exact:true}).click()
  await page.getByRole('option',{name:'Kimi K2.6',exact:true}).click()
  await expect(row.getByRole('button',{name:'Kimi Code 默认模型 ID',exact:true})).toContainText('kimi-k2-6')
  await expect(row.getByRole('combobox')).toBeEnabled()
  await row.getByRole('combobox').selectOption('acp')
  await expect(row.getByRole('combobox')).toHaveValue('acp')
  await expect(row).toContainText('CLI / ACP')
  await row.getByRole('button',{name:'Kimi Code 默认模型 ID',exact:true}).click()
  await page.getByRole('option',{name:'ACP model',exact:true}).click()
  await expect(row.getByRole('button',{name:'Kimi Code 默认模型 ID',exact:true})).toContainText('acp-model')
  await expect(row.getByRole('combobox')).toBeEnabled()
  await row.getByRole('combobox').selectOption('cli')
  await expect(row.getByRole('button',{name:'Kimi Code 默认模型 ID',exact:true})).toContainText('kimi-k2-6')
  await expect(row.getByRole('combobox')).toBeEnabled()
  expect(errors).toEqual([])
})


test('Cursor exposes native CLI models and verified ACP in the same row', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const row = page.locator('[data-agent-id="cursor"]')
  await expect(row).toContainText('CLI / ACP')
  await row.getByRole('button', { name: 'Cursor CLI 默认模型 ID', exact: true }).click()
  await page.getByRole('option', { name: 'Composer 2.5', exact: true }).click()
  await expect(row.getByRole('button', { name: 'Cursor CLI 默认模型 ID', exact: true })).toContainText('composer-2.5')
})

test('native update capability has an action without claiming a known newer version', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const originalList = window.buddy.listLocalAgents
    window.buddy.listLocalAgents = async () => (await originalList()).map(a => a.id === 'wecode_claude' ? {
      ...a, nativeUpdate: { command: '/fixture/wecode', args: ['upgrade'], versionArgs: ['version'], version: '4.0.39', target: 'wecode' as const }
    } : a)
    window.buddy.checkAgentUpdates = window.buddy.listLocalAgents
  })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const row = page.locator('[data-agent-id="wecode_claude"]')
  await expect(row.getByRole('button', { name: 'WeCode Claude 更新 WeCode', exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: 'WeCode Claude 高级', exact: true })).toBeVisible()
  await expect(page.getByRole('status').first()).toContainText('3 个 Agent 有新版本')
})
