/**
 * Tool description compression (v1.55.0)
 *
 * Compresses the `description` field of tool definitions in the `tools[]` array.
 * The `input_schema` and `name` fields are NEVER touched.
 *
 * Based on capture analysis (145 tools · 98,006 chars · ~28K tokens/request):
 *
 *  EXPAND mode (tool_desc_expand = true, default):
 *    Truncates ALL tool descriptions to the first paragraph, stores the full
 *    spec in the expand store, and appends [squeezr_expand('ID') — full spec]
 *    so Claude can fetch the complete spec just-in-time before using a complex
 *    tool (Workflow, MCP, etc.). Saves ~23K tokens/request. Claude recovers the
 *    spec with one expand call when needed.
 *
 *  SAFE_ONLY mode (tool_desc_expand = false, tool_desc_safe_only = true):
 *    Only truncates 10 well-known built-ins Claude knows from training.
 *    Saves ~7K tokens/request. Zero risk — no expand needed.
 *
 * Safety constraints:
 *  - NEVER touches `input_schema` or `name`
 *  - Result discarded if longer than original
 *  - Expand IDs are deterministic (MD5) — safe for Anthropic prefix cache
 */

import { storeOriginal } from './expand.js'

const MIN_DESC_LEN = 200
const MIN_FIRST_PARA_LEN = 500

const SAFE_BUILTIN_TOOLS = new Set([
  'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'PowerShell',
])

type ToolDef = { name?: unknown; description?: unknown; input_schema?: unknown; [k: string]: unknown }

function normalizeDesc(text: string): string {
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
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
  safeOnly: boolean,
  useExpand: boolean,
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

    const toolName = String(t.name ?? '')

    // In safe-only mode (no expand), skip non-whitelisted tools
    if (!useExpand && safeOnly && !SAFE_BUILTIN_TOOLS.has(toolName)) continue

    let result = normalizeDesc(orig)

    if (firstPara && result.length > MIN_FIRST_PARA_LEN) {
      const para = firstParagraph(result)
      if (para.length >= 20) {
        if (useExpand) {
          // Store full spec for on-demand retrieval — deterministic ID safe for prefix cache
          const id = storeOriginal(orig)
          result = `${para}…[squeezr_expand('${id}') — full spec]`
        } else {
          result = para + '…'
        }
      }
    }

    if (maxChars > 0 && result.length > maxChars) result = result.slice(0, maxChars) + '…'

    const saved = orig.length - result.length
    if (saved > 0) { t.description = result; savedChars += saved; compressedTools++ }
  }

  return { savedChars, compressedTools, totalTools: tools.length }
}
