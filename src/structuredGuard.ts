/**
 * Structured-data guard.
 *
 * AI compression (Zest/Haiku) summarises prose well, but on STRUCTURED data
 * (JSON arrays/objects, JSONL, record/field dumps, tabular output) it can
 * silently alter field values — e.g. blanking a `date` field to '' while a
 * count computed elsewhere still reports it as non-empty. That produces a
 * self-contradicting view of the data and is a fidelity bug.
 *
 * The fix: detect structured output and EXCLUDE it from AI compression. Such
 * blocks keep their deterministic-only form (lossless-ish, pattern-based) and
 * remain fully recoverable via `squeezr_expand`. Prose still gets AI-compressed.
 *
 * Heuristics (any one is enough — biased towards NOT corrupting data):
 *   1. Parses as a JSON object/array.
 *   2. JSONL — several lines each parsing as a JSON object/array.
 *   3. Repeated `"field":` / `field:` key-value structure across many lines
 *      (record dumps, Python dict reprs, pretty-printed objects).
 *   4. Tabular — many lines sharing a consistent column delimiter.
 */

/** Try to parse trimmed text as a JSON object or array (not a bare scalar). */
function isJsonContainer(text: string): boolean {
  const t = text.trim()
  if (t.length < 2) return false
  const first = t[0]
  const last = t[t.length - 1]
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) return false
  try {
    const v = JSON.parse(t)
    return typeof v === 'object' && v !== null
  } catch {
    return false
  }
}

/** JSONL: at least `min` non-blank lines and a strong majority parse as JSON objects/arrays. */
function isJsonLines(lines: string[], min = 3): boolean {
  const nonBlank = lines.map(l => l.trim()).filter(Boolean)
  if (nonBlank.length < min) return false
  let ok = 0
  for (const l of nonBlank) {
    const c = l[0]
    if ((c === '{' || c === '[')) {
      try { JSON.parse(l); ok++ } catch { /* not json */ }
    }
  }
  return ok >= min && ok / nonBlank.length >= 0.7
}

/** Count lines that look like `key: value` or `"key": value` (record/dict dumps). */
function keyValueLineRatio(lines: string[]): { ratio: number; count: number } {
  const nonBlank = lines.map(l => l.trim()).filter(Boolean)
  if (nonBlank.length === 0) return { ratio: 0, count: 0 }
  // "key": ...  | 'key': ...  | key: ...   (key is an identifier-ish token)
  const re = /^["']?[\w.\-$ ]{1,60}["']?\s*[:=]\s*.+,?$/
  let count = 0
  for (const l of nonBlank) if (re.test(l)) count++
  return { ratio: count / nonBlank.length, count }
}

/** Tabular: many lines share the same separator with a consistent column count. */
function isTabular(lines: string[], min = 4): boolean {
  const nonBlank = lines.map(l => l.trim()).filter(Boolean)
  if (nonBlank.length < min) return false
  for (const sep of ['\t', '|', ',']) {
    const cols = nonBlank
      .filter(l => l.includes(sep))
      .map(l => l.split(sep).length)
    if (cols.length < min) continue
    // mode column count
    const freq = new Map<number, number>()
    for (const n of cols) freq.set(n, (freq.get(n) ?? 0) + 1)
    let best = 0, bestN = 0
    for (const [n, f] of freq) if (n >= 2 && f > best) { best = f; bestN = n }
    if (bestN >= 2 && best >= min && best / nonBlank.length >= 0.6) return true
  }
  return false
}

/**
 * Returns true when `text` looks like structured data that AI compression
 * could corrupt. Pure + synchronous → trivially unit-testable.
 */
export function looksStructured(text: string): boolean {
  if (!text) return false
  // Whole-block JSON is the clearest signal.
  if (isJsonContainer(text)) return true

  const lines = text.split('\n')
  if (isJsonLines(lines)) return true

  // Record/dict dumps: many key-value lines AND enough of them to be a data dump
  // (not just a couple of "foo: bar" sentences inside prose).
  const kv = keyValueLineRatio(lines)
  if (kv.count >= 6 && kv.ratio >= 0.6) return true

  if (isTabular(lines)) return true

  return false
}
