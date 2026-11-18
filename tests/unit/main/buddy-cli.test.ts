import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runBuddyCli } from '../../../src/main/buddy/cli'
import { getCliInstallStatus, installBuddyCli, uninstallBuddyCli } from '../../../src/main/buddy/cli-installer'
import { BuddyCliServer } from '../../../src/main/buddy/cli-server'
import { BuddyEventBus } from '../../../src/main/buddy/events'
import { BuddyCoreService } from '../../../src/main/buddy/service'
import { BuddyStore } from '../../../src/main/buddy/store'
import type { TaskEventEnvelope } from '../../../src/shared/types'

async function invokeCli(
  argv: string[],
  options: { cwd?: string; stdin?: () => Promise<string> } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await runBuddyCli(argv, {
    stdout: (text) => { stdout += text },
    stderr: (text) => { stderr += text },
    cwd: options.cwd,
    stdin: options.stdin
  })
  return { code, stdout, stderr }
}

async function createMockActorScript(
  root: string,
  behavior: 'two_round_break' | 'four_round_rotation' | 'slow_running'
): Promise<string> {
  const scriptPath = join(root, `mock-actor-${behavior}.js`)
  const code = `
const fs = require('node:fs');
const path = require('node:path');

const actor = process.env.BUDDY_ACTOR || 'unknown';
const runId = process.env.BUDDY_RUN_ID || '';
const outputFile = process.env.BUDDY_OUTPUT_FILE || '';
const taskDir = process.env.BUDDY_TASK_DIR || '';
const behavior = ${JSON.stringify(behavior)};

function writeReply(obj) {
  const json = JSON.stringify(obj);
  if (outputFile) {
    fs.writeFileSync(outputFile, json, 'utf8');
  }
  process.stdout.write(json + '\\n');
}

async function main() {
  if (runId.startsWith('ping_')) {
    writeReply({ type: 'chat', content: 'pong from ' + actor });
    return;
  }

  const countFile = path.join(taskDir || ${JSON.stringify(root)}, '.turn-' + actor);
  let turn = 0;
  try {
    turn = Number(fs.readFileSync(countFile, 'utf8')) || 0;
  } catch {}
  turn += 1;
  fs.writeFileSync(countFile, String(turn), 'utf8');

  if (behavior === 'slow_running') {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    writeReply({ type: 'break', content: actor + ' slow finished' });
    return;
  }

  if (behavior === 'two_round_break') {
    if (actor === 'claude') {
      writeReply({ type: 'break', content: 'Implemented feature X cleanly.' });
    } else {
      writeReply({ type: 'break', content: 'Reviewed feature X: all tests pass.' });
    }
    return;
  }

  // four_round_rotation: claude chat -> codex chat -> claude break -> codex break
  if (turn === 1) {
    writeReply({
      type: 'chat',
      content: actor === 'claude' ? 'Round 1 implementation draft' : 'Round 2 review: please add edge check'
    });
  } else {
    writeReply({
      type: 'break',
      content: actor === 'claude' ? 'Round 3 edge check added and verified' : 'Round 4 review approved (LGTM)'
    });
  }
}

main().catch((err) => {
  process.stderr.write(String(err));
  process.exit(1);
});
`
  await writeFile(scriptPath, code, 'utf8')
  return `${process.execPath} ${scriptPath}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('Buddy CLI', () => {
  const tempRoots: string[] = []
  const servers: BuddyCliServer[] = []

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop()!
      await server.close().catch(() => {})
    }
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop()!
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('creates tasks with explicit options, models, queued mode, and auto-derived IDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-cli-create-'))
    tempRoots.push(root)
    const repoDir = join(root, 'repo-a')

    const res1 = await invokeCli([
      'create',
      '--data-root', root,
      '--local',
      '--task-id', 'feat-cli',
      '--prompt', 'Add CLI support',
      '--context', 'Use TypeScript',
      '--repo', repoDir,
      '--implementer', 'codex',
      '--reviewer', 'claude',
      '--implementer-model', 'gpt-5-codex',
      '--reviewer-model', 'claude-sonnet',
      '--mode', 'queued',
      '--no-start',
      '--json'
    ])

    expect(res1.code).toBe(0)
    const created1 = JSON.parse(res1.stdout)
    expect(created1).toMatchObject({
      task: 'feat-cli',
      mode: 'local',
      execution_mode: 'queued',
      started: false
    })

    const store = new BuddyStore(root)
    const detail = await store.getTaskDetail('feat-cli', created1.workspace_key)
    expect(detail.task_text.trim()).toBe('Add CLI support')
    expect(detail.context_text.trim()).toBe('Use TypeScript')
    expect(detail.state.status).toBe('QUEUED')
    expect(detail.state.execution_mode).toBe('queued')
    expect(detail.settings.implementer_actor).toBe('codex')
    expect(detail.settings.reviewer_actor).toBe('claude')
    expect(detail.settings.launchers.codex.model).toBe('gpt-5-codex')
    expect(detail.settings.launchers.claude.model).toBe('claude-sonnet')

    // Auto-derived task_id from prompt text
    const res2 = await invokeCli([
      'create',
      '--data-root', root,
      '--local',
      '--no-start',
      '--repo', repoDir,
      '--json',
      'Fix login validation bug'
    ])
    expect(res2.code).toBe(0)
    const created2 = JSON.parse(res2.stdout)
    expect(created2.task).toMatch(/^Fix-login-validation-bug-/)

    // Reject identical implementer and reviewer
    const resErr = await invokeCli([
      'create',
      '--data-root', root,
      '--local',
      '--no-start',
      '--implementer', 'claude',
      '--reviewer', 'claude',
      '--prompt', 'Invalid actors',
      '--json'
    ])
    expect(resErr.code).toBe(1)
    expect(JSON.parse(resErr.stdout).error).toContain('different actors')
  })

  it('queries task status and lists tasks with repo and status filters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-cli-status-'))
    tempRoots.push(root)
    const repoA = join(root, 'repo-a')
    const repoB = join(root, 'repo-b')

    const store = new BuddyStore(root)
    const t1 = await store.createTask({ task_id: 'alpha', repo_root: repoA, task_text: 'Alpha task' })
    await store.createTask({ task_id: 'beta', repo_root: repoB, task_text: 'Beta task', execution_mode: 'queued' })
    await store.appendTranscript('alpha', t1.workspace_key, 'claude', 'Drafted alpha solution', {
      round: 1,
      buddy_type: 'chat'
    })
    await store.updateTaskState('alpha', t1.workspace_key, (s) => ({
      ...s,
      round: 1,
      next_actor: 'codex',
      pending_break: { actor: 'claude', round: 1 }
    }))

    // Status without --workspace
    const statusJson = await invokeCli(['status', 'alpha', '--data-root', root, '--local', '--json'])
    expect(statusJson.code).toBe(0)
    expect(JSON.parse(statusJson.stdout)).toMatchObject({
      task_id: 'alpha',
      workspace_key: t1.workspace_key,
      status: 'READY',
      round: 1,
      next_actor: 'codex',
      pending_break: { actor: 'claude', round: 1 },
      latest_reply: {
        role: 'claude',
        round: 1,
        buddy_type: 'chat',
        content: 'Drafted alpha solution'
      }
    })

    const statusText = await invokeCli(['status', 'alpha', '--data-root', root, '--local'])
    expect(statusText.code).toBe(0)
    expect(statusText.stdout).toContain('Task: alpha')
    expect(statusText.stdout).toContain('Round: 1')
    expect(statusText.stdout).toContain('Drafted alpha solution')

    // List filters
    const listRepoA = await invokeCli(['list', '--data-root', root, '--local', '--repo', repoA, '--json'])
    expect(listRepoA.code).toBe(0)
    const repoATasks = JSON.parse(listRepoA.stdout)
    expect(repoATasks).toHaveLength(1)
    expect(repoATasks[0].task_id).toBe('alpha')

    const listQueued = await invokeCli(['list', '--data-root', root, '--local', '--status', 'queued', '--json'])
    expect(listQueued.code).toBe(0)
    const queuedTasks = JSON.parse(listQueued.stdout)
    expect(queuedTasks).toHaveLength(1)
    expect(queuedTasks[0].task_id).toBe('beta')

    // Human-readable table formatting with CJK alignment and home path shortening
    const homeTaskRepo = join(homedir(), 'Code', 'sample-project')
    await store.createTask({
      task_id: '排查「任务派生」边界问题与修复测试',
      repo_root: homeTaskRepo,
      task_text: 'CJK alignment check'
    })
    const listText = await invokeCli(['list', '--data-root', root, '--local'])
    expect(listText.code).toBe(0)
    expect(listText.stdout).toContain('STATUS')
    expect(listText.stdout).toContain('ROUND')
    expect(listText.stdout).toContain('TASK')
    expect(listText.stdout).toContain('PROJECT')
    expect(listText.stdout).toContain('UPDATED')
    expect(listText.stdout).toContain('~/Code/sample-project')
    expect(listText.stdout).toContain('◌ READY')
    expect(listText.stdout).toContain('◌ QUEUED')
    expect(listText.stdout).not.toContain('ws=')
    expect(listText.stdout).toContain('Total: 3 tasks (1 queued, 2 ready)')
  })

  it('runs dual-actor rotation end-to-end via run, wait, and result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-cli-e2e-'))
    tempRoots.push(root)
    const repoDir = join(root, 'repo')
    const mockCommand = await createMockActorScript(root, 'four_round_rotation')

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({
      launchers: {
        claude: { command: mockCommand, env: {}, timeout_seconds: 15 },
        codex: { command: mockCommand, env: {}, timeout_seconds: 15 }
      }
    })

    const runRes = await invokeCli([
      'run',
      '--data-root', root,
      '--local',
      '--task-id', 'e2e-rotate',
      '--repo', repoDir,
      '--poll-interval', '25',
      '--json',
      'Implement and review feature'
    ])

    expect(runRes.code).toBe(0)
    const summary = JSON.parse(runRes.stdout)
    expect(summary).toMatchObject({
      task_id: 'e2e-rotate',
      status: 'DONE',
      completed: true,
      done_reason: 'dual_break_confirmed',
      round: 4,
      implementer_actor: 'claude',
      reviewer_actor: 'codex'
    })
    expect(summary.actor_outputs.claude.content).toBe('Round 3 edge check added and verified')
    expect(summary.actor_outputs.codex.content).toBe('Round 4 review approved (LGTM)')
    expect(summary.final_output).toContain('Round 3 edge check added and verified')
    expect(summary.final_output).toContain('Round 4 review approved (LGTM)')

    // Result command (Markdown + --transcript)
    const resultText = await invokeCli([
      'result', 'e2e-rotate',
      '--data-root', root,
      '--local',
      '--transcript'
    ])
    expect(resultText.code).toBe(0)
    expect(resultText.stdout).toContain('# Buddy Task Result: e2e-rotate')
    expect(resultText.stdout).toContain('Done Reason: dual_break_confirmed')
    expect(resultText.stdout).toContain('## Transcript')
    expect(resultText.stdout).toContain('Round 1 implementation draft')
    expect(resultText.stdout).toContain('Round 4 review approved (LGTM)')

    // Create --no-start then wait
    const createRes = await invokeCli([
      'create',
      '--data-root', root,
      '--local',
      '--no-start',
      '--task-id', 'wait-task',
      '--repo', repoDir,
      '--prompt', 'Wait test task',
      '--json'
    ])
    expect(createRes.code).toBe(0)

    const waitRes = await invokeCli([
      'wait', 'wait-task',
      '--data-root', root,
      '--local',
      '--poll-interval', '25',
      '--json'
    ])
    expect(waitRes.code).toBe(0)
    expect(JSON.parse(waitRes.stdout)).toMatchObject({
      task_id: 'wait-task',
      status: 'DONE',
      completed: true,
      done_reason: 'dual_break_confirmed',
      round: 4
    })
  })

  it('connects to BuddyCliServer via Unix domain socket, emits UI events, and supports pause/send/cancel/delete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-cli-ipc-'))
    tempRoots.push(root)
    const repoDir = join(root, 'repo')

    const events = new BuddyEventBus()
    const published: TaskEventEnvelope[] = []
    events.subscribe((env) => published.push(env))

    const service = new BuddyCoreService({ dataRoot: root, events })
    const fastCommand = await createMockActorScript(root, 'two_round_break')
    await service.updateGlobalSettings({
      launchers: {
        claude: { command: fastCommand, env: {}, timeout_seconds: 15 },
        codex: { command: fastCommand, env: {}, timeout_seconds: 15 }
      }
    })

    const server = new BuddyCliServer({ service, events })
    servers.push(server)
    await server.start()

    // Connect without --local (uses Unix domain socket IPC)
    const prevNoLaunch = process.env.BUDDY_NO_AUTO_LAUNCH
    process.env.BUDDY_NO_AUTO_LAUNCH = '1'
    try {
      const createRes = await invokeCli([
        'create',
        '--data-root', root,
        '--task-id', 'ipc-task',
        '--repo', repoDir,
        '--prompt', 'Execute via Buddy App IPC',
        '--json'
      ])
      expect(createRes.code).toBe(0)
      const created = JSON.parse(createRes.stdout)
      expect(created.mode).toBe('app')

      expect(published.some((e) => e.task_id === 'ipc-task' && e.event.type === 'task.created')).toBe(true)

      const waitRes = await invokeCli([
        'wait', 'ipc-task',
        '--data-root', root,
        '--poll-interval', '25',
        '--json'
      ])
      expect(waitRes.code).toBe(0)
      const waitSummary = JSON.parse(waitRes.stdout)
      expect(waitSummary).toMatchObject({
        task_id: 'ipc-task',
        status: 'DONE',
        completed: true,
        done_reason: 'dual_break_confirmed'
      })

      // Send follow-up message on finished task and wait
      const sendRes = await invokeCli([
        'send', 'ipc-task',
        'Please do one more check',
        '--data-root', root,
        '--wait',
        '--poll-interval', '25',
        '--json'
      ])
      expect(sendRes.code).toBe(0)
      expect(JSON.parse(sendRes.stdout).status).toBe('DONE')

      // Test slow task: pause, send --enqueue while running, cancel, delete
      const slowCommand = await createMockActorScript(root, 'slow_running')
      await service.updateGlobalSettings({
        launchers: {
          claude: { command: slowCommand, env: {}, timeout_seconds: 15 },
          codex: { command: slowCommand, env: {}, timeout_seconds: 15 }
        }
      })

      const slowCreate = await invokeCli([
        'create',
        '--data-root', root,
        '--task-id', 'slow-task',
        '--repo', repoDir,
        '--prompt', 'Slow running task',
        '--json'
      ])
      expect(slowCreate.code).toBe(0)

      // Wait until task enters PINGING or RUNNING_CLAUDE
      const waitRunningDeadline = Date.now() + 3000
      while (Date.now() < waitRunningDeadline) {
        const d = await service.getTaskDetail('slow-task', created.workspace_key)
        if (d.state.status === 'PINGING' || d.state.status.startsWith('RUNNING_')) break
        await delay(30)
      }

      const enqueueRes = await invokeCli([
        'send', 'slow-task',
        'Queued instruction while running',
        '--data-root', root,
        '--json'
      ])
      expect(enqueueRes.code).toBe(0)
      expect(JSON.parse(enqueueRes.stdout).action).toBe('enqueued')

      const pauseRes = await invokeCli(['pause', 'slow-task', '--data-root', root, '--json'])
      expect(pauseRes.code).toBe(0)
      expect(JSON.parse(pauseRes.stdout).paused).toBe(true)

      const cancelRes = await invokeCli(['cancel', 'slow-task', '--data-root', root, '--json'])
      expect(cancelRes.code).toBe(0)
      expect(JSON.parse(cancelRes.stdout).cancelled).toBe(true)

      const delRes = await invokeCli(['delete', 'slow-task', '--data-root', root, '--json'])
      expect(delRes.code).toBe(0)
      expect(JSON.parse(delRes.stdout).deleted).toBe(true)
      expect(existsSync(service.getStore().taskDirectory('slow-task', created.workspace_key))).toBe(false)
    } finally {
      if (prevNoLaunch === undefined) delete process.env.BUDDY_NO_AUTO_LAUNCH
      else process.env.BUDDY_NO_AUTO_LAUNCH = prevNoLaunch
    }

    await server.close()
    expect(existsSync(server.socketPath)).toBe(false)
    expect(existsSync(server.discoveryPath)).toBe(false)
  })

  it('installs, inspects, executes, and uninstalls buddy CLI in PATH without touching unrelated binaries', async () => {
    const execFileAsync = promisify(execFile)
    const root = await mkdtemp(join(tmpdir(), 'buddy-cli-install-'))
    tempRoots.push(root)

    const dataRoot = join(root, 'data')
    const homeDir = join(root, 'home')
    const binDir = join(root, 'bin')
    await mkdir(homeDir, { recursive: true })

    // 1. Install into isolated binDir + update shell profile in isolated homeDir
    const installed = await installBuddyCli({
      dataRoot,
      homeDir,
      repoRoot: process.cwd(),
      pathEnv: '/usr/bin:/bin',
      targetBinDirs: [binDir]
    })

    expect(installed.installed).toBe(true)
    expect(installed.commandPath).toBe(join(binDir, 'buddy'))
    expect(installed.wrapperPath).toBe(join(dataRoot, 'bin', 'buddy'))
    expect(installed.inPath).toBe(false)
    expect(installed.shellProfileUpdated).toBe(true)
    expect(installed.shellProfilePath).toBeTruthy()
    const profileContent = await readFile(installed.shellProfilePath!, 'utf8')
    expect(profileContent).toContain(`export PATH="${binDir}:$PATH"`)

    const stat = await lstat(join(binDir, 'buddy'))
    expect(stat.isSymbolicLink()).toBe(true)

    const statusBefore = await getCliInstallStatus({
      dataRoot,
      homeDir,
      pathEnv: `${binDir}:/usr/bin:/bin`,
      targetBinDirs: [binDir]
    })
    expect(statusBefore).toMatchObject({
      installed: true,
      commandPath: join(binDir, 'buddy'),
      wrapperPath: join(dataRoot, 'bin', 'buddy'),
      inPath: true
    })

    // Execute the installed wrapper directly if out/main/cli.js is built
    if (existsSync(join(process.cwd(), 'out', 'main', 'cli.js'))) {
      const verOut = await execFileAsync(join(binDir, 'buddy'), ['--version'])
      expect(verOut.stdout.trim()).toMatch(/^buddy /)
      const helpOut = await execFileAsync(join(binDir, 'buddy'), ['--help'])
      expect(helpOut.stdout).toContain('install-cli')
    }

    // Uninstall removes symlink and wrapper
    const afterUninstall = await uninstallBuddyCli({
      dataRoot,
      homeDir,
      targetBinDirs: [binDir]
    })
    expect(afterUninstall.installed).toBe(false)
    expect(existsSync(join(binDir, 'buddy'))).toBe(false)
    expect(existsSync(join(dataRoot, 'bin', 'buddy'))).toBe(false)

    // 2. Never clobber or delete an unrelated existing 'buddy' binary
    const foreignDir = join(root, 'foreign-bin')
    await mkdir(foreignDir, { recursive: true })
    const foreignBin = join(foreignDir, 'buddy')
    await writeFile(foreignBin, '#!/bin/sh\necho foreign\n', 'utf8')
    await chmod(foreignBin, 0o755)

    const fallbackBin = join(root, 'fallback-bin')
    const secondInstall = await installBuddyCli({
      dataRoot,
      homeDir,
      repoRoot: process.cwd(),
      pathEnv: `${foreignDir}:${fallbackBin}`,
      targetBinDirs: [foreignDir, fallbackBin],
      updateShellProfile: false
    })
    expect(secondInstall.commandPath).toBe(join(fallbackBin, 'buddy'))
    expect(await readFile(foreignBin, 'utf8')).toContain('echo foreign')

    await uninstallBuddyCli({
      dataRoot,
      homeDir,
      targetBinDirs: [foreignDir, fallbackBin]
    })
    expect(existsSync(foreignBin)).toBe(true)

    // 3. CLI commands install-cli and uninstall-cli + help documentation
    const helpRes = await invokeCli(['--help'])
    expect(helpRes.code).toBe(0)
    expect(helpRes.stdout).toContain('支持的 Actor:')
    expect(helpRes.stdout).toContain('示例:')
    expect(helpRes.stdout).toContain('install-cli')
    expect(helpRes.stdout).toContain('wecode_claude')

    const cliBinDir = join(root, 'cli-bin')
    const cliInstallRes = await invokeCli([
      'install-cli',
      '--data-root', dataRoot,
      '--bin-dir', cliBinDir,
      '--json'
    ])
    expect(cliInstallRes.code).toBe(0)
    expect(JSON.parse(cliInstallRes.stdout)).toMatchObject({
      installed: true,
      commandPath: join(cliBinDir, 'buddy')
    })
    expect(existsSync(join(cliBinDir, 'buddy'))).toBe(true)

    const cliUninstallRes = await invokeCli([
      'uninstall-cli',
      '--data-root', dataRoot,
      '--bin-dir', cliBinDir,
      '--json'
    ])
    expect(cliUninstallRes.code).toBe(0)
    expect(JSON.parse(cliUninstallRes.stdout).installed).toBe(false)
    expect(existsSync(join(cliBinDir, 'buddy'))).toBe(false)
  })
})
