import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseAgyModels } from '../../../src/main/buddy/agents/models'
import { AgentManagementService } from '../../../src/main/buddy/agents/service'
import { BuddyStore } from '../../../src/main/buddy/store'

const output = `Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`

describe('Antigravity native model catalog', () => {
  it('extracts real IDs and display names, excluding progress and duplicate rows', () => {
    const models = parseAgyModels('\u001b[32m' + output + '\u001b[0m\ngemini-3.8-flash-high\tDuplicate\n')
    expect(models).toHaveLength(6)
    expect(models[0]).toEqual({id:'gemini-3.8-flash-high',name:'Gemini 3.8 Flash (High)'})
    expect(models[5]).toEqual({id:'gpt-oss-120b-medium',name:'GPT-OSS 120B (Medium)'})
    expect(parseAgyModels('Fetching available models...\nID\tName\n')).toEqual([])
  })

  it('queries the selected CLI with its arguments/environment without repeating discovery', async () => {
    const root=await mkdtemp(join(tmpdir(),'buddy-agy-models-'))
    try {
      const bin=join(root,'bin')
      await mkdir(bin)
      await writeFile(join(bin,'agy'),'#!/bin/sh\necho 1.4.9\n',{mode:0o755})
      const store=new BuddyStore(join(root,'data'))
      const cli={command:join(bin,'agy'),args:['--project','example'],env:{AGY_TEST_ENV:'fixture'},timeout_seconds:20}
      await store.updateGlobalSettings({launchers:{agy:cli}})
      const run=vi.fn(async (_command:string,args:string[]) => args.includes('models') ? output : '1.4.9')
      const service=new AgentManagementService(store,{dirs:[bin],appRoots:[],recipes:[{id:'agy',name:'Antigravity CLI',command:'agy'}],run})
      await service.list()
      run.mockClear()
      vi.spyOn(service,'list').mockRejectedValue(new Error('Model queries must not rescan'))
      const list=await service.models('agy')
      expect(list.models).toHaveLength(6)
      expect(run).toHaveBeenCalledExactlyOnceWith(cli.command,['--project','example','models'],30000,cli.env)
    }finally{await rm(root,{recursive:true,force:true})}
  })
})
