/**
 * Static credential probes + open-guidance helpers.
 * No background login process, progress, or cancel.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import type { LibraryTarget, TargetAuthStatus } from '../../../shared/library'
import { parseJsonc } from './edit/jsonc'

function claudeCredentialsPath(target: LibraryTarget): string | undefined {
  // Magpie: beside settings / .claude.json → ~/.claude.json's directory or ~/.claude/.credentials.json
  if (target.agentId !== 'claude' || target.configContext !== 'native') return undefined
  return join(homedir(), '.claude', '.credentials.json')
}

/** Read-only: does Claude Code's credentials file mention this server name? Never stores tokens. */
export async function probeClaudeMcpAuth(target: LibraryTarget, serverName: string): Promise<TargetAuthStatus> {
  const path = claudeCredentialsPath(target)
  if (!path) {
    return { targetId: target.targetId, serverName, status: 'unknown', detail: 'no static probe for this target' }
  }
  try {
    const raw = parseJsonc<Record<string, unknown>>(await readFile(path, 'utf8'))
    const oauth = raw.mcpOAuth
    if (!oauth || typeof oauth !== 'object') {
      return { targetId: target.targetId, serverName, status: 'not-found', detail: 'no mcpOAuth map' }
    }
    const hit = Object.keys(oauth as Record<string, unknown>).some((key) => key === serverName || key.startsWith(`${serverName}|`))
    return {
      targetId: target.targetId,
      serverName,
      status: hit ? 'signed-in' : 'not-found',
      detail: hit ? 'mcpOAuth entry present (token not read into Buddy)' : 'no matching mcpOAuth entry'
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { targetId: target.targetId, serverName, status: 'not-found', detail: 'credentials file missing' }
    }
    return { targetId: target.targetId, serverName, status: 'unknown', detail: 'credentials unreadable' }
  }
}

export async function probeAuth(target: LibraryTarget, serverName: string): Promise<TargetAuthStatus> {
  if (target.agentId === 'claude' && target.capabilities.authProbe) {
    return probeClaudeMcpAuth(target, serverName)
  }
  return {
    targetId: target.targetId,
    serverName,
    status: 'unknown',
    detail: '请在 Agent 中确认（无可靠静态探测接口）'
  }
}

export function authGuidance(target: LibraryTarget, serverName: string): { title: string; steps: string[]; cwd?: string } {
  if (target.agentId === 'claude') {
    return {
      title: '在 Claude Code 中完成 MCP 登录',
      cwd: dirname(target.mcpPath || join(homedir(), '.claude.json')),
      steps: [
        '打开终端并进入 Claude Code',
        `运行 /mcp 或在设置中找到服务器「${serverName}」`,
        '按原生提示完成登录；Buddy 不会代跑登录进程'
      ]
    }
  }
  if (target.agentId === 'codex' || target.agentId === 'wecode_codex') {
    return {
      title: '在 Codex 中确认 MCP 认证',
      cwd: target.mcpPath ? dirname(target.mcpPath) : undefined,
      steps: [
        `确认写入目标：${target.displayName}（${target.configContext}）`,
        `配置文件：${target.mcpPath || '（尚未初始化）'}`,
        '在 Codex 原生界面或 CLI 中按该服务器要求登录；Buddy 只提供指引'
      ]
    }
  }
  return {
    title: `在 ${target.displayName} 中确认 MCP 认证`,
    cwd: target.mcpPath ? dirname(target.mcpPath) : undefined,
    steps: [
      `服务器：${serverName}`,
      '打开对应 Agent，按其原生 MCP / 设置流程操作',
      'Buddy 不托管登录、不显示虚假进度'
    ]
  }
}

/** Open Terminal.app at cwd with a printed hint (macOS). No login subprocess. */
export function openTerminalGuidance(cwd: string | undefined, hint: string): void {
  const dir = cwd || homedir()
  const script = `cd ${JSON.stringify(dir)}; clear; echo ${JSON.stringify(hint)}; exec \"$SHELL\" -l`
  spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`], {
    detached: true,
    stdio: 'ignore'
  }).unref()
}
