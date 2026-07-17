import { createHash } from 'node:crypto'
import type { GlobalSettings, TaskSettings, TaskState, TranscriptEntry } from '../../shared/types'

const ACTOR_CLAUDE = 'claude'
const ACTOR_CODEX = 'codex'
const ACTOR_OPENCODE = 'opencode'
const ACTOR_KIMI = 'kimi'
const ROLE_MODE_CODEX_IMPL = 'codex_implements'

export const BUDDY_MESSAGE_PROTOCOL = `## Buddy Message Protocol

Your output is parsed by the buddy orchestrator. Wrap your response in the following JSON structure:

\`\`\`json
{
  "type": "chat",
  "content": "your response text here"
}
\`\`\`

- **type=chat**: Normal continuation. The loop proceeds to the next actor.
- **type=break**: Request to end the task. The other actor must also confirm with \`type=break\` before the task transitions to DONE.

Rules:
- Always output valid JSON matching this structure.
- Output the JSON as your **final text response** - do NOT use shell commands (echo, printf, etc.) to output it. The orchestrator reads your text output, not command output.
- Output raw JSON only - do NOT wrap it in a Markdown code block, and do NOT add any text before or after the JSON.
- Avoid unescaped double quotes inside \`content\`; use single quotes or escape them.
- Use \`type=break\` when: the task is fully completed, you are blocked and need human input, continuing would be counterproductive, or the other actor has failed repeatedly on the same issue across multiple rounds without meaningful progress.
- Use \`type=chat\` for all normal responses.
- The \`content\` field contains your actual response (markdown is fine).

## Dual confirmation

When one actor signals \`type=break\`, the task does NOT end immediately. The other actor must also confirm with \`type=break\` before the task transitions to DONE. If the other actor responds with \`type=chat\` instead, the break request is withdrawn and work continues.`

export interface BuildActorPromptInput {
  actor: string
  round: number
  repoRoot: string
  taskText: string
  contextText: string
  transcript: TranscriptEntry[]
  settings?: Partial<TaskSettings>
  state?: Partial<TaskState>
  globalSettings?: Partial<GlobalSettings>
  userMessage?: string
}

export function buildPingPrompt(actor: string): string {
  const parts = [
    '# buddy actor turn',
    '',
    '## Actor',
    actor,
    '',
    BUDDY_MESSAGE_PROTOCOL,
    '',
    '## Task',
    'Connectivity check — say hi to confirm you are ready.',
    '',
    '## Instruction',
    'This is a quick connectivity check before a collaborative task begins. Please respond with a brief greeting to confirm you are operational and ready to work. Use the buddy message protocol (JSON) to respond.'
  ]
  return `${parts.join('\n').trimEnd()}\n`
}

export function buildActorPrompt(input: BuildActorPromptInput): string {
  const taskText = input.taskText.trim()
  const contextText = input.contextText.trim()
  const state = input.state ?? {}
  const settings = input.settings ?? {}
  const contextHash = hashText(input.contextText)
  const contextSent = state.context_sent ?? {}
  const pendingBreak = state.pending_break
  const breakRejectedBy = state.break_rejected_by

  const parts = [
    '# buddy actor turn',
    '',
    '## Actor',
    input.actor,
    '',
    BUDDY_MESSAGE_PROTOCOL,
    '',
    '## Task',
    taskText
  ]

  if (contextText && (state.context_hash !== contextHash || !contextSent[input.actor])) {
    parts.push('', '## Background context', contextText)
  }

  if (pendingBreak) {
    const requesterLabel = actorDisplayName(pendingBreak.actor, settings)
    parts.push(
      '',
      '## Break confirmation required',
      `${requesterLabel} has signaled \`type=break\` and believes the task is complete.`,
      'You must decide:',
      '- If you also agree the task is complete, respond with `type=break` to confirm. The task will then end.',
      '- If you think work should continue, respond with `type=chat` and describe what still needs to be done. The break request will be withdrawn.',
      '',
      '**Important**: This is a priority decision. Do NOT start new work or investigate new questions. Either confirm the break or reject it with a specific reason.'
    )
  }

  if (breakRejectedBy && breakRejectedBy.actor !== input.actor) {
    const rejectedLabel = actorDisplayName(breakRejectedBy.actor, settings)
    parts.push(
      '',
      '## Break request rejected — review required',
      `Your previous \`type=break\` request was rejected by ${rejectedLabel}, who made changes to the codebase.`,
      `You must review ${rejectedLabel}'s changes before confirming completion.`,
      '- Carefully examine the changes made by the other actor.',
      '- If the changes are correct and the task is truly complete, respond with `type=break`.',
      '- If you find issues with the changes or the task is not yet complete, respond with `type=chat` and describe what needs to be fixed.'
    )
  }

  if (input.userMessage) {
    parts.push('', '## Human message', input.userMessage)
  }

  parts.push('', '## Runtime settings')
  parts.push(...runtimeSettingsLines(settings, state, input.globalSettings, input.actor, input.repoRoot))

  const recent = selectRecentTranscript(input.transcript)
  if (recent.length > 0) {
    parts.push('', '## Recent transcript')
    for (const item of recent) {
      parts.push(`### ${item.role}`, item.content)
    }
  }

  parts.push('', '## Instruction')
  const humanLang = detectHumanLanguage(input.transcript, input.userMessage ?? '', taskText, contextText)
  if (pendingBreak) {
    const requesterName = actorDisplayName(pendingBreak.actor, settings)
    parts.push(`${requesterName} has requested to end the task. Confirm with \`type=break\` or continue with \`type=chat\`.`)
  } else if (breakRejectedBy && breakRejectedBy.actor !== input.actor) {
    const rejectedName = actorDisplayName(breakRejectedBy.actor, settings)
    parts.push(`Your previous break request was rejected by ${rejectedName}, who made changes. Review their changes carefully. Only confirm with \`type=break\` if you agree the changes are correct and the task is complete.`)
  } else {
    const implementer = implementerActor(settings)
    if (input.actor === implementer) {
      parts.push('Continue the implementation work. Report changed files, what you did, and blockers.')
    } else {
      parts.push('Review the current task state. Report blocking findings first, then concise next action. If you detect that the other actor is making repeated errors or the task is stuck in a circular pattern without progress, signal `type=break` to stop and let a human decide.')
    }
  }

  if (humanLang) {
    parts.push(`默认使用最近 human message 的语言输出；当前任务使用${humanLang}。除 JSON 等编程语言外，所有自然语言内容都用${humanLang}输出。`)
  }

  // User-defined custom prompt, appended verbatim after the system prompt so
  // it applies to every actor on every round. Optional; omitted when empty.
  const customPrompt = input.globalSettings?.custom_prompt?.trim()
  if (customPrompt) {
    parts.push('', '## Custom instructions', customPrompt)
  }

  const launcher = settings.launchers?.[input.actor]
  const presetId = launcher?.prompt_preset_id
  const promptPresets = settings.prompt_presets ?? input.globalSettings?.prompt_presets
  const preset = presetId
    ? promptPresets?.find((item) => item.id === presetId)
    : undefined
  if (preset?.prompt.trim()) {
    parts.push('', `## Agent prompt preset: ${preset.name}`, preset.prompt.trim())
  }

  const agentPrompt = launcher?.custom_prompt?.trim()
  if (agentPrompt) {
    parts.push('', '## Agent-specific instructions', agentPrompt)
  }

  return `${parts.join('\n').trimEnd()}\n`
}

export function runtimeSettingsLines(
  settings: Partial<TaskSettings>,
  state: Partial<TaskState>,
  globalSettings: Partial<GlobalSettings> | undefined,
  actor: string,
  repoRoot = ''
): string[] {
  const maxRounds = numberValue(globalSettings?.max_rounds, 9999)
  const roundsInWindow = numberValue(state.rounds_in_window, 0)
  const remaining = maxRounds === -1 ? 'unlimited' : (maxRounds > 0 ? Math.max(0, maxRounds - roundsInWindow) : 'unlimited')
  const lines = [
    `- Current total round: ${numberValue(state.round, 0)}`,
    `- Automatic rounds used in this window: ${roundsInWindow}/${maxRounds === -1 ? 'unlimited' : maxRounds}`,
    `- Automatic rounds remaining in this window: ${remaining}`,
    `- Next actor after this turn: ${nextActor(actor, settings)}`
  ]
  if (repoRoot) lines.push(`- Repository: ${repoRoot}`)
  if (state.countdown?.deadline) lines.push(`- Active countdown deadline: ${state.countdown.deadline}`)
  const consecutiveFailures = numberValue(state.consecutive_failures, 0)
  if (consecutiveFailures > 0) {
    lines.push(`- Consecutive failures: ${consecutiveFailures}`)
    if (state.latest_failure?.message) {
      const msg = state.latest_failure.message.length > 200
        ? state.latest_failure.message.slice(0, 200) + '...'
        : state.latest_failure.message
      lines.push(`- Latest failure: ${msg}`)
    }
  }
  return lines
}

export function selectRecentTranscript(transcript: TranscriptEntry[], window = 6): TranscriptEntry[] {
  const recent = transcript.slice(-window)
  const recentKeys = new Set(recent.map(rowKey))
  const earlier = transcript.slice(0, -window)

  const roles = ['human', ...new Set(transcript.map((item) => item.role).filter((role) => role !== 'human' && role !== 'system'))]
  for (const role of roles) {
    if (recent.some((item) => item.role === role)) continue
    const last = [...earlier].reverse().find((item) => item.role === role)
    if (last && !recentKeys.has(rowKey(last))) {
      recent.unshift(last)
      recentKeys.add(rowKey(last))
    }
  }

  return recent.sort((a, b) => seqValue(a) - seqValue(b))
}

export function detectHumanLanguage(
  transcript: TranscriptEntry[],
  userMessage = '',
  taskText = '',
  contextText = ''
): string {
  let text = userMessage.trim()
  if (!text) {
    const latestHuman = [...transcript].reverse().find((item) => item.role === 'human')
    text = latestHuman?.content.trim() ?? ''
  }
  if (!text) text = taskText.trim()
  if (!text) text = contextText.trim()
  if (!text) return ''

  let cjkCount = 0
  for (const ch of text) {
    if (('一' <= ch && ch <= '鿿') || ('㐀' <= ch && ch <= '䶿')) cjkCount += 1
  }
  const nonSpace = text.replace(/\s/g, '').length
  return nonSpace > 0 && cjkCount / nonSpace > 0.1 ? '中文' : 'English'
}

export function nextActor(actor: string, settings: Partial<TaskSettings>): string {
  const implementer = settings.implementer_actor ?? ACTOR_CLAUDE
  const reviewer = settings.reviewer_actor ?? ACTOR_CODEX
  return actor === implementer ? reviewer : implementer
}

export function implementerActor(settings: Partial<TaskSettings>): string {
  return settings.implementer_actor
    ?? (settings.role_mode === ROLE_MODE_CODEX_IMPL ? ACTOR_CODEX : ACTOR_CLAUDE)
}

export function actorDisplayName(actor: unknown, settings?: Partial<TaskSettings>): string {
  if (typeof actor === 'string') {
    const configured = settings?.launchers?.[actor]?.display_name?.trim()
    if (configured) return configured
  }
  if (actor === ACTOR_CLAUDE) return 'Claude Code'
  if (actor === ACTOR_OPENCODE) return 'OpenCode'
  if (actor === ACTOR_KIMI) return 'Kimi Code'
  if (actor === ACTOR_CODEX) return 'Codex'
  if (actor === 'cursor' || actor === 'cursor-agent' || (typeof actor === 'string' && actor.startsWith('cursor-agent-'))) {
    return 'Cursor Agent'
  }
  return typeof actor === 'string' && actor ? actor : 'Codex'
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function rowKey(item: TranscriptEntry): unknown {
  const seq = seqValue(item)
  return seq || `${item.role}:${item.ts}:${item.content}`
}

function seqValue(item: TranscriptEntry): number {
  const seq = (item as TranscriptEntry & { seq?: unknown }).seq
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : 0
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
