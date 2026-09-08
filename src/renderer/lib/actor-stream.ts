export type ActorStreamMode = 'delta' | 'line'

export interface ActorStreamLine {
  text: string
  ts: string
  mode?: ActorStreamMode
}

/**
 * Append a live stdout chunk.
 * Only `mode: 'delta'` coalesces into the current text row. Everything else
 * (tools, reconnect, other actors) becomes a new independent row.
 */
export function appendActorStreamLine(
  prev: ActorStreamLine[],
  next: ActorStreamLine
): ActorStreamLine[] {
  if (!next.text) return prev
  const mode: ActorStreamMode = next.mode === 'delta' ? 'delta' : 'line'

  if (mode === 'delta') {
    if (prev.length === 0) return [{ text: next.text, ts: next.ts, mode: 'delta' }]
    const last = prev[prev.length - 1]
    if (last.mode === 'delta') {
      return [
        ...prev.slice(0, -1),
        { text: last.text + next.text, ts: next.ts, mode: 'delta' }
      ]
    }
    return [...prev, { text: next.text, ts: next.ts, mode: 'delta' }]
  }

  return [...prev, { text: next.text, ts: next.ts, mode: 'line' }]
}
