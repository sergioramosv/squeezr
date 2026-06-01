/**
 * Skill / plugin block dedup for the system prompt (v1.51.0).
 *
 * Claude Code plugins are known to register the same skill section more than
 * once in the system prompt (issue claude-code#29971). Some integrations also
 * include identical "tool usage examples" blocks repeated across sections.
 * Each duplicated section costs ~10-30K tokens per request.
 *
 * Strategy:
 *  - Split the prompt on blank lines into blocks
 *  - For each block ≥MIN_BLOCK_LINES lines and ≥MIN_BLOCK_CHARS chars, compute
 *    MD5 of the block content
 *  - If a block appears more than once, keep the FIRST occurrence and replace
 *    every subsequent identical block with a short placeholder
 *
 * Safety constraints (lessons learned):
 *  - Exact byte-match required (MD5). One character difference = no dedup.
 *  - Cache_control markers on system blocks are NEVER touched (this module
 *    runs on the string text only, before any cache_control injection).
 *  - Preserves the original separator characters between blocks (so the
 *    reassembled prompt has identical whitespace structure).
 *  - Static imports, per-request scope.
 */
import { createHash } from 'node:crypto'
const MIN_BLOCK_LINES = 4
const MIN_BLOCK_CHARS = 200
function md5(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 12)
}
export function dedupSkillBlocks(prompt: string): { text: string; savedChars: number; dedupCount: number } {
  if (!prompt || prompt.length < MIN_BLOCK_CHARS * 2) {
    return { text: prompt, savedChars: 0, dedupCount: 0 }
  }
  // Split into blocks by blank lines, tracking offsets so we can reassemble
  // with the original whitespace separators preserved.
  const blocks: Array<{ text: string; start: number; end: number }> = []
  const sepRe = /\n\s*\n/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = sepRe.exec(prompt)) !== null) {
    blocks.push({ text: prompt.slice(last, m.index), start: last, end: m.index })
    last = m.index + m[0].length
  }
  blocks.push({ text: prompt.slice(last), start: last, end: prompt.length })
  // Count occurrences of each candidate block (≥ thresholds)
  const firstSeen = new Map<string, number>()  // hash → block idx of first occurrence
  const counts = new Map<string, number>()
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.text.length < MIN_BLOCK_CHARS) continue
    if (b.text.split('\n').length < MIN_BLOCK_LINES) continue
    const h = md5(b.text)
    counts.set(h, (counts.get(h) ?? 0) + 1)
    if (!firstSeen.has(h)) firstSeen.set(h, i)
  }
  // Reassemble preserving separators, replacing duplicates
  let savedChars = 0
  let dedupCount = 0
  const out: string[] = []
  let cursor = 0
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.start > cursor) out.push(prompt.slice(cursor, b.start))
    let emit = b.text
    if (b.text.length >= MIN_BLOCK_CHARS && b.text.split('\n').length >= MIN_BLOCK_LINES) {
      const h = md5(b.text)
      const first = firstSeen.get(h)
      const cnt = counts.get(h) ?? 0
      if (cnt > 1 && first !== undefined && first !== i) {
        emit = `[squeezr: duplicate of block #${first + 1} above — ${b.text.length} chars elided]`
        savedChars += b.text.length - emit.length
        dedupCount++
      }
    }
    out.push(emit)
    cursor = b.end
  }
  if (cursor < prompt.length) out.push(prompt.slice(cursor))
  if (dedupCount > 0) {
    const tokens = Math.round(savedChars / 3.5)
    console.log(`[squeezr/skill-dedup] ${dedupCount} duplicate block(s) collapsed: -${savedChars.toLocaleString()} chars (~${tokens.toLocaleString()} tokens)`)
  }
  return { text: out.join(''), savedChars, dedupCount }
}
