import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latestWecodeVersion, wecodeBundle } from '../../../src/main/buddy/agents/wecode-updates'
let root:string
const source='/* WeCoder CLI v4.1.3 | build */\nvar url="https://git.intra.weibo.com/api/v4/projects/test/repository/files/dist%2Fcli.js/raw", credential="test-private-token";function check(){return fetch(`${url}?ref=master`,{headers:{"PRIVATE-TOKEN":credential}})}'
afterEach(async()=>{vi.unstubAllGlobals();if(root)await rm(root,{recursive:true,force:true})})
async function fixture(){root=await mkdtemp(join(tmpdir(),'wecode-source-'));await writeFile(join(root,'wecode'),'#!/bin/bash\nnode "$SCRIPT_DIR/cli.js" "$@"');await writeFile(join(root,'cli.js'),source);return join(root,'wecode')}
it('uses the installed update endpoint and selected branch without persisting credentials',async()=>{
 const command=await fixture(),fetcher=vi.fn(async()=>new Response('/* WeCoder CLI v4.2.0 | build */'));vi.stubGlobal('fetch',fetcher)
 expect(await latestWecodeVersion(command,{WECODE_INSTALL_BRANCH:'release/test'})).toBe('4.2.0')
 expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('ref')).toBe('release/test')
 expect(fetcher.mock.calls[0][1]).toMatchObject({headers:{'PRIVATE-TOKEN':'test-private-token'},redirect:'error'})
})
it('resolves the legacy launcher and symlink to the same bundle',async()=>{
 const command=await fixture();await mkdir(join(root,'legacy/bin'),{recursive:true});await mkdir(join(root,'legacy/wecode-cli/bin'),{recursive:true})
 await symlink(join(root,'cli.js'),join(root,'legacy/wecode-cli/bin/cli.js'))
 const legacy=join(root,'legacy/bin/wecode');await writeFile(legacy,'node "$SCRIPT_DIR/../wecode-cli/bin/cli.js" "$@"')
 expect(await wecodeBundle(legacy)).toBe(await wecodeBundle(command))
})
it('does not expose request secrets on a network failure',async()=>{
 const command=await fixture();vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('test-private-token')}))
 await expect(latestWecodeVersion(command)).rejects.toThrow('Cannot reach WeCode update source')
})
it('rejects an unsupported bundle without making a request',async()=>{
 const command=await fixture();await writeFile(join(root,'cli.js'),'unknown bundle')
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher)
 await expect(latestWecodeVersion(command)).rejects.toThrow('Unrecognized WeCode bundle');expect(fetcher).not.toHaveBeenCalled()
})
it('rejects invalid remote content and HTTP failures',async()=>{
 const command=await fixture();vi.stubGlobal('fetch',vi.fn(async()=>new Response('not a version')))
 await expect(latestWecodeVersion(command)).rejects.toThrow('Invalid WeCode update version')
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:403})))
 await expect(latestWecodeVersion(command)).rejects.toThrow('returned 403')
})
