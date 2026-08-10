const PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /token=[A-Za-z0-9_-]+/gi,
  /cookie=[^\s;]+/gi,
  /Bearer\s+[A-Za-z0-9_-]{20,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
]

export function redactSensitiveText(input: string): string {
  return PATTERNS.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), input)
}

export function redactJsonValue<T>(value: T): T {
  return JSON.parse(redactSensitiveText(JSON.stringify(value))) as T
}
