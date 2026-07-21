/**
 * Output-savings signals — Squeezr's honest, no-counterfactual take on headroom's output
 * measurement. The fully honest number (headroom's holdout A/B) needs a control arm; that
 * is deferred. This ships the tier that needs NO counterfactual: the ECHO RATIO — how much
 * of what the model just wrote merely restated context it was already given.
 *
 * High echo = wasted output tokens = exactly what verbosity steering (1.83) targets. Reading
 * the response to measure this never changes the bytes we forward, so it's cache-safe.
 */

/** Word n-grams (set) of a text. */
export function wordNgrams(text: string, n = 3): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9_]+/g) ?? []
  const set = new Set<string>()
  for (let i = 0; i + n <= words.length; i++) set.add(words.slice(i, i + n).join(' '))
  return set
}

/**
 * Fraction of the OUTPUT's n-grams that also appear in the CONTEXT (0..1). 1 = the model
 * only restated what it was already shown; 0 = fully novel output.
 */
export function echoRatio(output: string, context: string, n = 3): number {
  const out = wordNgrams(output, n)
  if (out.size === 0) return 0
  const ctx = wordNgrams(context, n)
  let echoed = 0
  for (const g of out) if (ctx.has(g)) echoed++
  return echoed / out.size
}

/** Pull the assistant's text out of an Anthropic SSE stream (concatenated text_delta). */
export function extractAssistantTextFromSse(sse: string): string {
  let out = ''
  for (const m of sse.matchAll(/"type":"text_delta","text":"((?:[^"\\]|\\.)*)"/g)) {
    try { out += JSON.parse(`"${m[1]}"`) } catch { /* skip malformed delta */ }
  }
  return out
}

/** Assistant text from a non-streaming Anthropic response body's content blocks. */
export function extractAssistantTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>)
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('')
}
