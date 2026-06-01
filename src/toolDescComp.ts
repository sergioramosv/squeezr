/**
 * Tool description compression (v1.54.0)
 *
 * Compresses the `description` field of tool definitions in the `tools[]`
 * array. The `input_schema` and `name` fields are NEVER touched.
 *
 * Based on capture data (req-0002.json):
 *   145 tools · 98,006 chars · ~28,000 tokens per request
 *   First-paragraph truncation → 17,329 chars · ~23,000 tokens saved per request
 *
 * Three passes (in order):
 *  1. Whitespace normalization — always safe.
 *  2. First-paragraph truncation — keeps everything up to the first blank line.
 *     Enabled via `tool_desc_first_para = true` (default true when compress is on).
 *     Only applies to descriptions > MIN_FIRST_PARA_LEN chars.
 *  3. Hard truncation — fallback max-chars cap via `tool_desc_max_chars` (default 0 = off).
 *
 * Safety constraints (hard rules):
 *  - NEVER touches `input_schema` or `name`
 *  - Default OFF — requires `tool_desc_compress = true`
 *  - Result is discarded if it ends up longer than the original
 */

const MIN_DESC_LEN = 200       // skip descriptions shorter than this
const MIN_FIRST_PARA_LEN = 500 // only first-para-truncate if description > this

type ToolDef = { name?: unknown; description?: unknown; input_schema?: unknown; [k: string]: unknown }

function normalizeDesc(text: string): string {
  return text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function firstParagraph(text: string): string {
  const idx = text.indexOf('\n\n')
  return idx !== -1 ? text.slice(0, idx).trim() : text
}

export interface ToolDescResult {
  savedChars: number
  compressedTools: number
  totalTools: number
}

export function compressToolDescriptions(
  tools: unknown[],
  maxChars: number,
  firstPara: boolean,
): ToolDescResult {
  if (!Array.isArray(tools)) return { savedChars: 0, compressedTools: 0, totalTools: 0 }

  let savedChars = 0
  let compressedTools = 0

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const t = tool as ToolDef
    if (typeof t.description !== 'string') continue
    const orig = t.description as string
    if (orig.length < MIN_DESC_LEN) continue

    let result = normalizeDesc(orig)

    if (firstPara && result.length > MIN_FIRST_PARA_LEN) {
      const para = firstParagraph(result)
      if (para.length >= 20) result = para + '…'
    }

    if (maxChars > 0 && result.length > maxChars) result = result.slice(0, maxChars) + '…'

    const saved = orig.length - result.length
    if (saved > 0) { t.description = result; savedChars += saved; compressedTools++ }
  }

  return { savedChars, compressedTools, totalTools: tools.length }
}
