import type { AgentUpdateSnapshot } from '../../../shared/agents'

interface QueueLifecycle {
  getState(): Promise<AgentUpdateSnapshot>
  cancel(): Promise<void>
  waitForIdle(): Promise<void>
}
/** Every intentional quit, including Buddy's own updater, goes through this gate. */
export class AgentUpdateQuitGuard {
  private pending?: Promise<boolean>
  constructor(private queue: QueueLifecycle, private choose: () => Promise<'background'|'finish'>) {}
  request(quit: () => void): Promise<boolean> {
    if(this.pending)return this.pending
    this.pending=this.run(quit).finally(()=>{this.pending=undefined})
    return this.pending
  }
  private async run(quit:()=>void) {
    // A corrupt history prevents starting new work, but must not prevent quitting.
    const state=await this.queue.getState().catch(()=>undefined)
    if(state?.activeBatch) {
      const installing=state.activeBatch.items.some(item=>['installing','verifying'].includes(item.status))
      if(installing && await this.choose()==='background')return false
      await this.queue.cancel()
      await this.queue.waitForIdle()
    }
    quit()
    return true
  }
}
