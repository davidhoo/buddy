/** Magpie-style managed instruction blocks, one Buddy library item per paired markers. */

const ID_SAFE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function instructionBegin(id: string): string {
  return `<!-- BEGIN BUDDY MANAGED INSTRUCTION: ${id} -->`
}

export function instructionEnd(id: string): string {
  return `<!-- END BUDDY MANAGED INSTRUCTION: ${id} -->`
}

export function isInstructionId(id: string): boolean {
  return ID_SAFE.test(id)
}

/** Split one managed block out of a file. ok is false when that id is absent. */
export function splitInstructionBlock(file: string, id: string): { before: string; body: string; after: string; ok: boolean } {
  if (!isInstructionId(id)) return { before: file, body: '', after: '', ok: false }
  const begin = instructionBegin(id)
  const end = instructionEnd(id)
  const i = file.indexOf(begin)
  if (i < 0) return { before: file, body: '', after: '', ok: false }
  const rest = file.slice(i + begin.length)
  const j = rest.indexOf(end)
  if (j < 0) return { before: file, body: '', after: '', ok: false }
  return {
    before: file.slice(0, i),
    body: rest.slice(0, j).replace(/^\n/, '').replace(/\n$/, ''),
    after: rest.slice(j + end.length),
    ok: true
  }
}

/** File text with every Buddy managed instruction block removed. */
export function ownInstructionText(file: string): string {
  let next = file.replace(/\r\n/g, '\n')
  const begin = '<!-- BEGIN BUDDY MANAGED INSTRUCTION: '
  for (;;) {
    const i = next.indexOf(begin)
    if (i < 0) break
    const idStart = i + begin.length
    const idEnd = next.indexOf(' -->', idStart)
    if (idEnd < 0) break
    const id = next.slice(idStart, idEnd)
    const split = splitInstructionBlock(next, id)
    if (!split.ok) {
      next = `${next.slice(0, i)}${next.slice(idEnd + 4)}`
      continue
    }
    next = `${split.before.trimEnd()}\n\n${split.after.trimStart()}`
  }
  return collapseBlank(next).trim()
}

/**
 * Set or remove one managed block. Empty body removes that id.
 * User text outside Buddy blocks is preserved character-for-character aside from trailing newlines around the splice.
 */
export function withInstructionBlock(file: string, id: string, body: string): string {
  if (!isInstructionId(id)) return file
  const normalized = file.replace(/\r\n/g, '\n')
  const text = body.replace(/\r\n/g, '\n').trim()
  const { before, after, ok } = splitInstructionBlock(normalized, id)
  const head = ok ? before.replace(/\n+$/, '') : normalized.replace(/\n+$/, '')
  const tail = ok ? after.replace(/^\n+/, '').replace(/\n+$/, '') : ''
  const block = text ? `${instructionBegin(id)}\n${text}\n${instructionEnd(id)}` : ''
  const parts = [head, block, tail].filter((part) => part.trim() !== '')
  if (parts.length === 0) return ''
  return `${parts.join('\n\n')}\n`
}

function collapseBlank(value: string): string {
  let next = value
  while (next.includes('\n\n\n')) next = next.replace(/\n\n\n/g, '\n\n')
  return next
}
