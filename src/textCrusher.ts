/**
 * TextCrusher — deterministic, cache-safe extractive compression for large PROSE/LOG
 * blocks. Squeezr's take on headroom's TextCrusher (their fast, no-model alternative to
 * the ML compressor).
 *
 * Exact line-dedup (already in the base pipeline) only catches byte-identical repeats.
 * A huge share of log spam is NOT byte-identical — it's the same line with a different
 * number, timestamp or hex id ("processed record 1 in 2ms", "…record 2 in 4ms", …).
 * TextCrusher collapses those NEAR-duplicates by normalizing volatile tokens, while:
 *
 *   - always keeping high-signal lines (error/warn/fail/exception/…),
 *   - always keeping head + tail anchor lines (context),
 *   - preserving original order,
 *   - staying fully deterministic → byte-stable → prompt-cache safe.
 *
 * It never drops content irrecoverably: callers wrap the result with makeRecoverable so
 * the full original is one squeezr_expand away.
 */

export interface CrushTextOpts {
  maxLines: number   // target ceiling for kept content lines
  headKeep: number   // always keep the first N lines
  tailKeep: number   // always keep the last N lines
  query: string      // if non-empty, fill the budget by BM25 relevance to this task
}

const DEFAULTS: CrushTextOpts = { maxLines: 60, headKeep: 5, tailKeep: 5, query: '' }

const SIGNAL_RE = /\b(error|err|warn|warning|fail|failed|failure|exception|fatal|panic|traceback|denied|refused|timeout|timed out|cannot|unable|missing|undefined|null pointer|segfault|assert)\b/i

/** Collapse volatile tokens so near-duplicate lines share a key. */
export function normalizeLineKey(line: string): string {
  return line
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '') // ISO timestamps
    .replace(/\b\d{1,2}:\d{2}:\d{2}\b/g, '')                            // clock times
    .replace(/0x[0-9a-fA-F]+/g, '#')                                    // hex
    .replace(/\b\d+\b/g, '#')                                           // numbers
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function isSignal(line: string): boolean {
  return SIGNAL_RE.test(line)
}

import { bm25Scores } from './relevance.js'

export interface CrushResult {
  text: string
  kept: number
  dropped: number
}

export function crushText(text: string, opts: Partial<CrushTextOpts> = {}): CrushResult {
  const o = { ...DEFAULTS, ...opts }
  const lines = text.split('\n')
  const n = lines.length

  // Nothing to gain below the budget.
  if (n <= o.maxLines) return { text, kept: n, dropped: 0 }

  const headEnd = Math.min(o.headKeep, n)
  const tailStart = Math.max(headEnd, n - o.tailKeep)

  // Pass 1 — decide which indices to keep.
  const keep = new Array<boolean>(n).fill(false)
  const seenKeys = new Set<string>()
  let budget = o.maxLines

  const tryKeep = (i: number, key: string) => {
    if (keep[i]) return
    keep[i] = true
    seenKeys.add(key)
    budget--
  }

  // Anchors + signal lines first (highest priority), registering their normalized keys
  // so later near-duplicates of them are suppressed.
  for (let i = 0; i < n; i++) {
    const key = normalizeLineKey(lines[i])
    const anchor = i < headEnd || i >= tailStart
    if (anchor || isSignal(lines[i])) tryKeep(i, key)
  }

  // Candidate lines for the remaining budget: first occurrence of each not-yet-seen
  // normalized key (so near-duplicates collapse to their first representative).
  const candidates: number[] = []
  const candSeen = new Set(seenKeys)
  for (let i = 0; i < n; i++) {
    if (keep[i]) continue
    const key = normalizeLineKey(lines[i])
    if (key === '' || candSeen.has(key)) continue
    candSeen.add(key)
    candidates.push(i)
  }

  // Order candidates: by BM25 relevance to the task when a query is given (keep the
  // lines that matter for what the user is doing), else by original order. Relevance
  // is only ever driven from OUTSIDE the cached prefix (see compressor), so this stays
  // cache-safe. Kept lines are still emitted in original order below.
  let ordered = candidates
  if (o.query.trim() !== '' && candidates.length > 0) {
    const scores = bm25Scores(o.query, candidates.map(i => lines[i]))
    ordered = candidates
      .map((idx, k) => ({ idx, score: scores[k], k }))
      .sort((a, b) => (b.score - a.score) || (a.k - b.k))
      .map(x => x.idx)
  }
  for (const i of ordered) {
    if (budget <= 0) break
    tryKeep(i, normalizeLineKey(lines[i]))
  }

  // Reconstruct in original order, summarizing runs of dropped lines with one marker.
  const out: string[] = []
  let droppedRun = 0
  let dropped = 0
  const flush = () => {
    if (droppedRun > 0) { out.push(`... [${droppedRun} lines omitted]`); dropped += droppedRun; droppedRun = 0 }
  }
  for (let i = 0; i < n; i++) {
    if (keep[i]) { flush(); out.push(lines[i]) }
    else droppedRun++
  }
  flush()

  if (dropped === 0) return { text, kept: n, dropped: 0 }
  return { text: out.join('\n'), kept: n - dropped, dropped }
}
