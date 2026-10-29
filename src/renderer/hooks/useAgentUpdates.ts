import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { AgentInventorySnapshot, AgentUpdateBatch, AgentUpdateSnapshot } from '../../shared/agents'

export const agentInventoryKey = ['agentInventory'] as const
export const agentUpdatesKey = ['agentUpdates'] as const
const cacheOptions = { staleTime: Infinity, gcTime: Infinity, refetchOnMount: false, refetchOnWindowFocus: false, retry: false } as const
export function acceptAgentSnapshot<T extends {revision:number}>(cache:QueryClient,key:readonly string[],next:T) {
  cache.setQueryData<T>(key,current=>!current || next.revision>=current.revision?next:current)
}
export function useAgentInventory() {
  const cache=useQueryClient()
  return useQuery({queryKey:agentInventoryKey,...cacheOptions,enabled:!!window.buddy?.listLocalAgents,queryFn:async()=>{
    const next:AgentInventorySnapshot=window.buddy.getAgentInventory?await window.buddy.getAgentInventory():{revision:0,agents:await window.buddy.listLocalAgents(),refreshing:false}
    const current=cache.getQueryData<AgentInventorySnapshot>(agentInventoryKey)
    return current && current.revision>next.revision?current:next
  }})
}
export function useAgentUpdateState() {
  const cache=useQueryClient()
  return useQuery({queryKey:agentUpdatesKey,...cacheOptions,queryFn:async()=>{
    const next:AgentUpdateSnapshot=window.buddy.getAgentUpdateState?await window.buddy.getAgentUpdateState():{schemaVersion:2,revision:0}
    const current=cache.getQueryData<AgentUpdateSnapshot>(agentUpdatesKey)
    return current && current.revision>next.revision?current:next
  }})
}
export function useAgentUpdatesController(open:()=>void) {
  const cache=useQueryClient()
  useAgentInventory()
  const updates=useAgentUpdateState()
  const [notice,setNotice]=useState<AgentUpdateBatch>()
  const observed=useRef(new Set<string>())
  const openRef=useRef(open);openRef.current=open
  const receiveRef=useRef((state:AgentUpdateSnapshot)=>{})
  receiveRef.current=state=>{
    const current=cache.getQueryData<AgentUpdateSnapshot>(agentUpdatesKey)
    if(current && state.revision<current.revision)return
    acceptAgentSnapshot(cache,agentUpdatesKey,state)
    if(state.activeBatch)observed.current.add(state.activeBatch.id)
    const batch=state.lastCompletedBatch
    if(batch && observed.current.delete(batch.id) && document.visibilityState==='visible' && document.hasFocus())setNotice(batch)
  }
  useEffect(()=>{
    // Subscribe before requesting snapshots; revision protects against in-flight old reads.
    const inventory=window.buddy?.onAgentInventory?.(state=>acceptAgentSnapshot(cache,agentInventoryKey,state))
    const update=window.buddy?.onAgentUpdate?.(state=>receiveRef.current(state))
    const navigate=window.buddy?.onOpenAgentUpdates?.(()=>openRef.current())
    void window.buddy?.getAgentInventory?.().then(state=>acceptAgentSnapshot(cache,agentInventoryKey,state)).catch(()=>{})
    void window.buddy?.getAgentUpdateState?.().then(state=>receiveRef.current(state)).catch(()=>{})
    return ()=>{inventory?.();update?.();navigate?.()}
  },[cache])
  useEffect(()=>{
    if(!updates.data?.activeBatch)return
    observed.current.add(updates.data.activeBatch.id)
    setNotice(undefined)
    const timer=setInterval(()=>{
      void window.buddy.getAgentUpdateState?.().then(state=>receiveRef.current(state)).catch(()=>{})
      void window.buddy.getAgentInventory?.().then(state=>acceptAgentSnapshot(cache,agentInventoryKey,state)).catch(()=>{})
    },2000)
    return ()=>clearInterval(timer)
  },[updates.data?.activeBatch?.id,cache])
  return {...updates,notice,dismiss:()=>setNotice(undefined)}
}
export async function startAgentUpdates(cache:QueryClient,ids:string[]) {
  if(window.buddy.startAgentUpdates) {
    const state=await window.buddy.startAgentUpdates(ids,crypto.randomUUID())
    acceptAgentSnapshot(cache,agentUpdatesKey,state)
  } else {
    await window.buddy.updateLocalAgents(ids)
    await cache.invalidateQueries({queryKey:agentInventoryKey})
  }
}
