/**
 * Attachment / artifact dedup (v1.49.0).
 *
 * When a user attaches a CSV/PDF/code file to Claude Desktop, the app converts
 * it to text and inserts a large `text` block in the user message. On every
 * follow-up turn the FULL converted text rides again. Similar pattern with
 * artifact blocks (code/markdown that Claude generated) echoed back across
 * turns.
 *
 * Strategy:
 *  - Hash text blocks ≥ MIN_BLOCK_CHARS
 *  - Skip the LAST user message and LAST assistant message — those are live
 *  - For each hash with ≥2 occurrences, keep the LATEST at full fidelity,
 *    replace earlier ones with a short reference + squeezr_expand id
 *
 * Safety constraints (lessons learned):
 *  - Never operate on `tool_use` or `tool_result` blocks (they have ID links)
 *  - Never produce empty content (`content = ''` breaks Anthropic schema)
 *  - The most recent occurrence stays untouched
 *  - Per-request scope only; no cross-session state
 */
import { createHash } from 'node:crypto'
import { storeOriginal } from './expand.js'
const MIN_BLOCK_CHARS = 500
interface AnthropicMessage {
  role: string
  content: string | Array<Record<string, unknown>>
}
function hashText(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 12)
}
export function dedupAttachments(messages: AnthropicMessage[]): { savedChars: number; dedupCount: number } {
  // Identify the live (last) user + assistant message indices — never touch these
  let lastUserIdx = -1
  let lastAsstIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (lastUserIdx === -1 && messages[i].role === 'user') lastUserIdx = i
    if (lastAsstIdx === -1 && messages[i].role === 'assistant') lastAsstIdx = i
    if (lastUserIdx !== -1 && lastAsstIdx !== -1) break
  }
  // Collect candidate positions: text blocks ≥ MIN_BLOCK_CHARS inside non-live messages
  const positions: Array<{ msgIdx: number; blockIdx: number; hash: string; text: string }> = []
  for (let i = 0; i < messages.length; i++) {
    if (i === lastUserIdx || i === lastAsstIdx) continue
    const content = messages[i].content
    if (!Array.isArray(content)) continue
    for (let j = 0; j < content.length; j++) {
      const block = content[j]
      if (block.type !== 'text' || typeof block.text !== 'string') continue
      if (block.text.length < MIN_BLOCK_CHARS) continue
      positions.push({ msgIdx: i, blockIdx: j, hash: hashText(block.text), text: block.text })
    }
  }
  if (positions.length < 2) return { savedChars: 0, dedupCount: 0 }
  // Group by hash
  const groups = new Map<string, Array<{ msgIdx: number; blockIdx: number; text: string }>>()
  for (const p of positions) {
    if (!groups.has(p.hash)) groups.set(p.hash, [])
    groups.get(p.hash)!.push({ msgIdx: p.msgIdx, blockIdx: p.blockIdx, text: p.text })
  }
  let savedChars = 0
  let dedupCount = 0
  for (const [, occurrences] of groups) {
    if (occurrences.length < 2) continue
    const last = occurrences[occurrences.length - 1]
    const id = storeOriginal(last.text)
    for (let k = 0; k < occurrences.length - 1; k++) {
      const o = occurrences[k]
      const placeholder = `[squeezr: same ${last.text.length}-char block reappears in message #${last.msgIdx + 1} below — squeezr_expand(${id}) to retrieve]`
      ;(messages[o.msgIdx].content as Array<Record<string, unknown>>)[o.blockIdx] = {
        type: 'text',
        text: placeholder,
      }
      savedChars += Math.max(0, o.text.length - placeholder.length)
      dedupCount++
    }
  }
  if (dedupCount > 0) {
    const tokens = Math.round(savedChars / 3.5)
    console.log(`[squeezr/attach-dedup] ${dedupCount} duplicate attachment/artifact block(s) collapsed: -${savedChars.toLocaleString()} chars (~${tokens.toLocaleString()} tokens)`)
  }
  return { savedChars, dedupCount }
}
