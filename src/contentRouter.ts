/**
 * Content router — extends the JSON crusher's reach from "the WHOLE tool result is a JSON
 * array" to "a JSON array appears ANYWHERE inside the tool result". Squeezr's take on the
 * routing idea behind headroom's ContentRouter.
 *
 * A lot of structured data arrives wrapped: `gh api` with a status line, an MCP tool that
 * returns a labelled envelope, a bash command that echoes a header then the JSON. Before,
 * jsonCrush only fired on a pure-JSON result, so those were missed. This locates embedded
 * arrays-of-objects and crushes each in place, leaving the surrounding text untouched.
 *
 * Safety: candidate spans are found by balanced-bracket scanning (string/escape aware),
 * but the real safety net is that each span is handed to crushJsonArrays, which JSON.parses
 * it — a false-positive span that isn't valid JSON simply doesn't crush and is left verbatim.
 * Deterministic → cache-safe. Each crushed span is self-recoverable via its own expand id.
 */

import { crushJsonArrays, TABLE_MARKER_RE } from './jsonCrush.js'

export { TABLE_MARKER_RE }

/** Scan from an opening '[' to its matching ']' (exclusive end), string/escape aware.
 *  Returns -1 if unbalanced. */
function scanArray(text: string, start: number): number {
  let depth = 0
  let inStr = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '[') depth++
    else if (c === ']') { depth--; if (depth === 0) return i + 1 }
  }
  return -1
}

/** Non-overlapping, top-level spans of `[ {...`-style arrays (arrays of objects). */
export function findObjectArraySpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  const n = text.length
  let i = 0
  let inStr = false
  while (i < n) {
    const c = text[i]
    if (inStr) {
      if (c === '\\') { i += 2; continue }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') { inStr = true; i++; continue }
    if (c === '[') {
      // peek past whitespace for '{' → array of objects
      let j = i + 1
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] === '{') {
        const end = scanArray(text, i)
        if (end > i) { spans.push({ start: i, end }); i = end; continue }
      }
    }
    i++
  }
  return spans
}

/**
 * Crush every embedded array-of-objects in `text`, splicing each crushed table back in and
 * leaving the surrounding text verbatim. Returns the new text and total chars saved.
 */
export function crushEmbeddedJson(text: string): { text: string; savedChars: number } {
  const spans = findObjectArraySpans(text)
  if (spans.length === 0) return { text, savedChars: 0 }

  let out = ''
  let last = 0
  let saved = 0
  for (const { start, end } of spans) {
    out += text.slice(last, start)
    const sub = text.slice(start, end)
    const crushed = crushJsonArrays(sub)
    out += crushed.text
    saved += crushed.savedChars
    last = end
  }
  out += text.slice(last)

  if (saved <= 0) return { text, savedChars: 0 }
  return { text: out, savedChars: saved }
}
