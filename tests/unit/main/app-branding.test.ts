import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('app branding', () => {
  it('uses Buddy as the packaged product name and document title', async () => {
    await expect(readFile('electron-builder.yml', 'utf8')).resolves.toContain('productName: Buddy')
    await expect(readFile('src/renderer/index.html', 'utf8')).resolves.toContain('<title>Buddy</title>')
    await expect(readFile('src/main/index.ts', 'utf8')).resolves.toContain("app.setName('Buddy')")
  })
})
