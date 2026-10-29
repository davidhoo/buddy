// Standalone Node program. Its authenticated socket survives Buddy restarts;
// only this supervisor signals the process group it created (never a saved PID).
const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { mkdir, writeFile, rename, rm, open } = require('node:fs/promises')
const { dirname } = require('node:path')

async function main(config) {
  let child
  let exited = false
  let stopping
  let state = { status: 'starting', supervisor_pid: process.pid, pid: null }
  let writes = Promise.resolve()
  const save = () => {
    const snapshot = JSON.stringify(state)
    writes = writes.then(async () => {
      const tmp = `${config.statusPath}.tmp`
      await writeFile(tmp, snapshot, { mode: 0o600 })
      await rename(tmp, config.statusPath)
    })
    return writes
  }
  const groupAlive = () => {
    if (!child?.pid) return false
    try { process.kill(-child.pid, 0); return true } catch (e) {
      if (e.code === 'ESRCH') return false
      throw e
    }
  }
  const signalGroup = (signal) => {
    if (!child?.pid) return
    try { process.kill(-child.pid, signal) } catch (e) { if (e.code !== 'ESRCH') throw e }
  }
  const stop = (reason) => {
    if (stopping) return stopping
    stopping = (async () => {
      signalGroup('SIGTERM')
      const until = Date.now() + 1500
      while (groupAlive() && Date.now() < until) await new Promise(r => setTimeout(r, 25))
      if (groupAlive()) signalGroup('SIGKILL')
      const killUntil = Date.now() + 1500
      while (groupAlive() && Date.now() < killUntil) await new Promise(r => setTimeout(r, 25))
      if (groupAlive()) throw new Error('Service process group did not exit')
      state = { ...state, status: reason === 'exited' ? 'exited' : 'stopped', reason, ended_at: new Date().toISOString() }
      await save()
      return state
    })().catch(async error => {
      state = { ...state, status: 'cleanup_failed', error: error.message }
      await save()
      stopping = undefined // allow a subsequent explicit cleanup attempt
      throw error
    })
    return stopping
  }
  const close = () => {
    server.close(() => { void rm(dirname(config.socket), { recursive: true, force: true }) })
  }
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${config.token}`) {
      res.writeHead(403).end(); return
    }
    try {
      if (req.url === '/stop' && req.method === 'POST') {
        await stop('requested')
        res.end(JSON.stringify(state))
        close()
      } else if (req.url === '/status') {
        res.end(JSON.stringify(state))
      } else res.writeHead(404).end()
    } catch (e) { res.writeHead(500).end(JSON.stringify({ error: e.message })) }
  })
  await mkdir(dirname(config.statusPath), { recursive: true, mode: 0o700 })
  await save()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.socket, resolve) })
  const log = await open(config.logPath, 'a', 0o600)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of Object.keys(env)) if (key.startsWith('BUDDY_SERVICE_')) delete env[key]
  child = spawn(config.command[0], config.command.slice(1), {
    cwd: config.cwd, env, detached: true, stdio: ['ignore', log.fd, log.fd]
  })
  // Register handlers before yielding: even a service that immediately exits is recorded.
  child.once('error', async error => {
    exited = true
    state = { ...state, status: 'failed', error: error.message }
    await save(); close()
  })
  child.once('exit', (code, signal) => {
    exited = true
    state = { ...state, exit_code: code, signal }
    // An exited leader must not leave children running in its owned group.
    void stop('exited').then(close).catch(() => {})
  })
  child.once('spawn', async () => {
    if (exited) return
    state = { ...state, status: 'running', pid: child.pid }
    await save()
  })
  await log.close()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => { void stop(signal).then(close).catch(() => {}) })
  }
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', data => { input += data })
process.stdin.on('end', () => {
  main(JSON.parse(input)).catch(error => { console.error(error.message); process.exitCode = 1 })
})
