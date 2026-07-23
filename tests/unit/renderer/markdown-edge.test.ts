import { describe, it, expect } from 'vitest'
import { marked } from 'marked'
import '../../../src/renderer/lib/markdown'

function parse(text: string): string {
  return marked.parse(text, { async: false }) as string
}

describe('URL tokenizer edge cases', () => {
  it('preserves URL-encoded characters', () => {
    expect(parse('https://example.com/path%20encoded，ok')).toContain(
      'href="https://example.com/path%20encoded"'
    )
  })

  it('handles localhost with port', () => {
    expect(parse('http://localhost:3000，好的')).toContain(
      'href="http://localhost:3000"'
    )
  })

  it('preserves query strings with Chinese trailing', () => {
    expect(parse('see https://example.com?foo=bar，ok')).toContain(
      'href="https://example.com?foo=bar"'
    )
  })

  it('handles multiple URLs in one line', () => {
    const result = parse('访问 https://a.com，以及 https://b.com。')
    expect(result).toContain('href="https://a.com"')
    expect(result).toContain('href="https://b.com"')
    expect(result).toContain('a.com</a>，')
    expect(result).toContain('b.com</a>。')
  })

  it('stops at Japanese punctuation', () => {
    expect(parse('https://example.com「引用」')).toContain(
      'href="https://example.com"'
    )
    expect(parse('https://example.com【注】')).toContain(
      'href="https://example.com"'
    )
  })
})
