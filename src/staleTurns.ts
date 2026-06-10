/**
 * Stale turn summarization (v1.52.0)
 *
 * When a conversation exceeds staleThreshold user turns, compress old assistant
 * text blocks using deterministic keyword extraction — no AI call, synchronous.
 *
 * Safety constraints (hard rules, never violated):
 *  - NEVER touches tool_use or tool_result blocks
 *  - NEVER touches user messages (any turn, any index)
 *  - NEVER compresses the last keepRecent turns (full fidelity preserved)
 *  - NEVER modifies non-text blocks inside assistant messages
 *  - NEVER produces empty content (skips blocks that don't shrink)
 *  - Zero AI calls, zero async, zero side effects outside the messages array
 */
const MIN_BLOCK_LEN = 250

interface AMsg {
  role: string
  content: string | Array<{ type?: string; text?: string }>
}

function compressTextBlock(text: string): string {
  // Plain ASCII placeholder — no Unicode symbols, no user content keywords.
  // The ⧖ symbol and inline keywords previously used here were triggering
  // Anthropic Usage Policy violations (false positives from safety filters).
  return `[squeezr: ${text.length}-char turn condensed to save context]`
}

export interface StaleTurnsResult {
  savedChars: number
  collapsedBlocks: number
  staleCount: number
}

export function collapseStaleTurns(
  messages: AMsg[],
  threshold: number,
  keepRecent: number,
): StaleTurnsResult {
  const userIdx: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') userIdx.push(i)
  }

  const totalTurns = userIdx.length
  if (totalTurns <= threshold) return { savedChars: 0, collapsedBlocks: 0, staleCount: 0 }

  const staleBefore = userIdx[totalTurns - keepRecent] ?? userIdx[0] ?? 0
  const staleCount = Math.max(0, totalTurns - keepRecent)

  let savedChars = 0
  let collapsedBlocks = 0

  for (let i = 0; i < staleBefore; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue

    if (typeof msg.content === 'string') {
      if (msg.content.length >= MIN_BLOCK_LEN) {
        const compressed = compressTextBlock(msg.content)
        const saved = msg.content.length - compressed.length
        if (saved > 0) { msg.content = compressed; savedChars += saved; collapsedBlocks++ }
      }
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type !== 'text' || typeof block.text !== 'string') continue
        if (block.text.length < MIN_BLOCK_LEN) continue
        const compressed = compressTextBlock(block.text)
        const saved = block.text.length - compressed.length
        if (saved > 0) { block.text = compressed; savedChars += saved; collapsedBlocks++ }
      }
    }
  }

  return { savedChars, collapsedBlocks, staleCount }
}
