import type { GlobalSettings } from '../../shared/types'
export function modelMemoryKey(role:string,actor:string,settings:GlobalSettings):string {
 const launcher=settings.launchers?.[actor]
 const context=JSON.stringify([launcher?.command,launcher?.args,Object.fromEntries(Object.entries(launcher?.env || {}).sort(([a],[b])=>a.localeCompare(b)))])
 let hash=14695981039346656037n
 for(const c of context)hash=BigInt.asUintN(64,(hash^BigInt(c.charCodeAt(0)))*1099511628211n)
 return 'buddy.model.v1.'+JSON.stringify([role,actor,launcher?.protocol||'cli',hash.toString(16)])
}
export function readModelMemory(role:string,actor:string,settings:GlobalSettings):string {
 try {
  const value=localStorage.getItem(modelMemoryKey(role,actor,settings))
  if(value!==null)return value
  const oldActor=localStorage.getItem(role==='implementer'?'buddy.lastImplementer':'buddy.lastReviewer')
  return (oldActor===actor ? localStorage.getItem(role==='implementer'?'buddy.lastImplementerModel':'buddy.lastReviewerModel') : '') || settings.launchers?.[actor]?.model || '__native__'
 }catch{return ''}
}
