// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { RunningDetailPanel } from '../../../src/renderer/components/RunningStatusMessage'
import { useActorStream } from '../../../src/renderer/hooks/useBuddy'
import { parseCursorStreamLine } from '../../../src/main/buddy/parsers'
import type { TaskEventEnvelope } from '../../../src/shared/types'

const listeners = new Set<(envelope: TaskEventEnvelope) => void>()

vi.mock('../../../src/renderer/lib/api', () => ({
  api: {
    onTaskEvent: (callback: (envelope: TaskEventEnvelope) => void) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    }
  }
}))

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useT: () => (key: string) => key,
  useLanguage: () => 'zh-CN'
}))

function emitStdout(text: string, stream: 'delta' | 'line', ts = '2026-09-08T06:00:00.000Z') {
  const envelope: TaskEventEnvelope = {
    workspace_key: 'ws',
    task_id: 'demo',
    event: {
      seq: 0,
      type: 'actor.stdout',
      actor: 'cursor',
      ts,
      run_id: 'run-1',
      payload: { text, stream }
    }
  }
  for (const listener of listeners) listener(envelope)
}

function StreamHarness() {
  const lines = useActorStream('demo', 'run-1')
  return (
    <div data-testid="stream-harness">
      <RunningDetailPanel actor="cursor" streamLines={lines} />
    </div>
  )
}

function projectRunningDetailCss(): string {
  const globalsPath = join(process.cwd(), 'src/renderer/styles/globals.css')
  const raw = readFileSync(globalsPath, 'utf8')
  const withoutTailwind = raw
    .split('\n')
    .filter((line) => !line.startsWith('@tailwind'))
    .join('\n')
  // Theme tokens used by running-detail-* rules (from default theme derivation).
  const tokens = `
:root {
  --bg: #f7f5f0;
  --bg-elevated: #ffffff;
  --bg-subtle: #f0eee8;
  --fg: #1f1f1f;
  --fg-secondary: #4a4a4a;
  --fg-muted: #8a8a8a;
  --border: #d7d2c8;
  --actor-cursor: #4f8f5f;
}
`
  return `${tokens}\n${withoutTailwind}`
}

function installProjectCss() {
  const style = document.createElement('style')
  style.setAttribute('data-testid', 'project-css')
  style.textContent = projectRunningDetailCss()
  document.head.appendChild(style)
}

function mockAutoScroll(el: HTMLElement): () => number {
  let scrollTop = 0
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 80 })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 900 })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value
    }
  })
  return () => scrollTop
}

describe('useActorStream + RunningDetailPanel live path', () => {
  beforeEach(() => {
    listeners.clear()
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    installProjectCss()
  })

  afterEach(() => {
    cleanup()
    listeners.clear()
  })

  it('subscribes to buddy events, coalesces deltas, keeps tool rows, and auto-scrolls', async () => {
    render(<StreamHarness />)

    await waitFor(() => {
      expect(screen.getByText('running.streamingWaiting')).toBeInTheDocument()
    })

    const content = document.querySelector('.running-detail-content') as HTMLElement
    expect(content).toBeTruthy()
    const readScrollTop = mockAutoScroll(content)

    await act(async () => {
      emitStdout('哈', 'delta', 't1')
      emitStdout('哈', 'delta', 't2')
      emitStdout('\n下一行 有空格', 'delta', 't3')
    })

    await waitFor(() => {
      const lines = document.querySelectorAll('.running-detail-line')
      expect(lines).toHaveLength(1)
      expect(lines[0]?.textContent).toBe('哈哈\n下一行 有空格')
    })

    await act(async () => {
      const tool = parseCursorStreamLine(JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        tool_call: { readToolCall: { args: { path: 'src/a.ts' } } }
      }))
      emitStdout(tool.text!, 'line', 't4')
      emitStdout('后文继续', 'delta', 't5')
      // Final flush duplicate would be filtered by parser; if a line-mode full copy
      // were wrongly emitted it would create an extra row — assert it does not.
      emitStdout('⏳ reconnecting', 'line', 't6')
    })

    await waitFor(() => {
      const lines = [...document.querySelectorAll('.running-detail-line')].map((node) => node.textContent)
      expect(lines).toEqual([
        '哈哈\n下一行 有空格',
        '🔧 read src/a.ts (started)',
        '后文继续',
        '⏳ reconnecting'
      ])
      expect(lines.join('\n').match(/哈哈/g)?.length).toBe(1)
    })

    expect(readScrollTop()).toBe(900)

    // Long text: more deltas should keep sticking to the bottom.
    await act(async () => {
      for (let i = 0; i < 20; i++) {
        emitStdout(`\n段落${i}`, 'delta', `long-${i}`)
      }
    })

    await waitFor(() => {
      expect(readScrollTop()).toBe(900)
      const lines = document.querySelectorAll('.running-detail-line')
      expect(lines.length).toBeGreaterThanOrEqual(5)
      expect(lines[lines.length - 1]?.textContent ?? '').toContain('段落19')
    })

    // Persist the actual mounted component markup + project CSS for screenshot QA.
    const outDir = join(process.cwd(), 'scripts/out')
    mkdirSync(outDir, { recursive: true })
    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Buddy RunningDetailPanel live stream QA</title>
<style>${projectRunningDetailCss()}
body { margin: 0; padding: 24px; background: var(--bg); }
.stream-harness { max-width: 720px; margin: 0 auto; }
.running-detail-panel { max-height: 280px; }
.running-detail-content { max-height: 240px; }
</style>
</head>
<body>
${document.querySelector('[data-testid="stream-harness"]')?.outerHTML ?? ''}
</body>
</html>`
    writeFileSync(join(outDir, 'cursor-stream-component-qa.html'), html)
  })
})
