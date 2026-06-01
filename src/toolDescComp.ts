/**
 * Tool description compression (v1.53.0)
 *
 * Compresses the `description` field of tool definitions in the `tools[]`
 * array. The `input_schema` and `name` fields are NEVER touched.
 *
 * Two-pass approach:
 *  1. Whitespace normalization — always safe (trailing spaces, 3+ newlines→2).
 *  2. Hard truncation — opt-in via `tool_desc_max_chars` config (default: 0 = off).
 *
 * Safety constraints (hard rules):
 *  - NEVER touches `input_schema` (functional, not descriptive)
 *  - NEVER touches `name` (required for tool dispatch)
 *  - Default OFF — set `tool_desc_compress = true` to enable
 *  - If compressed description >= original, original is kept unchanged
 */
const MIN_DESC_LEN = 200

type ToolDef = { name?: unknown; description?: unknown; input_schema?: unknown; [k: string]: unknown }

function normalizeDesc(text: string): string {
  return text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface ToolDescResult {
  savedChars: number
  compressedTools: number
  totalTools: number
}

export function compressToolDescriptions(tools: unknown[], maxChars: number): ToolDescResult {
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
    if (maxChars > 0 && result.length > maxChars) result = result.slice(0, maxChars) + '…'

    const saved = orig.length - result.length
    if (saved > 0) { t.description = result; savedChars += saved; compressedTools++ }
  }

  return { savedChars, compressedTools, totalTools: tools.length }
}
