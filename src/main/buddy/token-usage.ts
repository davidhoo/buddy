/** Only explicit, finite token counters count as reported usage. Context-window
 * `used`/`size` and cumulative session cost are deliberately excluded. */
export function normalizeTokenUsage(value: unknown): { input?: number; output?: number; cache?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const u = value as Record<string, unknown>
  const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {}
  const count = (...values: unknown[]): number | undefined => values.find(
    (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  ) as number | undefined
  return {
    input: count(u.inputTokens, u.input_tokens, u.prompt_tokens, u.inputOther, u.input),
    output: count(u.outputTokens, u.output_tokens, u.completion_tokens, u.output),
    cache: count(u.cachedReadTokens, u.cacheReadTokens, u.cache_read_input_tokens, u.cache_read_tokens,
      u.cached_input_tokens, object(u.input_tokens_details).cached_tokens,
      object(u.prompt_tokens_details).cached_tokens, object(u.cache).read)
  }
}
