import { describe, expect, it } from 'vitest'
import { extractActorOutput, parseAgyStreamLine, parseActorEvents } from '../../../src/main/buddy/parsers'

const SAMPLE = [
  JSON.stringify({
    event: 'init',
    conversation_id: 'agy-conv-1',
    init: { cwd: '/tmp', tools: ['list_dir'], permission_mode: 'always-proceed' }
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'agy-conv-1',
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'list_dir',
      tool_info: { name: 'list_dir', parameters: { DirectoryPath: '/tmp' } }
    }
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'agy-conv-1',
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'hello '
    }
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'agy-conv-1',
      step_index: 2,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'agy'
    }
  }),
  JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'agy-conv-1',
      status: 'SUCCESS',
      response: 'hello agy\n',
      duration_seconds: 1.5,
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_tokens: 50
      }
    }
  })
].join('\n')

describe('agy stream parser', () => {
  it('extracts conversation id, tool lines, and deltas', () => {
    const lines = parseActorEvents('agy', SAMPLE)
    expect(lines[0]).toMatchObject({ sessionId: 'agy-conv-1', noise: true, rawType: 'init' })
    expect(lines[1].text).toContain('list_dir')
    expect(lines[1].text).toContain('/tmp')
    expect(lines[2]).toMatchObject({ text: 'hello ', streamMode: 'delta' })
    expect(lines[4]).toMatchObject({ sessionId: 'agy-conv-1', rawType: 'result', noise: false })
  })

  it('extracts final reply only from SUCCESS result.response', () => {
    expect(extractActorOutput('agy', SAMPLE)).toBe('hello agy')
  })

  it('marks ERROR results as error lines without promoting empty SUCCESS', () => {
    const line = parseAgyStreamLine(JSON.stringify({
      event: 'result',
      result: { conversation_id: 'x', status: 'ERROR', response: '', error: 'boom' }
    }))
    expect(line).toMatchObject({ rawType: 'error', text: 'boom' })
    expect(extractActorOutput('agy', JSON.stringify({
      event: 'result',
      result: { status: 'ERROR', response: '', error: 'boom' }
    }))).toBe('')
  })

  it('extracts detail for agy native tools (view_file AbsolutePath, run_command CommandLine)', () => {
    const viewFileLine = parseAgyStreamLine(JSON.stringify({
      event: 'step_update',
      step_update: {
        step_type: 'tool',
        tool_name: 'view_file',
        tool_info: {
          parameters: {
            AbsolutePath: '/Users/test/Code/index.ts',
            toolAction: 'Viewing file',
            toolSummary: 'File view'
          }
        }
      }
    }))
    expect(viewFileLine.text).toBe('🔧 view_file /Users/test/Code/index.ts')

    const runCommandLine = parseAgyStreamLine(JSON.stringify({
      event: 'step_update',
      step_update: {
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          parameters: {
            Cwd: '/Users/test/Code',
            CommandLine: 'pnpm test',
            toolAction: 'Running tests'
          }
        }
      }
    }))
    expect(runCommandLine.text).toBe('🔧 run_command pnpm test')
  })
})
