/**
 * BM25 relevance scorer — a shared primitive so Squeezr's compressors can keep content
 * by RELEVANCE to the current task, not just by position (head/tail) or recency.
 *
 * This is the single highest-leverage idea copied from headroom: their SmartCrusher,
 * TextCrusher and CodeCompressor all route "what to keep" through one relevance scorer.
 * Squeezr, until now, kept blindly. This module is that scorer — pure TS, zero deps,
 * deterministic (→ cache-safe when used to drive byte-stable compression).
 *
 * BM25 (Okapi) is the standard, well-understood ranking function: term frequency with
 * saturation (k1) and document-length normalization (b), weighted by inverse document
 * frequency so rare query terms (an error code, a filename) count far more than common
 * words. The idf uses +0.5 smoothing so it is always positive.
 */

export interface BM25Options {
  k1?: number   // term-frequency saturation (default 1.5)
  b?: number    // length-normalization strength 0..1 (default 0.75)
}

const DEFAULT_K1 = 1.5
const DEFAULT_B = 0.75

/** Lowercase, split on non-alphanumerics, keep tokens of length >= 2. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const m of text.toLowerCase().matchAll(/[a-z0-9_]+/g)) {
    if (m[0].length >= 2) out.push(m[0])
  }
  return out
}

/**
 * BM25 score of each doc in `docs` against `query`. One score per doc, in order.
 * A doc with no query-term overlap scores exactly 0.
 */
export function bm25Scores(query: string, docs: string[], opts: BM25Options = {}): number[] {
  const k1 = opts.k1 ?? DEFAULT_K1
  const b = opts.b ?? DEFAULT_B

  const queryTerms = [...new Set(tokenize(query))]
  const N = docs.length
  if (queryTerms.length === 0 || N === 0) return new Array(N).fill(0)

  // Tokenize docs once; compute lengths and average length.
  const docTokens = docs.map(tokenize)
  const docLen = docTokens.map(t => t.length)
  const avgdl = docLen.reduce((s, l) => s + l, 0) / N || 1

  // Per-doc term-frequency maps.
  const tf: Array<Map<string, number>> = docTokens.map(tokens => {
    const m = new Map<string, number>()
    for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1)
    return m
  })

  // Document frequency + idf per query term.
  const idf = new Map<string, number>()
  for (const term of queryTerms) {
    let df = 0
    for (const m of tf) if (m.has(term)) df++
    // Always-positive smoothed idf.
    idf.set(term, Math.log(1 + (N - df + 0.5) / (df + 0.5)))
  }

  return docTokens.map((_, i) => {
    let score = 0
    const len = docLen[i]
    for (const term of queryTerms) {
      const f = tf[i].get(term) ?? 0
      if (f === 0) continue
      const denom = f + k1 * (1 - b + (b * len) / avgdl)
      score += (idf.get(term) ?? 0) * ((f * (k1 + 1)) / denom)
    }
    return score
  })
}

/** Document indices sorted by descending relevance (ties keep original order). */
export function rankByRelevance(query: string, docs: string[], opts?: BM25Options): number[] {
  const scores = bm25Scores(query, docs, opts)
  return scores
    .map((score, i) => ({ score, i }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .map(x => x.i)
}
