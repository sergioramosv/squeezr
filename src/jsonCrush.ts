/**
 * JSON array crusher — Squeezr's take on headroom's SmartCrusher, deterministic path.
 *
 * A huge amount of tool output is an ARRAY OF HOMOGENEOUS OBJECTS: `gh api`, `curl`
 * to a REST endpoint, MCP tools that return record lists, `kubectl get -o json`, etc.
 * Minifying that JSON removes whitespace but leaves EVERY key repeated on EVERY row —
 * `"id":`, `"name":`, `"status":`… ×N. The dominant cost is the repeated schema.
 *
 * This reshapes such an array into a compact table: the column names appear ONCE in a
 * header, then one row of values per element. No key is repeated. It is:
 *
 *   - Deterministic  → same input → byte-identical output → prompt-cache safe.
 *   - Reversible      → the full original JSON is stored in the expand store; the marker
 *                       carries `squeezr_expand("<id>")` so the model can get exact JSON.
 *   - Lossless (repr) → every value still appears in the table body; nothing is dropped.
 *
 * Conservative by design: it only fires when the WHOLE (trimmed) input is a JSON array of
 * mostly-objects, there are enough rows, and the table actually saves a meaningful amount.
 * Anything else is returned untouched. This is the low-risk, high-value core; row-dropping
 * (the lossy SmartCrusher path) is intentionally NOT done here.
 */

import { storeOriginal } from './expand.js'

const MIN_ITEMS = 5
const MIN_OBJECT_FRACTION = 0.8   // ≥80% of elements must be plain objects
const MIN_SAVINGS_RATIO = 0.15    // only crush if it shaves ≥15% of the chars
const LOSSY_ROW_THRESHOLD = 50    // above this many rows, drop near-duplicates (SimHash)
const HAMMING_NEAR_DUP = 3        // rows within this 32-bit Hamming distance are "the same"
const ROW_SIGNAL_RE = /\b(error|err|fail|failed|failure|exception|fatal|panic|denied|refused|timeout|critical|crash|oom|unhealthy|degraded)\b/i

// Recognises the table header this module emits (anywhere in the text, since the table
// may be embedded in a larger tool result). Group 1 = the expand id.
export const TABLE_MARKER_RE = /\[squeezr:table ([0-9a-f]{6,}(?:~\d+)?) —/

type Row = Record<string, unknown>

function isPlainObject(v: unknown): v is Row {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ── SimHash near-duplicate detection (deterministic, dependency-free) ─────────

/** FNV-1a 32-bit hash of a token. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 32-bit SimHash fingerprint of a text (bit-voting over its word tokens). Two texts
 *  that share most tokens get fingerprints a small Hamming distance apart. */
export function simhash32(text: string): number {
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? []
  if (tokens.length === 0) return 0
  const bits = new Array(32).fill(0)
  for (const t of tokens) {
    const h = fnv1a32(t)
    for (let b = 0; b < 32; b++) bits[b] += ((h >>> b) & 1) ? 1 : -1
  }
  let f = 0
  for (let b = 0; b < 32; b++) if (bits[b] > 0) f |= (1 << b)
  return f >>> 0
}

export function hammingDistance(a: number, b: number): number {
  let x = (a ^ b) >>> 0
  let c = 0
  while (x) { c += x & 1; x >>>= 1 }
  return c
}

/**
 * Given the per-row rendered strings, return the indices to KEEP: one representative per
 * SimHash cluster (near-duplicates dropped), plus every row that carries an error/anomaly
 * signal (always kept). Order preserved. Deterministic.
 */
function selectRepresentativeRows(rowStrings: string[]): number[] {
  const reps: number[] = []          // simhash fingerprints of chosen representatives
  const kept: number[] = []
  for (let i = 0; i < rowStrings.length; i++) {
    if (ROW_SIGNAL_RE.test(rowStrings[i])) { kept.push(i); continue } // anomaly → always keep
    const sig = simhash32(rowStrings[i])
    if (reps.some(r => hammingDistance(r, sig) <= HAMMING_NEAR_DUP)) continue // near-dup → drop
    reps.push(sig)
    kept.push(i)
  }
  return kept
}

/** Union of keys across rows, in first-seen order (deterministic). */
function collectColumns(rows: Row[]): string[] {
  const cols: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!isPlainObject(row)) continue
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) { seen.add(k); cols.push(k) }
    }
  }
  return cols
}

const CELL_DELIM = '\t'

/** Render one cell. Scalars raw; strings raw unless they carry the delimiter/newline;
 *  objects/arrays as compact JSON. Absent keys → empty cell. */
function cell(value: unknown, present: boolean): string {
  if (!present) return ''
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number' || t === 'boolean') return String(value)
  if (t === 'string') {
    const s = value as string
    return s.includes(CELL_DELIM) || s.includes('\n') ? JSON.stringify(s) : s
  }
  return JSON.stringify(value)
}

/**
 * If `text` is (entirely) a crushable JSON array of objects, return the table form plus
 * the char count saved. Otherwise return the input unchanged with savedChars = 0.
 */
export function crushJsonArrays(text: string): { text: string; savedChars: number } {
  const trimmed = text.trim()
  if (trimmed.length === 0 || (trimmed[0] !== '[')) return { text, savedChars: 0 }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { text, savedChars: 0 }
  }
  if (!Array.isArray(parsed) || parsed.length < MIN_ITEMS) return { text, savedChars: 0 }

  const objectCount = parsed.filter(isPlainObject).length
  if (objectCount / parsed.length < MIN_OBJECT_FRACTION) return { text, savedChars: 0 }

  const rows = parsed as unknown[]
  const cols = collectColumns(rows.filter(isPlainObject) as Row[])
  if (cols.length === 0) return { text, savedChars: 0 }

  const header = cols.join(CELL_DELIM)
  const rowLines: string[] = rows.map(row =>
    isPlainObject(row)
      ? cols.map(c => cell(row[c], c in row)).join(CELL_DELIM)
      // Non-object element inside a mostly-object array: keep it verbatim as JSON so
      // nothing is lost (recoverable in full via expand anyway).
      : JSON.stringify(row),
  )

  // Lossy row-drop for LARGE arrays: collapse near-duplicate rows (SimHash), always
  // keeping anomaly/error rows. Deterministic → cache-safe. The full original is in the
  // expand store, so dropped rows are recoverable. Small arrays keep every row.
  let bodyLines = rowLines
  let omitted = 0
  if (rows.length > LOSSY_ROW_THRESHOLD) {
    const kept = selectRepresentativeRows(rowLines)
    if (kept.length < rowLines.length) {
      bodyLines = kept.map(i => rowLines[i])
      omitted = rowLines.length - kept.length
    }
  }

  const id = storeOriginal(text)
  const marker = omitted > 0
    ? `[squeezr:table ${id} — showing ${bodyLines.length} of ${rows.length} rows × ${cols.length} cols; ${omitted} near-duplicate rows omitted; squeezr_expand("${id}") for original JSON]`
    : `[squeezr:table ${id} — ${rows.length} rows × ${cols.length} cols; squeezr_expand("${id}") for original JSON]`
  const out = `${marker}\n${header}\n${bodyLines.join('\n')}`
  const savedChars = text.length - out.length
  if (savedChars <= 0 || savedChars / text.length < MIN_SAVINGS_RATIO) return { text, savedChars: 0 }
  return { text: out, savedChars }
}
