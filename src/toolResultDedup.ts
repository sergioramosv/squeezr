/**
 * Cross-turn tool-result dedup (Fase B1).
 *
 * The same tool output often reappears verbatim across turns — e.g. the model
 * re-runs the same Bash/Grep command, or the harness re-prints the same status.
 * Each occurrence carries the full text. diffRead.ts handles repeated *Read*
 * results (by file path, via diff) and deliberately SKIPS identical content,
 * leaving it for this pass (see diffRead.ts comment "let cross-turn dedup handle it").
 *
 * Strategy (deterministic, free, recoverable):
 *  - Collect every tool_result across the conversation.
 *  - Group by md5(content) for content >= MIN_CHARS.
 *  - For each group with >= 2 identical results, keep the LATEST at full fidelity
 *    and replace the earlier identical ones with a short reference + expand id.
 *
 * Safety: only modifies tool_result.content (never tool_use IDs); original
 * recoverable via squeezr_expand. Like the other dedup passes, the caller only
 * runs this when there are NO prompt-cache markers (it moves/replaces content, so
 * it's not byte-stable across requests and would invalidate a cached prefix).
 */
import { createHash } from 'node:crypto'
import { storeOriginal } from './expand.js'

const MIN_CHARS = 500

interface AnthropicMessage {
  role: string
  content: string | Array<Record<string, unknown>>
}
interface ResultRef { msgIdx: number; blockIdx: number; text: string }

function md5(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 12)
}

function resultText(b: Record<string, unknown>): string {
  return typeof b.content === 'string'
    ? b.content
    : Array.isArray(b.content)
      ? (b.content as Array<{ text?: string }>).map(c => c.text ?? '').join('\n')
      : ''
}

export function compressDuplicateToolResults(messages: AnthropicMessage[]): { savedChars: number; collapsedCount: number } {
  // Collect all tool_results, in order.
  const all: ResultRef[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'user') continue
    const content = messages[i].content
    if (!Array.isArray(content)) continue
    for (let j = 0; j < content.length; j++) {
      const b = content[j]
      if (b.type !== 'tool_result') continue
      const text = resultText(b)
      if (text.length < MIN_CHARS) continue
      // Skip blocks we've already compressed (don't double-process our own tags).
      if (text.startsWith('[squeezr:') || text.startsWith('[squeezr ')) continue
      all.push({ msgIdx: i, blockIdx: j, text })
    }
  }
  if (all.length < 2) return { savedChars: 0, collapsedCount: 0 }

  // Group by content hash.
  const byHash = new Map<string, ResultRef[]>()
  for (const r of all) {
    const h = md5(r.text)
    if (!byHash.has(h)) byHash.set(h, [])
    byHash.get(h)!.push(r)
  }

  let savedChars = 0
  let collapsedCount = 0
  for (const group of byHash.values()) {
    if (group.length < 2) continue
    const latest = group[group.length - 1] // keep the most recent at full fidelity
    const expandId = storeOriginal(latest.text)
    for (let k = 0; k < group.length - 1; k++) {
      const earlier = group[k]
      const placeholder = `[squeezr: identical tool output as message #${latest.msgIdx + 1} (${earlier.text.length.toLocaleString()} chars) — squeezr_expand(${expandId}) for the full text]`
      const before = earlier.text.length
      const target = messages[earlier.msgIdx].content as Array<Record<string, unknown>>
      target[earlier.blockIdx].content = placeholder
      savedChars += Math.max(0, before - placeholder.length)
      collapsedCount++
    }
  }
  if (collapsedCount > 0) {
    const tokens = Math.round(savedChars / 3.5)
    console.log(`[squeezr/toolresult-dedup] ${collapsedCount} duplicate tool output(s) collapsed: -${savedChars.toLocaleString()} chars (~${tokens.toLocaleString()} tokens)`)
  }
  return { savedChars, collapsedCount }
}
