/**
 * Compression quality guardrail.
 *
 * AI compression (Zest/Haiku) can drop information. This validator runs on every
 * AI-produced result BEFORE it is accepted/cached. A rejected result is discarded
 * and the block keeps its deterministic-only form (still a real, safe saving).
 *
 * Two checks:
 *   1. Min-ratio   — must save at least `minRatio` of the original (kills the
 *      silently-accepted negative-savings case where the model returned MORE text).
 *   2. Key-token preservation — every "important" token in the original (file
 *      paths, URLs, error/status codes, rare numbers/identifiers/quoted literals)
 *      must survive into the compressed output. Losing one of the HARD set
 *      (paths/URLs/error codes) is an automatic reject; the SOFT set tolerates a
 *      small fraction of drops (summaries legitimately drop some incidental tokens).
 */

export interface GuardResult {
  accept: boolean
  ratio: number          // 1 - compressed/original (can be negative)
  reason?: string        // why it was rejected (for logging)
  lostHard?: string[]    // hard tokens (paths/URLs/codes) dropped — used for retry-with-correction
}

export interface GuardOptions {
  minRatio?: number      // default 0.15
  softTolerance?: number // fraction of soft tokens allowed to vanish (default 0.10)
}

// ── Token extractors ──────────────────────────────────────────────────────────
// HARD: losing any of these is a hard reject — they carry irreplaceable meaning.
const RE_PATH = /(?:[A-Za-z]:)?[\\/][\w.\-\\/]*\w\.\w+/g
const RE_FILE = /\b[\w\-]+\.(?:ts|tsx|js|jsx|py|json|md|go|rs|java|rb|c|cpp|h|yml|yaml|toml|sql|sh|html|css)\b/g
const RE_URL = /https?:\/\/[^\s"'<>)\]]+/g
const RE_ERRCODE = /\b(?:E[A-Z]{2,}|HTTP\s?\d{3}|exit code \d+|errno\s?\d+|status\s?[45]\d{2})\b/g

// SOFT: usually meaningful but a summary may legitimately drop a few.
const RE_DOTTED = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g          // a.b.c identifiers
// Only CODE-like identifiers (camelCase, snake_case, ALLCAPS≥3, or digit-bearing) —
// NOT plain English prose words, which a summary legitimately rephrases/drops.
const RE_IDENT = /\b(?:[A-Za-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+|[A-Za-z]*\d[A-Za-z0-9]*|[A-Z]{3,})\b/g
const RE_QUOTED = /["'`]([^"'`\n]{4,})["'`]/g                              // quoted literals len>=4
const RE_NUM = /-?\b\d[\d.,]*\b/g                                          // numbers

function matchSet(text: string, re: RegExp): string[] {
  return text.match(re) ?? []
}

/** Tokens that appear at most `maxFreq` times — rare = significant. Frequent tokens
 *  (e.g. a number repeated 50×) are noise and excluded to avoid false rejects. */
function rareTokens(text: string, re: RegExp, maxFreq: number): Set<string> {
  const counts = new Map<string, number>()
  for (const m of matchSet(text, re)) counts.set(m, (counts.get(m) ?? 0) + 1)
  const out = new Set<string>()
  for (const [tok, n] of counts) if (n <= maxFreq) out.add(tok)
  return out
}

function missing(tokens: Iterable<string>, haystack: string): string[] {
  const lost: string[] = []
  for (const t of tokens) if (!haystack.includes(t)) lost.push(t)
  return lost
}

/**
 * Validate an AI compression result against its original.
 * Pure + synchronous so it's trivially unit-testable.
 */
export function validateCompression(original: string, compressed: string, opts: GuardOptions = {}): GuardResult {
  const minRatio = opts.minRatio ?? 0.15
  const softTolerance = opts.softTolerance ?? 0.10
  const origLen = original.length
  const ratio = origLen > 0 ? 1 - compressed.length / origLen : 0

  // Empty / whitespace-only output is never acceptable.
  if (compressed.trim().length === 0) {
    return { accept: false, ratio, reason: 'empty output' }
  }
  // Must actually save enough to be worth the overhead + quality risk.
  if (ratio < minRatio) {
    return { accept: false, ratio, reason: `ratio ${(ratio * 100).toFixed(0)}% < min ${(minRatio * 100).toFixed(0)}%` }
  }

  // HARD set — any loss rejects.
  const hard = new Set<string>([
    ...matchSet(original, RE_PATH),
    ...matchSet(original, RE_FILE),
    ...matchSet(original, RE_URL),
    ...matchSet(original, RE_ERRCODE),
  ])
  const hardLost = missing(hard, compressed)
  if (hardLost.length > 0) {
    return { accept: false, ratio, reason: `dropped critical token(s): ${hardLost.slice(0, 3).join(', ')}`, lostHard: hardLost }
  }

  // SOFT set — tolerate a small fraction of drops.
  const soft = new Set<string>([
    ...rareTokens(original, RE_DOTTED, 3),
    ...rareTokens(original, RE_IDENT, 3),
    ...rareTokens(original, RE_QUOTED, 2),
    ...rareTokens(original, RE_NUM, 5),
  ])
  // Don't double-penalize tokens already covered by the hard set.
  for (const h of hard) soft.delete(h)
  const softTotal = soft.size
  if (softTotal > 0) {
    const softLost = missing(soft, compressed).length
    // Floor of 2 so a summary dropping one or two incidental tokens (e.g. a benign
    // count) isn't rejected; the HARD set already protects the irreplaceable tokens.
    const allowed = Math.max(2, Math.floor(softTotal * softTolerance))
    if (softLost > allowed) {
      return { accept: false, ratio, reason: `dropped ${softLost}/${softTotal} key tokens (allowed ${allowed})` }
    }
  }

  return { accept: true, ratio }
}
