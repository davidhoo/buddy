import { stripTerminalDecorations } from '../shell-path'

/** Read command declarations only, never examples or arbitrary help prose. */
export function nativeUpdateCommandFromHelp(help: string): string | undefined {
  let commands = false
  for (const line of stripTerminalDecorations(help).split(/\r?\n/)) {
    if (/^Commands:\s*$/.test(line)) { commands = true; continue }
    if (!commands) continue
    if (/^\S/.test(line) && line.trim()) break
    const match = /^\s+(update|upgrade)(?:\|(update|upgrade))?(?:\s+\[[^\]]+\])*\s{2,}(.+)$/i.exec(line)
    if (match && /\b(latest|version|binary|self|updates)\b/i.test(match[3])) return match[1]
  }
  return undefined
}

/** Kimi releases expose ACP as either a subcommand or a top-level flag. */
export function kimiAcpArgsFromHelp(help: string): string[] | undefined {
  const lines = stripTerminalDecorations(help).split(/\r?\n/).map(line => line.replace(/^[\s│|]+/, ''))
  if (lines.some(line => /^acp(?:\s|\[|$)/.test(line))) return ['acp']
  if (lines.some(line => /^(?:-\w,\s*)?--acp(?:\s|[=,\[]|$)/.test(line))) return ['--acp']
  return undefined
}
