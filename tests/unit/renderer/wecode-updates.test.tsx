// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentsSettings } from '../../../src/renderer/components/settings/AgentsSettings'
import type { LocalAgent, AgentUpdateSnapshot } from '../../../src/shared/agents'

vi.mock('../../../src/renderer/hooks/useI18n',()=>({useT:()=> (key:string,params?:Record<string,unknown>)=>key==='agents.updateWecode'?`更新 WeCode 至 ${params?.version}`:key}))
const state=vi.hoisted(()=>({agents:[] as LocalAgent[],updates:{schemaVersion:2,revision:0} as AgentUpdateSnapshot,start:vi.fn(async()=>{})}))
vi.mock('../../../src/renderer/hooks/useAgentUpdates',()=>({
  useAgentInventory:()=>({data:{agents:state.agents}}),useAgentUpdateState:()=>({data:state.updates}),
  startAgentUpdates:(...args:unknown[])=>state.start(...args),agentInventoryKey:['agentInventory'],acceptAgentSnapshot:vi.fn()
}))
afterEach(cleanup)
function setup(){
  state.start.mockClear()
  state.updates={schemaVersion:2,revision:0}
  state.agents=['claude','codex','opencode'].map((name)=>({id:'wecode_'+name,name:'WeCode '+name,installationId:name,path:'/bin/wecode',realPath:'/bin/wecode',version:name==='claude'?'2.1.1':'0.1.0',latest:'4.2.0',source:'unknown',runnable:true,enabled:true,cli:{command:'/bin/wecode',args:name==='claude'?[]:[name],env:{},timeout_seconds:10},nativeUpdate:{command:'/bin/wecode',args:['upgrade','--cli-only'],versionArgs:['version'],version:'4.1.3',target:'wecode',sharedKey:'/bin/cli.js:master'}}))
  const cache=new QueryClient({defaultOptions:{queries:{retry:false}}})
  return {cache,render:()=> <QueryClientProvider client={cache}><AgentsSettings/></QueryClientProvider>}
}
it('shows a versioned WeCode update on all three rows and submits only one update-all target',async()=>{
  const fixture=setup();render(fixture.render())
  expect(screen.getAllByText('更新 WeCode 至 4.2.0')).toHaveLength(3)
  fireEvent.click(screen.getByText('agents.updateAll'))
  await waitFor(()=>expect(state.start).toHaveBeenCalledOnce())
  expect(state.start.mock.calls[0][1]).toEqual(['wecode_opencode'])
})
it('shares the active status across all rows even when OpenCode initiated it',()=>{
  const fixture=setup();const view=render(fixture.render())
  state.updates.activeBatch={id:'batch',requestId:'request',status:'running',cancelRequested:false,items:[{id:'job',agentId:'wecode_opencode',name:'WeCode',target:'wecode',updateKey:'wecode:/bin/cli.js:master',status:'installing'}]}
  view.rerender(fixture.render())
  for(const row of screen.getAllByRole('listitem').filter(el=>el.hasAttribute('data-agent-id')))expect(within(row).getByRole('status')).toHaveTextContent('agents.job.installing')
  expect(screen.queryByText('更新 WeCode 至 4.2.0')).not.toBeInTheDocument()
})
it('compares the latest version to WeCode rather than the inner Agent version',()=>{
  const fixture=setup();state.agents=state.agents.map(a=>({...a,latest:'4.1.3'}));render(fixture.render())
  expect(screen.queryByText('更新 WeCode 至 4.1.3')).not.toBeInTheDocument()
  expect(screen.getByText('agents.updateAll')).toBeDisabled()
})
