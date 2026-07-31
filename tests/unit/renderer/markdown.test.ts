import { describe, it, expect } from 'vitest'
import { marked } from 'marked'
// Registers the custom `url` tokenizer on the global marked instance.
// (renderMarkdown itself needs a DOM for DOMPurify, so tests assert on
// marked's output directly.)
import '../../../src/renderer/lib/markdown'

function parse(text: string): string {
  return marked.parse(text, { async: false }) as string
}

describe('URL autolink tokenizer', () => {
  it('stops a bare URL at a following Chinese comma', () => {
    expect(parse('看 https://example.com，好的')).toContain(
      '<a href="https://example.com">https://example.com</a>，好的'
    )
  })

  it('stops a bare URL at other CJK punctuation', () => {
    expect(parse('看 https://example.com。结束')).toContain(
      '<a href="https://example.com">https://example.com</a>。结束'
    )
    expect(parse('https://example.com（注释）')).toContain(
      '<a href="https://example.com">https://example.com</a>（注释）'
    )
    expect(parse('https://example.com、x')).toContain(
      '<a href="https://example.com">https://example.com</a>、x'
    )
  })

  it('stops a bare URL at any non-ASCII text', () => {
    expect(parse('链接https://example.com你好')).toContain(
      '<a href="https://example.com">https://example.com</a>你好'
    )
  })

  it('keeps trailing ASCII punctuation outside the link', () => {
    expect(parse('see https://example.com, ok')).toContain(
      '<a href="https://example.com">https://example.com</a>, ok'
    )
  })

  it('still autolinks plain URLs with query strings', () => {
    expect(parse('url: https://example.com/path?a=1&b=2 end')).toContain(
      'href="https://example.com/path?a=1&b=2"'
    )
  })

  it('still autolinks www. URLs', () => {
    expect(parse('visit www.example.com，ok')).toContain(
      '<a href="http://www.example.com">www.example.com</a>，ok'
    )
  })

  it('still autolinks email addresses', () => {
    expect(parse('mail me a@b.com, ok')).toContain('<a href="mailto:a@b.com">a@b.com</a>, ok')
  })
})
