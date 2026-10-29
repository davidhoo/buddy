import { afterEach, describe, expect, it, vi } from 'vitest'
import { modelMemoryKey, readModelMemory } from '../../../src/renderer/lib/agent-memory'
const launcher={command:'codex',env:{},args:[],timeout_seconds:10}
afterEach(()=>vi.unstubAllGlobals())
describe('agent model history',()=>{
 it('uses settings only without history and preserves a remembered native default',()=>{
  const data=new Map<string,string>()
  vi.stubGlobal('localStorage',{getItem:(key:string)=>data.get(key)??null})
  const settings={launchers:{codex:{...launcher,model:'default-model'}}}
  expect(readModelMemory('implementer','codex',settings)).toBe('default-model')
  data.set(modelMemoryKey('implementer','codex',settings),'__native__')
  expect(readModelMemory('implementer','codex',settings)).toBe('__native__')
  expect(readModelMemory('reviewer','codex',settings)).toBe('default-model')
 })
 it('keeps credentials out of localStorage keys and isolates protocols',()=>{
  const cli={launchers:{codex:{...launcher,env:{API_KEY:'private-value'}}}}
  const acp={launchers:{codex:{...cli.launchers.codex,protocol:'acp' as const}}}
  const key=modelMemoryKey('implementer','codex',cli)
  expect(key).not.toContain('private-value')
  expect(key).not.toBe(modelMemoryKey('implementer','codex',acp))
 })
})
