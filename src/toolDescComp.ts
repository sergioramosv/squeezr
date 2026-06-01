/**
 * Tool description compression (v1.54.1)
 *
 * Compresses the `description` field of tool definitions in the `tools[]` array.
 * The `input_schema` and `name` fields are NEVER touched.
 *
 * Based on capture analysis (145 tools · 98,006 chars · ~28K tokens/request):
 *
 *  SAFE_ONLY mode (default, tool_desc_safe_only = true):
 *    Only truncates 10 well-known Claude Code built-ins that Claude already knows
 *    from training (Bash, Read, Edit, Write, Glob, Grep, WebFetch, WebSearch,
 *    NotebookEdit, PowerShell). Saves ~7,000 tokens/request with zero risk.
 *    MCP tools, Workflow, Agent, etc. keep their full descriptions.
 *
 *  ALL mode (tool_desc_safe_only = false, opt-in):
 *    Truncates every tool description > MIN_FIRST_PARA_LEN chars. Saves ~23K tokens
 *    but Claude loses Workflow scripting spec and MCP tool details — use with caution.
 *
 * Three passes (in order):
 *  1. Whitespace normalization
 *  2. First-paragraph truncation (up to first blank line)
 *  3. Hard char cap via tool_desc_max_chars (default 0 = off)
 *
 * Safety constraints (hard rules):
 *  - NEVER touches `input_schema` or `name`
 *  - Default: safe_only = true (whitelist only)
 *  - Result discarded if longer than original
 */

const MIN_DESC_LEN = 200
const MIN_FIRST_PARA_LEN = 500

// Claude Code built-ins that Claude knows from training — safe to truncate.
// Source: capture analysis 2026-06-01. Do NOT add MCP tools or Workflow here.
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

    // In safe-only mode, skip tools not in the whitelist
    if (safeOnly && !SAFE_BUILTIN_TOOLS.has(String(t.name ?? ''))) continue

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
