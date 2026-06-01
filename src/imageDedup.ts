/**
 * Image dedup hash-based (v1.48.0).
 *
 * Vision tokens on Claude are expensive (~$15/MTok). When a user attaches
 * a screenshot and then asks N follow-up questions about it, the image is
 * re-sent in every turn. Each occurrence costs ~1000-2000 vision tokens.
 *
 * Strategy:
 *  - Walk all messages in order; for each `image` content block compute an
 *    MD5 of its source (base64 data or URL).
 *  - For images that appear more than once, KEEP the most recent occurrence
 *    at full fidelity and replace the earlier ones with a short text block:
 *      [squeezr: same image as message #N below — squeezr_expand(id) to retrieve]
 *  - The original image bytes are stored via `storeOriginal()` so the model
 *    can call `squeezr_expand` to recover the full image if needed.
 *
 * Safety:
 *  - Only touches content blocks of type `image`. Never touches text blocks,
 *    tool_use, tool_result, system, tools.
 *  - The most recent occurrence stays untouched — the live request always has
 *    the image at full fidelity for whatever the user just asked.
 *  - Per-request scope only. No cross-session state. Cannot break prompt cache
 *    because we only operate on `messages` (Anthropic processes cache markers
 *    in `tools` → `system` → `messages`, so changes to messages don't reorder
 *    upstream markers).
 */
import { createHash } from 'node:crypto'
import { storeOriginal } from './expand.js'
interface ImageSource {
  type: string
  data?: string
  url?: string
  media_type?: string
}
interface ImageBlock {
  type: 'image'
  source: ImageSource
}
interface AnthropicMessage {
  role: string
  content: string | Array<Record<string, unknown>>
}
function isImageBlock(b: unknown): b is ImageBlock {
  if (!b || typeof b !== 'object') return false
  const obj = b as { type?: string; source?: unknown }
  return obj.type === 'image'
    && obj.source !== null
    && typeof obj.source === 'object'
}
function hashImage(block: ImageBlock): string {
  const src = block.source
  const key = src.type === 'base64' ? `b64:${src.data ?? ''}` : `url:${src.url ?? ''}`
  return createHash('md5').update(key).digest('hex').slice(0, 12)
}
function imageBytes(block: ImageBlock): number {
  return block.source.data?.length ?? block.source.url?.length ?? 0
}
/**
 * Dedup repeated images. Returns metrics; modifies `messages` in place.
 */
export function dedupImagesAnthropic(messages: AnthropicMessage[]): { savedChars: number; dedupCount: number } {
  // Collect (msgIdx, blockIdx, hash, block) for every image
  const positions: Array<{ msgIdx: number; blockIdx: number; hash: string; block: ImageBlock }> = []
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content
    if (!Array.isArray(content)) continue
    for (let j = 0; j < content.length; j++) {
      const block = content[j]
      if (isImageBlock(block)) {
        positions.push({ msgIdx: i, blockIdx: j, hash: hashImage(block), block })
      }
    }
  }
  if (positions.length < 2) return { savedChars: 0, dedupCount: 0 }
  // For each hash, find the LAST occurrence — that one stays full
  const lastIdx = new Map<string, number>()
  for (let k = positions.length - 1; k >= 0; k--) {
    if (!lastIdx.has(positions[k].hash)) lastIdx.set(positions[k].hash, k)
  }
  // Replace earlier occurrences with text placeholders + expand id
  let savedChars = 0
  let dedupCount = 0
  const expandIds = new Map<string, string>()
  for (let k = 0; k < positions.length; k++) {
    const p = positions[k]
    const last = lastIdx.get(p.hash)!
    if (last === k) continue
    if (!expandIds.has(p.hash)) {
      const original = JSON.stringify(p.block.source)
      expandIds.set(p.hash, storeOriginal(original))
    }
    const id = expandIds.get(p.hash)!
    const placeholder = {
      type: 'text',
      text: `[squeezr: same image as message #${last + 1} below — squeezr_expand(${id}) to retrieve original]`,
    }
    const beforeBytes = imageBytes(p.block)
    ;(messages[p.msgIdx].content as Array<Record<string, unknown>>)[p.blockIdx] = placeholder
    savedChars += Math.max(0, beforeBytes - placeholder.text.length)
    dedupCount++
  }
  if (dedupCount > 0) {
    const approxTokens = Math.round(savedChars / 3.5)
    console.log(`[squeezr/img-dedup] ${dedupCount} duplicate image(s) collapsed: -${savedChars.toLocaleString()} chars (~${approxTokens.toLocaleString()} tokens)`)
  }
  return { savedChars, dedupCount }
}
