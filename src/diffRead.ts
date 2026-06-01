/**
 * Diff-based repeated Read dedup (v1.50.0).
 *
 * When the same file is Read multiple times in a session (very common during
 * refactor: read → edit → read again to verify), each Read carries the full
 * file. If only a few lines changed between reads, sending the full text twice
 * is mostly waste.
 *
 * Strategy:
 *  - Find all Read tool_use blocks; group by file_path
 *  - For each path with ≥2 reads, keep the LATEST at full fidelity
 *  - Replace earlier reads' tool_result with a unified diff (Myers algorithm
 *    via the `diff` npm package) vs the latest content
 *  - If the diff would be ≥60% of original size, fall back to a reference-only
 *    placeholder (cheaper than the diff itself)
 *
 * Safety constraints (lessons learned):
 *  - Preserves tool_use IDs intact (only modifies the tool_result.content)
 *  - Never operates on content shorter than MIN_TEXT_TO_DIFF
 *  - Original text recoverable via squeezr_expand
 *  - Per-request scope, static imports
 */
import { createHash } from 'node:crypto'
import { createPatch } from 'diff'
import { storeOriginal } from './expand.js'
const MIN_TEXT_TO_DIFF = 500
const MAX_DIFF_LINES = 50
interface AnthropicMessage {
  role: string
  content: string | Array<Record<string, unknown>>
}
interface ToolUse {
  msgIdx: number
  blockIdx: number
  toolUseId: string
  filePath: string
}
interface ToolResult {
  msgIdx: number
  blockIdx: number
  toolUseId: string
  text: string
}
function md5(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 12)
}
function findReadToolUses(messages: AnthropicMessage[]): ToolUse[] {
  const out: ToolUse[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'assistant') continue
    const content = messages[i].content
    if (!Array.isArray(content)) continue
    for (let j = 0; j < content.length; j++) {
      const b = content[j]
      if (b.type !== 'tool_use') continue
      const name = (b.name as string | undefined)?.toLowerCase()
      if (name !== 'read') continue
      const input = (b.input as { file_path?: string; path?: string } | undefined) ?? {}
      const filePath = input.file_path ?? input.path ?? ''
      if (!filePath) continue
      out.push({ msgIdx: i, blockIdx: j, toolUseId: (b.id as string) ?? '', filePath })
    }
  }
  return out
}
function findToolResults(messages: AnthropicMessage[]): Map<string, ToolResult> {
  const byId = new Map<string, ToolResult>()
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'user') continue
    const content = messages[i].content
    if (!Array.isArray(content)) continue
    for (let j = 0; j < content.length; j++) {
      const b = content[j]
      if (b.type !== 'tool_result') continue
      const id = (b.tool_use_id as string) ?? ''
      const text = typeof b.content === 'string'
        ? b.content
        : Array.isArray(b.content)
          ? (b.content as Array<{ text?: string }>).map(c => c.text ?? '').join('\n')
          : ''
      if (!text) continue
      byId.set(id, { msgIdx: i, blockIdx: j, toolUseId: id, text })
    }
  }
  return byId
}
/**
 * Real unified diff via the Myers algorithm. Returns null when the diff body
 * exceeds MAX_DIFF_LINES (caller falls back to a plain reference).
 */
function lineDiff(oldText: string, newText: string, path: string): string | null {
  const patch = createPatch(path, oldText, newText, '', '', { context: 1 })
  const lines = patch.split('\n')
  let bodyStart = 0
  for (let i = 0; i < Math.min(6, lines.length); i++) {
    if (lines[i].startsWith('@@')) { bodyStart = i; break }
  }
  const bodyLines = lines.slice(bodyStart)
  if (bodyLines.length > MAX_DIFF_LINES) return null
  return bodyLines.join('\n')
}
export function compressRepeatedReads(messages: AnthropicMessage[]): { savedChars: number; collapsedCount: number } {
  const reads = findReadToolUses(messages)
  if (reads.length < 2) return { savedChars: 0, collapsedCount: 0 }
  const results = findToolResults(messages)
  // Group by file_path
  const byPath = new Map<string, ToolUse[]>()
  for (const r of reads) {
    if (!byPath.has(r.filePath)) byPath.set(r.filePath, [])
    byPath.get(r.filePath)!.push(r)
  }
  let savedChars = 0
  let collapsedCount = 0
  for (const [path, calls] of byPath) {
    if (calls.length < 2) continue
    const latest = calls[calls.length - 1]
    const latestResult = results.get(latest.toolUseId)
    if (!latestResult || latestResult.text.length < MIN_TEXT_TO_DIFF) continue
    for (let k = 0; k < calls.length - 1; k++) {
      const earlier = calls[k]
      const earlierResult = results.get(earlier.toolUseId)
      if (!earlierResult || earlierResult.text.length < MIN_TEXT_TO_DIFF) continue
      // Identical content — let cross-turn dedup handle it later (don't compete)
      if (md5(earlierResult.text) === md5(latestResult.text)) continue
      const diff = lineDiff(earlierResult.text, latestResult.text, path)
      const expandId = storeOriginal(earlierResult.text)
      let placeholder: string
      if (diff && diff.length < earlierResult.text.length * 0.6) {
        placeholder = `[squeezr: ${path} read at message #${earlier.msgIdx + 1}, file has since been modified. Latest version at message #${latest.msgIdx + 1}. Diff old→new (${diff.split('\n').length} lines changed):\n${diff}\n— squeezr_expand(${expandId}) for original at this point in time]`
      } else {
        placeholder = `[squeezr: ${path} read at message #${earlier.msgIdx + 1}; file has since been substantially modified — see latest version at message #${latest.msgIdx + 1}, or squeezr_expand(${expandId}) for original at this point]`
      }
      const beforeSize = earlierResult.text.length
      const target = messages[earlierResult.msgIdx].content as Array<Record<string, unknown>>
      target[earlierResult.blockIdx].content = placeholder
      savedChars += Math.max(0, beforeSize - placeholder.length)
      collapsedCount++
    }
  }
  if (collapsedCount > 0) {
    const tokens = Math.round(savedChars / 3.5)
    console.log(`[squeezr/diff-read] ${collapsedCount} repeated Read(s) collapsed to diff: -${savedChars.toLocaleString()} chars (~${tokens.toLocaleString()} tokens)`)
  }
  return { savedChars, collapsedCount }
}
