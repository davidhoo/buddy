import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('window manager source', () => {
  it('does not proxy renderer requests to the Python HTTP server', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/window-manager.ts'), 'utf8')

    expect(source).not.toContain('127.0.0.1:8765')
    expect(source).not.toContain('onBeforeRequest')
    expect(source).not.toContain('file:///api/*')
  })
})
