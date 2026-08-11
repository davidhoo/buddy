import { describe, expect, it, vi } from 'vitest'
import { openPathOrThrow } from '../../../src/main/ipc/open-path'

describe('openPathOrThrow', () => {
  it('throws when Electron returns an openPath error string', async () => {
    const openPath = vi.fn().mockResolvedValue('The file does not exist')

    await expect(openPathOrThrow(openPath, '/missing')).rejects.toThrow(
      'The file does not exist'
    )
  })

  it('resolves when Electron returns an empty error string', async () => {
    const openPath = vi.fn().mockResolvedValue('')

    await expect(openPathOrThrow(openPath, '/existing')).resolves.toBeUndefined()
  })
})
