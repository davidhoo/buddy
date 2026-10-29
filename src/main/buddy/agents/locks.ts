// Shared by all runners and the update queue in the main process.
let readers=0, writer=false
const waiting:Array<()=>void>=[]
export async function acquireAgentUse():Promise<()=>void> {
  while(writer) await new Promise<void>(resolve=>waiting.push(resolve))
  readers++
  let released=false
  return ()=>{if(!released){released=true;readers--}}
}
export function acquireAgentUpdate(): (()=>void)|undefined {
  if(writer||readers) return undefined
  writer=true
  return ()=>{writer=false;for(const wake of waiting.splice(0))wake()}
}
