import { describe, it, expect } from 'vitest'
import { decodeUnicodeEscapes, decodeErrorText } from '../../src/renderer/lib/format'

describe('decodeUnicodeEscapes', () => {
  it('decodes \\uXXXX sequences to Unicode characters', () => {
    expect(decodeUnicodeEscapes('\\u7f51\\u7edc\\u9519\\u8bef')).toBe('网络错误')
  })

  it('leaves plain text unchanged', () => {
    expect(decodeUnicodeEscapes('hello world')).toBe('hello world')
  })

  it('handles mixed text and escapes', () => {
    expect(decodeUnicodeEscapes('Error: \\u8fde\\u63a5\\u8d85\\u65f6')).toBe('Error: 连接超时')
  })

  it('decodes uppercase hex digits', () => {
    expect(decodeUnicodeEscapes('\\u7F51\\u7EDC')).toBe('网络')
  })
})

describe('decodeErrorText', () => {
  it('decodes plain Unicode escapes in non-JSON text', () => {
    expect(decodeErrorText('Error: \\u7f51\\u7edc\\u9519\\u8bef')).toBe('Error: 网络错误')
  })

  it('leaves plain text unchanged', () => {
    expect(decodeErrorText('Process started successfully')).toBe('Process started successfully')
  })

  it('preserves JSON structure with decoded Chinese', () => {
    const result = decodeErrorText('{"error":"\\u8fde\\u63a5\\u8d85\\u65f6"}')
    expect(result).toContain('error')
    expect(result).toContain('连接超时')
    expect(result).not.toContain('\\u8fde')
    expect(result).not.toContain('\\"')
  })

  it('preserves nested JSON structure', () => {
    const result = decodeErrorText('{"error":{"message":"something failed","type":"api_error"}}')
    expect(result).toContain('error:')
    expect(result).toContain('message:')
    expect(result).toContain('something failed')
    expect(result).toContain('type:')
    expect(result).toContain('api_error')
    expect(result).not.toContain('\\"')
  })

  it('shows prefix before JSON structure', () => {
    const result = decodeErrorText('API Error: 400 {"error":{"message":"bad request","type":"invalid_request_error"}}')
    expect(result).toContain('API Error: 400')
    expect(result).toContain('error:')
    expect(result).toContain('message:')
    expect(result).toContain('bad request')
    expect(result).not.toContain('\\"')
  })

  it('handles double-escaped Unicode in JSON string values', () => {
    const input = '{"error":{"message":"[1234][\\\\u7f51\\\\u7edc\\\\u9519\\\\u8bef]"}}'
    const result = decodeErrorText(input)
    expect(result).toContain('网络错误')
    expect(result).not.toContain('\\u7f51')
    expect(result).not.toContain('\\"')
  })

  it('handles the real-world nested error from the issue', () => {
    const innerMsg = '[1234][\\\\u7f51\\\\u7edc\\\\u9519\\\\u8bef\\\\uff0c\\\\u9519\\\\u8befid\\\\uff1a2026052515541851ddf7e87af44240\\\\uff0c\\\\u8bf7\\\\u7a0d\\\\u540e\\\\u91cd\\\\u8bd5][2026052515541851ddf7e87af44240]'
    const input = `API Error: 400 {"error":{"message":" {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"api_error\\",\\"code\\":\\"1234\\",\\"message\\":\\"${innerMsg}\\"},\\"request_id\\":\\"2026052515541851ddf7e87af44240\\"}, model_id: thudm-glm-5.1","type":"invalid_request_error"},"type":"error"}`
    const result = decodeErrorText(input)
    // JSON structure preserved
    expect(result).toContain('error:')
    expect(result).toContain('type:')
    expect(result).toContain('api_error')
    // Chinese decoded
    expect(result).toContain('网络错误')
    expect(result).toContain('请稍后重试')
    // No escape characters
    expect(result).not.toContain('\\u7f51')
    expect(result).not.toContain('\\"')
  })

  it('does not produce stray backslashes before decoded characters', () => {
    const input = '{"error":{"message":"[\\\\u7f51\\\\u7edc]"}}'
    const result = decodeErrorText(input)
    expect(result).not.toContain('\\网')
    expect(result).not.toContain('\\络')
  })

  it('unwraps nested JSON strings within message values', () => {
    const input = '{"error":{"message":" {\\"error\\":\\"fail\\"}"}}'
    const result = decodeErrorText(input)
    expect(result).toContain('error:')
    expect(result).toContain('fail')
    expect(result).not.toContain('\\"')
  })

  it('no \\" escape sequences remain in output for non-JSON fallback', () => {
    const input = 'Error: he said \\"hello\\" and \\u7f51\\u7edc'
    const result = decodeErrorText(input)
    expect(result).not.toContain('\\"')
    expect(result).toContain('"hello"')
    expect(result).toContain('网络')
  })

  it('decodes \\\\n and other JSON string escapes in fallback text', () => {
    const input = 'Line1\\nLine2\\tTabbed'
    const result = decodeErrorText(input)
    expect(result).toBe('Line1\nLine2\tTabbed')
  })

  it('preserves JSON keys when no error message structure exists', () => {
    const result = decodeErrorText('{"status":"ok","count":5}')
    expect(result).toContain('status')
    expect(result).toContain('ok')
    expect(result).toContain('count')
    expect(result).not.toContain('\\"')
  })

  it('prefix before JSON is also unescaped', () => {
    const input = 'API Error: \\"bad\\" {"status":"error"}'
    const result = decodeErrorText(input)
    expect(result).toContain('"bad"')
    expect(result).not.toContain('\\"bad\\"')
  })
})
