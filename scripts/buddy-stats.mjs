#!/usr/bin/env node
// 从本地 buddy 数据目录统计真实提效指标。
// 用法: node scripts/buddy-stats.mjs
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DATA_DIR = process.env.BUDDY_DATA_ROOT
  || `${homedir()}/Library/Application Support/buddy`

const WORKSPACES_DIR = join(DATA_DIR, 'workspaces')

async function exists(p) {
  try { await stat(p); return true } catch { return false }
}

async function readJson(p) {
  try {
    const raw = await readFile(p, 'utf8')
    return JSON.parse(raw)
  } catch { return null }
}

async function readJsonl(p) {
  const out = []
  try {
    const raw = await readFile(p, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      try { out.push(JSON.parse(t)) } catch {}
    }
  } catch {}
  return out
}

function round(n, d = 1) {
  const f = Math.pow(10, d)
  return Math.round(n * f) / f
}

async function main() {
  if (!(await exists(WORKSPACES_DIR))) {
    console.log(JSON.stringify({ error: `workspaces dir not found: ${WORKSPACES_DIR}` }))
    return
  }

  const workspaces = (await readdir(WORKSPACES_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  let totalTasks = 0
  let doneTasks = 0
  let pausedTasks = 0
  let runningTasks = 0
  let readyTasks = 0
  let failedTasks = 0
  let countdownTasks = 0

  let totalRounds = 0          // 所有任务的 round 累加（已完成轮次近似）
  const roundsByStatus = { DONE: [], others: [] }

  let compactResets = 0
  let failureEvents = 0
  let upgradeEvents = 0
  let instructionQueueUsed = 0

  // 端到端时长：用 created_at -> updated_at（仅 DONE 任务）
  const doneDurationsMin = []
  // 任务时间分布（按天）
  const byDay = {}

  const actorUsage = {}        // 哪些 actor 参与过运行

  for (const ws of workspaces) {
    const tasksDir = join(WORKSPACES_DIR, ws, 'tasks')
    if (!(await exists(tasksDir))) continue
    let taskIds
    try { taskIds = await readdir(tasksDir, { withFileTypes: true }) } catch { continue }
    for (const td of taskIds) {
      if (!td.isDirectory()) continue
      totalTasks++
      const taskDir = join(tasksDir, td.name)
      const state = await readJson(join(taskDir, 'state.json'))
      if (!state) continue

      const status = state.status
      if (status === 'DONE') { doneTasks++; roundsByStatus.DONE.push(state.round ?? 0) }
      else if (status === 'PAUSED') pausedTasks++
      else if (status && status.startsWith('RUNNING')) runningTasks++
      else if (status === 'READY') readyTasks++
      else if (status === 'FAILED') failedTasks++
      else if (status === 'COUNTDOWN') countdownTasks++

      const r = state.round ?? 0
      totalRounds += r

      // actor 使用
      for (const a of [state.next_actor, state.active_run?.actor]) {
        if (a) actorUsage[a] = (actorUsage[a] || 0) + 1
      }
      // 指令队列
      if (Array.isArray(state.instruction_queue) && state.instruction_queue.length > 0) instructionQueueUsed++

      // 时长
      const c = state.created_at, u = state.updated_at
      if (status === 'DONE' && c && u) {
        const cMs = Date.parse(c), uMs = Date.parse(u)
        if (!isNaN(cMs) && !isNaN(uMs) && uMs >= cMs) {
          doneDurationsMin.push((uMs - cMs) / 60000)
        }
      }
      if (c) {
        const day = new Date(Date.parse(c)).toISOString().slice(0, 10)
        if (!isNaN(Date.parse(c))) byDay[day] = (byDay[day] || 0) + 1
      }

      // 事件流统计
      const events = await readJsonl(join(taskDir, 'events.jsonl'))
      for (const e of events) {
        const t = e.type || ''
        if (/compact|session_reset|context.*reset/i.test(t)) compactResets++
        if (/fail|error/i.test(t) && /fail/i.test(t)) failureEvents++
        if (/upgrade/i.test(t)) upgradeEvents++
      }
    }
  }

  const avgDoneRounds = roundsByStatus.DONE.length
    ? round(roundsByStatus.DONE.reduce((a, b) => a + b, 0) / roundsByStatus.DONE.length, 1) : 0

  const avgDoneDurationMin = doneDurationsMin.length
    ? round(doneDurationsMin.reduce((a, b) => a + b, 0) / doneDurationsMin.length, 1) : 0

  // 活跃天数（有任务创建的天数）
  const activeDays = Object.keys(byDay).length
  // 时间跨度
  const days = Object.keys(byDay).sort()
  let spanDays = 0
  if (days.length >= 2) {
    spanDays = Math.round((Date.parse(days[days.length - 1]) - Date.parse(days[0])) / 86400000) + 1
  }

  const stats = {
    workspaces: workspaces.length,
    totalTasks,
    byStatus: { DONE: doneTasks, PAUSED: pausedTasks, RUNNING: runningTasks, READY: readyTasks, FAILED: failedTasks, COUNTDOWN: countdownTasks },
    doneRate: totalTasks ? round((doneTasks / totalTasks) * 100, 1) + '%' : '0%',
    totalRoundsAccumulated: totalRounds,
    avgRoundsPerDoneTask: avgDoneRounds,
    avgDoneDurationMin,
    compactResets,
    failureEvents,
    upgradeEvents,
    instructionQueueUsedTasks: instructionQueueUsed,
    actorUsage,
    activeDays,
    spanDays,
    tasksPerActiveDay: activeDays ? round(totalTasks / activeDays, 1) : 0,
    firstTaskDay: days[0],
    lastTaskDay: days[days.length - 1]
  }
  console.log(JSON.stringify(stats, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })
