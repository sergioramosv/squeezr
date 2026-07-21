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

// Recognises the table header this module emits (anywhere in the text, since the table
// may be embedded in a larger tool result). Group 1 = the expand id.
export const TABLE_MARKER_RE = /\[squeezr:table ([0-9a-f]{6,}(?:~\d+)?) —/

type Row = Record<string, unknown>

function isPlainObject(v: unknown): v is Row {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
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
  const bodyLines: string[] = []
  for (const row of rows) {
    if (isPlainObject(row)) {
      bodyLines.push(cols.map(c => cell(row[c], c in row)).join(CELL_DELIM))
    } else {
      // Non-object element inside a mostly-object array: keep it verbatim as JSON on
      // its own line so nothing is lost (recoverable in full via expand anyway).
      bodyLines.push(JSON.stringify(row))
    }
  }

  // Build the (id-less) body first to measure real savings before we pay for an id.
  const provisional = `${header}\n${bodyLines.join('\n')}`
  const saved = text.length - provisional.length
  if (saved <= 0 || saved / text.length < MIN_SAVINGS_RATIO) return { text, savedChars: 0 }

  const id = storeOriginal(text)
  const marker = `[squeezr:table ${id} — ${rows.length} rows × ${cols.length} cols; squeezr_expand("${id}") for original JSON]`
  const out = `${marker}\n${header}\n${bodyLines.join('\n')}`
  const savedChars = text.length - out.length
  if (savedChars <= 0) return { text, savedChars: 0 }
  return { text: out, savedChars }
}
