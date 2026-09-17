import { basename } from 'node:path'
import { splitCommand } from '../launchers'

/**
 * Return default ACP arguments for known CLI commands if not explicitly provided.
 */
export function defaultAcpArgs(command: string, actor?: string): string[] {
  const rawTokens = splitCommand(command)
  const exe = basename(rawTokens[0] || '').toLowerCase()
  const secondToken = rawTokens[1]?.toLowerCase()

  // If command already contains 'acp' argument anywhere, do not duplicate
  if (rawTokens.some((t) => t.toLowerCase() === 'acp')) {
    return []
  }

  // If invoking an adapter package directly
  if (exe.includes('codex-acp') || exe.includes('claude-agent-acp')) {
    return []
  }

  if (exe === 'wecode') {
    if (secondToken === 'opencode' || actor === 'opencode') {
      return ['opencode', 'acp']
    }
    return ['acp']
  }

  if (exe === 'opencode') {
    return ['acp']
  }

  if (exe === 'kimi') {
    return ['acp']
  }

  if (exe === 'agent' || exe === 'cursor-agent') {
    return ['acp']
  }

  return ['acp']
}
