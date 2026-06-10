import { createHash } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const EXPAND_STORE_PATH = join(homedir(), '.squeezr', 'expand_store.json')

/**
 * Expand store — keeps original tool results so the model can retrieve
 * them if it needs more detail than the compressed summary provides.
 *
 * How it works:
 *  1. When Squeezr compresses a tool result, it stores the original here
 *     and embeds the ID in the compressed text: [squeezr:abc123 -85%] summary
 *
 *  2. A `squeezr_expand` tool is injected into every request's tool list.
 *
 *  3. If the model calls squeezr_expand(id), Squeezr intercepts the
 *     tool_use in the response and returns the original without ever
 *     hitting the provider API.
 *
 *  4. The conversation continues transparently.
 */

const store = new Map<string, string>()

export function storeOriginal(original: string): string {
  // Deterministic ID: same content always gets the same ID.
  // This is required for KV cache warming — random IDs would produce different
  // bytes on each request even for identical content, breaking Anthropic's prefix cache.
  const id = createHash('md5').update(original).digest('hex').slice(0, 6)
  store.set(id, original)
  return id
}

export function retrieveOriginal(id: string): string | undefined {
  return store.get(id)
}

export function expandStoreSize(): number {
  return store.size
}

export function clearExpandStore(): void {
  store.clear()
}

export function loadExpandStore(): void {
  try {
    if (existsSync(EXPAND_STORE_PATH)) {
      const raw = JSON.parse(readFileSync(EXPAND_STORE_PATH, 'utf-8'))
      for (const [k, v] of Object.entries(raw)) {
        store.set(k, v as string)
      }
      if (store.size > 0) console.log(`[squeezr] Loaded ${store.size} expand store entries from disk`)
    }
  } catch { /* ignore */ }
}

export function persistExpandStore(): void {
  try {
    const dir = join(homedir(), '.squeezr')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(EXPAND_STORE_PATH, JSON.stringify(Object.fromEntries(store)))
  } catch { /* ignore */ }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

// Shared, deliberately FORCEFUL description. Squeezr replaces large tool results
// with lossy summaries marked `[squeezr:ID -N%]`. If the model works from the
// summary when it actually needed the exact bytes (editing code, quoting an error,
// reading a value, applying a diff), it produces wrong output. So the description
// is imperative and names the exact triggers — passive wording ("use when you need
// more detail") was observed to be ignored.
export const EXPAND_TOOL_DESCRIPTION =
  'Retrieve the FULL, exact original text of a Squeezr-compressed tool result. ' +
  'Squeezr replaces large tool outputs with a lossy summary tagged `[squeezr:ID -N%]` ' +
  '(ID = 6 hex chars; -N% = how much was removed). The summary OMITS detail. ' +
  'You MUST call squeezr_expand(ID) before relying on the exact contents of any such ' +
  'result — e.g. editing/quoting code precisely, copying an error or log line verbatim, ' +
  'reading exact values/IDs/paths, or applying a diff. NEVER guess, reconstruct, ' +
  'paraphrase, or approximate compressed content from its summary — expand it. ' +
  'Expansion is instant and free (served from a local store, no model/API cost). ' +
  'If a higher -N% is shown, more was removed, so expanding matters more.'

export const EXPAND_TOOL_ANTHROPIC = {
  name: 'squeezr_expand',
  description: EXPAND_TOOL_DESCRIPTION,
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The 6-char ID from [squeezr:ID] in the compressed content',
      },
    },
    required: ['id'],
  },
}

export const EXPAND_TOOL_OPENAI = {
  type: 'function' as const,
  function: {
    name: 'squeezr_expand',
    description: EXPAND_TOOL_ANTHROPIC.description,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The 6-char ID from [squeezr:ID] in the compressed content' },
      },
      required: ['id'],
    },
  },
}

// Char cost of injecting the expand tool into a request's tools[] — the proxy's
// own overhead, added to EVERY request. Surfaced in the dashboard "Reality check"
// so the reported net savings honestly subtract it.
export const EXPAND_TOOL_ANTHROPIC_CHARS = JSON.stringify(EXPAND_TOOL_ANTHROPIC).length
export const EXPAND_TOOL_OPENAI_CHARS = JSON.stringify(EXPAND_TOOL_OPENAI).length
// ── Inject helpers ────────────────────────────────────────────────────────────
// Each returns the char cost it added (0 if the tool was already present).
export function injectExpandToolAnthropic(body: Record<string, unknown>): void {
  if (!body.tools) body.tools = []
  const tools = body.tools as unknown[]
  const already = tools.some((t) => (t as { name?: string }).name === 'squeezr_expand')
  if (!already) tools.push(EXPAND_TOOL_ANTHROPIC)
}

export function injectExpandToolOpenAI(body: Record<string, unknown>): void {
  if (!body.tools) body.tools = []
  const tools = body.tools as unknown[]
  const already = tools.some(
    (t) => (t as { function?: { name?: string } }).function?.name === 'squeezr_expand',
  )
  if (!already) tools.push(EXPAND_TOOL_OPENAI)
}

// ── System-prompt directive ────────────────────────────────────────────────────
// A tool description alone was observed to be too weak — the model ignored the
// compressed markers and worked from summaries. This directive is added to the
// system prompt so the instruction sits in the highest-weight channel. A unique
// sentinel makes injection idempotent and detectable.
export const EXPAND_DIRECTIVE_SENTINEL = '[Squeezr/expand-directive]'
export const SYSTEM_EXPAND_DIRECTIVE =
  `${EXPAND_DIRECTIVE_SENTINEL} Some tool results below are compressed to save tokens and ` +
  'tagged `[squeezr:ID -N%]` — these are LOSSY summaries that omit detail. The moment you ' +
  'need the exact contents of one (to edit or quote code precisely, copy an error/log line ' +
  'verbatim, read an exact value/path/ID, or apply a diff), you MUST call the squeezr_expand ' +
  'tool with that ID and use the returned text — do NOT guess, paraphrase, or reconstruct ' +
  'compressed content from its summary. Expansion is instant and free.'

export const SYSTEM_EXPAND_DIRECTIVE_CHARS = SYSTEM_EXPAND_DIRECTIVE.length

/**
 * Append the expand directive to an Anthropic request's system prompt.
 *
 * Cache-safe by construction: it appends a NEW trailing text block and never
 * mutates existing blocks, so any block carrying `cache_control` stays byte-for-byte
 * identical → Anthropic's prefix cache keeps hitting. The new block has no
 * cache_control, so it sits in the cheap post-barrier tail. Idempotent via sentinel.
 * Returns chars added (0 if already present / no system to attach to).
 */
export function injectExpandDirectiveAnthropic(body: Record<string, unknown>): number {
  const sys = body.system
  if (typeof sys === 'string') {
    if (sys.includes(EXPAND_DIRECTIVE_SENTINEL)) return 0
    body.system = sys + '\n\n' + SYSTEM_EXPAND_DIRECTIVE
    return SYSTEM_EXPAND_DIRECTIVE.length + 2
  }
  if (Array.isArray(sys)) {
    const blocks = sys as Array<{ type?: string; text?: string }>
    if (blocks.some(b => b.type === 'text' && typeof b.text === 'string' && b.text.includes(EXPAND_DIRECTIVE_SENTINEL))) return 0
    blocks.push({ type: 'text', text: SYSTEM_EXPAND_DIRECTIVE })
    return SYSTEM_EXPAND_DIRECTIVE.length
  }
  // No system prompt at all — create one so the directive still lands.
  if (sys === undefined) {
    body.system = SYSTEM_EXPAND_DIRECTIVE
    return SYSTEM_EXPAND_DIRECTIVE.length
  }
  return 0
}

/** OpenAI variant: prepend the directive to the system/developer message (or add one). */
export function injectExpandDirectiveOpenAI(body: Record<string, unknown>): number {
  const msgs = body.messages as Array<{ role?: string; content?: unknown }> | undefined
  if (!Array.isArray(msgs)) return 0
  const sysMsg = msgs.find(m => m.role === 'system' || m.role === 'developer')
  if (sysMsg && typeof sysMsg.content === 'string') {
    if (sysMsg.content.includes(EXPAND_DIRECTIVE_SENTINEL)) return 0
    sysMsg.content = sysMsg.content + '\n\n' + SYSTEM_EXPAND_DIRECTIVE
    return SYSTEM_EXPAND_DIRECTIVE.length + 2
  }
  if (!sysMsg) {
    msgs.unshift({ role: 'system', content: SYSTEM_EXPAND_DIRECTIVE })
    return SYSTEM_EXPAND_DIRECTIVE.length
  }
  return 0
}

// ── Response interception ─────────────────────────────────────────────────────

interface AnthropicContent {
  type: string
  id?: string
  name?: string
  input?: { id?: string }
}

interface OpenAIChoice {
  message?: {
    tool_calls?: Array<{
      id: string
      function: { name: string; arguments: string }
    }>
  }
}

/** Returns the original content if the Anthropic response contains a squeezr_expand call. */
export function handleAnthropicExpandCall(
  responseBody: Record<string, unknown>,
): { toolUseId: string; original: string } | null {
  const content = responseBody.content as AnthropicContent[] | undefined
  if (!content) return null
  for (const block of content) {
    if (block.type === 'tool_use' && block.name === 'squeezr_expand') {
      const id = block.input?.id ?? ''
      const original = retrieveOriginal(id)
      if (original && block.id) {
        return { toolUseId: block.id, original }
      }
    }
  }
  return null
}

/** Returns the original content if the OpenAI response contains a squeezr_expand call. */
export function handleOpenAIExpandCall(
  responseBody: Record<string, unknown>,
): { toolCallId: string; original: string } | null {
  const choices = responseBody.choices as OpenAIChoice[] | undefined
  if (!choices?.[0]) return null
  const toolCalls = choices[0].message?.tool_calls
  if (!toolCalls) return null
  for (const call of toolCalls) {
    if (call.function.name === 'squeezr_expand') {
      try {
        const args = JSON.parse(call.function.arguments)
        const original = retrieveOriginal(args.id ?? '')
        if (original) return { toolCallId: call.id, original }
      } catch { /* ignore */ }
    }
  }
  return null
}
