import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'
import { TaskServiceManager, type ServiceRun } from '../../../src/main/buddy/task-services'
import { BuddyRunner } from '../../../src/main/buddy/runner'
import { BuddyCoreService } from '../../../src/main/buddy/service'

const execute = promisify(execFile)
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const fixtures: Array<{ root: string; store: BuddyStore; manager: TaskServiceManager; leases: ServiceRun[]; workspace: string }> = []
async function fixture(task = 'demo') {
  const root = await mkdtemp(join(tmpdir(), 'buddy-services-test-'))
  const store = new BuddyStore(join(root, 'data'))
  const created = await store.createTask({ task_id: task, repo_root: root })
  const manager = new TaskServiceManager(store)
  const result = { root, store, manager, leases: [] as ServiceRun[], workspace: created.workspace_key }
  fixtures.push(result)
  return result
}
async function run(f: Awaited<ReturnType<typeof fixture>>, id = 'r1', task = 'demo') {
  await f.store.updateTaskState(task, f.workspace, state => ({ ...state, status: 'RUNNING_CURSOR', active_run: { actor: 'cursor', run_id: id, started_at: new Date().toISOString() } }))
  const lease = await f.manager.openRun(task, f.workspace, id, {})
  f.leases.push(lease)
  return lease
}
async function client(lease: ServiceRun, cwd: string, args: string[]) {
  const { stdout } = await execute(process.execPath, [lease.env.BUDDY_SERVICE_CLI, ...args], { cwd, env: { ...process.env, ...lease.env, ELECTRON_RUN_AS_NODE: '1' } })
  return JSON.parse(stdout)
}
const command = [process.execPath, '-e', 'setInterval(() => {}, 1000)']
async function registryFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  return (await Promise.all(entries.map(e => e.isDirectory() ? registryFiles(join(root, e.name)) : e.name.endsWith('.service.json') ? [join(root, e.name)] : []))).flat()
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const lease of f.leases) lease.close()
    const tools = await readdir(join(f.store.dataRoot, 'runtime/service-tools')).catch(() => [])
    const cli = tools.find(file => file.startsWith('client-'))
    if (cli) for (const record of await registryFiles(f.store.dataRoot)) {
      const data = JSON.parse(await readFile(record, 'utf8'))
      if (data.owner === 'buddy') await execute(process.execPath, [join(f.store.dataRoot, 'runtime/service-tools', cli), 'stop-owned', record], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).catch(() => {})
    }
  }
})

describe('task-owned service lifecycle', () => {
  it('isolates tasks even when their services use the same name', async () => {
    const f = await fixture()
    await f.store.createTask({ task_id: 'other', repo_root: f.root })
    const firstRun = await run(f)
    const otherRun = await run(f, 'other-run', 'other')
    const first = await client(firstRun, f.root, ['start', 'worker', '--', ...command])
    const other = await client(otherRun, f.root, ['start', 'worker', '--', ...command])
    expect(first.pid).not.toBe(other.pid)
    expect(await f.manager.cleanupTask('demo', f.workspace)).toEqual([])
    expect(alive(first.pid)).toBe(false)
    expect(alive(other.pid)).toBe(true)
    expect(await f.manager.cleanupTask('other', f.workspace)).toEqual([])
  }, 15000)

  it('retains an already started service only after an explicit keep request', async () => {
    const f = await fixture()
    const lease = await run(f)
    const worker = await client(lease, f.root, ['start', 'worker', '--', ...command])
    await expect(client(lease, f.root, ['keep', 'worker'])).rejects.toThrow()
    await client(lease, f.root, ['keep', 'worker', 'User explicitly requested a persistent preview'])
    expect(await f.manager.cleanupTask('demo', f.workspace)).toEqual([])
    expect(alive(worker.pid)).toBe(true)
  }, 15000)
  it.each(['confirmed', 'reviewer-failed'])('cleans services when a task finishes: %s', async mode => {
    const f = await fixture()
    const actor = join(f.root, 'actor.cjs')
    await writeFile(actor, `const {execFileSync}=require('child_process');const fs=require('fs');
const result=JSON.parse(execFileSync(process.env.BUDDY_SERVICE_NODE,[process.env.BUDDY_SERVICE_CLI,'start','worker','--',${JSON.stringify(process.execPath)},'-e','setInterval(()=>{},1000)'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}}));
fs.appendFileSync('pids',String(result.pid)+'\\n');
if (${JSON.stringify(mode)} === 'reviewer-failed' && process.env.BUDDY_ACTOR === 'codex') { process.stderr.write('reviewer unavailable');process.exit(1) }
console.log(JSON.stringify({type:'break',content:'done'}));`)
    const launcher = { command: `${process.execPath} ${actor}`, env: {}, timeout_seconds: 10 }
    await f.store.updateGlobalSettings({ max_rounds: 4, countdown_seconds: 0, launchers: { claude: launcher, codex: launcher } })
    await f.store.deleteTask('demo', f.workspace)
    await f.store.createTask({ task_id: 'demo', repo_root: f.root })
    const runner = new BuddyRunner(f.store)
    await runner.startTask('demo', { workspace_key: f.workspace, actor: 'claude' })
    const pids = (await readFile(join(f.root, 'pids'), 'utf8')).trim().split('\n').map(Number)
    expect(pids).toHaveLength(2)
    expect(new Set(pids).size).toBe(1)
    expect(alive(pids[0])).toBe(false)
    const detail = await f.store.getTaskDetail('demo', f.workspace)
    expect(detail.state.status).toBe('DONE')
    expect(detail.events.some(e => e.type === 'service.cleanup_completed')).toBe(true)
  }, 15000)

  it('cancels a live actor that ignores SIGTERM before deleting task files', async () => {
    const f = await fixture()
    const actor = join(f.root, 'actor.cjs')
    await writeFile(actor, `require('fs').writeFileSync('actor.pid',String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`)
    await f.store.updateGlobalSettings({ launchers: { claude: { command: `${process.execPath} ${actor}`, env: {}, timeout_seconds: 30 } } })
    await f.store.deleteTask('demo', f.workspace)
    await f.store.createTask({ task_id: 'demo', repo_root: f.root })
    const service = new BuddyCoreService({ dataRoot: f.store.dataRoot })
    const running = service.startTask('demo', { workspace_key: f.workspace, actor: 'claude' })
    await vi.waitFor(async () => expect(await readFile(join(f.root, 'actor.pid'), 'utf8')).toBeTruthy())
    const pid = Number(await readFile(join(f.root, 'actor.pid'), 'utf8'))
    await service.deleteTask('demo', f.workspace)
    await running
    expect(alive(pid)).toBe(false)
    await expect(f.store.readTaskState('demo', f.workspace)).rejects.toThrow()
  }, 15000)

  it('cancels both live health checks without starting an actor round', async () => {
    const f = await fixture()
    const actor = join(f.root, 'ping.cjs')
    await writeFile(actor, `require('fs').appendFileSync('health.pids',String(process.pid)+'\\n');setInterval(()=>{},1000)`)
    const launcher = { command: `${process.execPath} ${actor}`, env: {}, timeout_seconds: 30 }
    await f.store.updateGlobalSettings({ launchers: { claude: launcher, codex: launcher } })
    await f.store.deleteTask('demo', f.workspace)
    await f.store.createTask({ task_id: 'demo', repo_root: f.root })
    const runner = new BuddyRunner(f.store)
    const running = runner.startTask('demo', { workspace_key: f.workspace })
    await vi.waitFor(async () => expect((await readFile(join(f.root, 'health.pids'), 'utf8')).trim().split('\n')).toHaveLength(2))
    await runner.cancelTask('demo', f.workspace)
    await running
    const pids = (await readFile(join(f.root, 'health.pids'), 'utf8')).trim().split('\n').map(Number)
    expect(pids.every(pid => !alive(pid))).toBe(true)
    const detail = await f.store.getTaskDetail('demo', f.workspace)
    expect(detail.state.status).toBe('CANCELLED')
    expect(detail.events.some(e => e.type === 'actor.started')).toBe(false)
    await expect(runner.startTask('demo', { workspace_key: f.workspace })).rejects.toThrow('cancelled')
    await runner.interrupt('demo', f.workspace)
    expect((await f.store.readTaskState('demo', f.workspace)).status).toBe('CANCELLED')
  }, 15000)
  it('reuses services across actor handoffs and cleans up a running process group', async () => {
    const f = await fixture()
    const a = await run(f)
    const script = "const cp=require('child_process'); const fs=require('fs'); const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('child.pid',String(c.pid));setInterval(()=>{},1000)"
    const first = await client(a, f.root, ['start', 'worker', '--', process.execPath, '-e', script])
    expect(alive(first.pid)).toBe(true)
    a.close()
    const b = await run(f, 'r2')
    const second = await client(b, f.root, ['start', 'worker', '--', process.execPath, '-e', script])
    expect(second).toMatchObject({ pid: first.pid, reused: true })
    const child = Number(await readFile(join(f.root, 'child.pid'), 'utf8'))
    expect(alive(child)).toBe(true)
    expect(await f.manager.cleanupTask('demo', f.workspace)).toEqual([])
    expect(alive(first.pid)).toBe(false)
    expect(alive(child)).toBe(false)
    await expect(client(b, f.root, ['start', 'late', '--', ...command])).rejects.toThrow()
  }, 15000)

  it('preserves explicit retention and external services, with an explicit stop after deletion', async () => {
    const f = await fixture()
    const lease = await run(f)
    const external = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    try {
      const kept = await client(lease, f.root, ['start', 'keep', '--keep', 'user asked to keep preview', '--', ...command])
      const managed = await client(lease, f.root, ['start', 'worker', '--', ...command])
      await client(lease, f.root, ['external', 'existing', String(external.pid)])
      await expect(client(lease, f.root, ['stop', 'existing'])).rejects.toThrow('never stopped')
      const service = new BuddyCoreService({ dataRoot: f.store.dataRoot })
      await service.deleteTask('demo', f.workspace)
      expect(alive(managed.pid)).toBe(false)
      expect(alive(kept.pid)).toBe(true)
      expect(alive(external.pid!)).toBe(true)
      const record = (await registryFiles(f.store.dataRoot)).find(path => path.endsWith('/keep.service.json'))!
      await execute(process.execPath, [lease.env.BUDDY_SERVICE_CLI, 'stop-owned', record])
      expect(alive(kept.pid)).toBe(false)
    } finally { external.kill('SIGTERM') }
  }, 15000)

  it('recovers ownership after restart, preserving paused services and cleaning terminal ones', async () => {
    const f = await fixture()
    const lease = await run(f)
    const worker = await client(lease, f.root, ['start', 'worker', '--', ...command])
    lease.close()
    await f.store.updateTaskState('demo', f.workspace, state => ({ ...state, status: 'PAUSED', active_run: null }))
    const restarted = new TaskServiceManager(f.store)
    await restarted.recover()
    expect(alive(worker.pid)).toBe(true)
    await f.store.updateTaskState('demo', f.workspace, state => ({ ...state, status: 'DONE' }))
    await restarted.recover()
    expect(alive(worker.pid)).toBe(false)
  }, 15000)

  it('does not trust stale PIDs or kill an unrelated process when the supervisor is unreachable', async () => {
    const f = await fixture()
    const lease = await run(f)
    const worker = await client(lease, f.root, ['start', 'worker', '--', ...command])
    await client(lease, f.root, ['stop', 'worker'])
    const file = (await registryFiles(f.store.dataRoot))[0]
    const record = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(record.status_path, JSON.stringify({ status: 'running', pid: process.pid, supervisor_pid: process.pid }))
    const failures = await f.manager.cleanupTask('demo', f.workspace)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('Cannot verify')
    expect(alive(process.pid)).toBe(true)
    expect(alive(worker.pid)).toBe(false)
  })

  it('cleans a failed start without losing its record', async () => {
    const f = await fixture()
    const lease = await run(f)
    await expect(client(lease, f.root, ['start', 'bad', '--', '/definitely/not/a/program'])).rejects.toThrow('failed to stay running')
    expect(await f.manager.cleanupTask('demo', f.workspace)).toEqual([])
    expect(await registryFiles(f.store.dataRoot)).toHaveLength(1)
  })

  it('uses the real runner environment, preserves round pauses and cleans on cancellation', async () => {
    const f = await fixture()
    const actor = join(f.root, 'actor.cjs')
    await writeFile(actor, `const {execFileSync}=require('child_process');const fs=require('fs');const result=JSON.parse(execFileSync(process.env.BUDDY_SERVICE_NODE,[process.env.BUDDY_SERVICE_CLI,'start','worker','--',${JSON.stringify(process.execPath)},'-e','setInterval(()=>{},1000)'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}}));fs.writeFileSync('service.json',JSON.stringify(result));console.log(JSON.stringify({type:'chat',content:'ready'}));`)
    await f.store.updateGlobalSettings({ max_rounds: 1, launchers: { claude: { command: `${process.execPath} ${actor}`, env: {}, timeout_seconds: 15 } } })
    await f.store.deleteTask('demo', f.workspace)
    await f.store.createTask({ task_id: 'demo', repo_root: f.root })
    const runner = new BuddyRunner(f.store)
    await runner.startTask('demo', { workspace_key: f.workspace, actor: 'claude' })
    const worker = JSON.parse(await readFile(join(f.root, 'service.json'), 'utf8'))
    expect((await f.store.readTaskState('demo', f.workspace)).status).toBe('PAUSED')
    expect(alive(worker.pid)).toBe(true)
    await runner.cancelTask('demo', f.workspace)
    expect((await f.store.readTaskState('demo', f.workspace)).status).toBe('CANCELLED')
    expect(alive(worker.pid)).toBe(false)
  }, 15000)
})
