import { describe, expect, it } from 'vitest'
import { parseCursorModelList } from '../../../src/main/buddy/cursor-models'

describe('Cursor model discovery', () => {
  it('parses plain and ANSI-colored Cursor CLI model lists', () => {
    const models = parseCursorModelList([
      '\u001b[36mauto\u001b[39m \u001b[2m- Auto (default)\u001b[22m',
      'composer-2.5 - Composer 2.5',
      'gpt-5.6-sol-high-fast - GPT-5.6 Sol High Fast (current)'
    ].join('\n'))

    expect(models).toEqual([
      { id: 'auto', displayName: 'Auto' },
      { id: 'composer-2.5', displayName: 'Composer 2.5' },
      { id: 'gpt-5.6-sol-high-fast', displayName: 'GPT-5.6 Sol High Fast' }
    ])
  })

  it('ignores headings and duplicate model IDs', () => {
    expect(parseCursorModelList([
      'Available models:',
      'composer-2.5 - Composer 2.5',
      'composer-2.5 - Duplicate'
    ].join('\n'))).toEqual([
      { id: 'composer-2.5', displayName: 'Composer 2.5' }
    ])
  })
})
