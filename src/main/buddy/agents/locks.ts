// A pending updater has priority over new users. Snapshot reads never take a lease.
let readers = 0
let writer = false
const waitingReaders = new Set<() => void>()
let waitingWriter: (() => void) | undefined
function wake() {
  if (writer) return
  if (waitingWriter) { if (!readers) waitingWriter(); return }
  for (const resolve of [...waitingReaders]) resolve()
}
export async function acquireAgentUse(): Promise<() => void> {
  while (writer || waitingWriter) await new Promise<void>(resolve => {
    const done = () => { waitingReaders.delete(done); resolve() }
    waitingReaders.add(done)
  })
  readers++
  let released = false
  return () => { if (!released) { released = true; readers--; wake() } }
}
export function acquireAgentUpdate(): (() => void) | undefined {
  if (writer || readers || waitingWriter) return undefined
  writer = true
  let released = false
  return () => { if (!released) { released = true; writer = false; wake() } }
}
export function waitForAgentUpdate(signal: AbortSignal): Promise<() => void> {
  if(signal.aborted)return Promise.reject(new Error('Update cancelled'))
  const immediate = acquireAgentUpdate()
  if (immediate) return Promise.resolve(immediate)
  if (waitingWriter) return Promise.reject(new Error('An updater is already waiting'))
  return new Promise((resolve, reject) => {
    const cancel = () => { waitingWriter = undefined; signal.removeEventListener('abort', cancel); wake(); reject(new Error('Update cancelled')) }
    waitingWriter = () => {
      waitingWriter = undefined
      signal.removeEventListener('abort', cancel)
      const release = acquireAgentUpdate()
      if (release) resolve(release)
      else reject(new Error('Update lease unavailable'))
    }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    else wake()
  })
}
