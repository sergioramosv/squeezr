import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { CompressionCache } from './cache.js'
import { preprocess, preprocessAssistant, preprocessForTool, hitPattern } from './deterministic.js'
import { storeOriginal } from './expand.js'
import { hashText, getBlock, setBlock, SessionBlock } from './sessionCache.js'
import type { Config } from './config.js'
import { effectiveThreshold, effectiveKeepRecent, aiEnabled, effectiveBackend } from './config.js'
import { circuitBreaker } from './circuitBreaker.js'

export interface Savings {
  compressed: number
  savedChars: number
  originalChars: number
  byTool: Array<{ tool: string; savedChars: number; originalChars: number }>
  dryRun: boolean
  sessionCacheHits: number
  // Honest breakdown for accurate gain reporting
  detSavedChars?: number     // deterministic preprocessing savings
  dedupSavedChars?: number   // read-dedup savings
  aiSavedChars?: number      // AI compression savings (net, after tag overhead)
  overheadChars?: number     // chars added by [squeezr:XXXX] tags
  // Latency tracking (ms)
  detMs?: number             // deterministic preprocessing time
  aiMs?: number              // AI compression time
}

const COMPRESS_PROMPT =
  'You are compressing a coding tool output to save tokens. ' +
  'Extract ONLY what is essential: errors, file paths, function names, ' +
  'test failures, key values, warnings. ' +
  'Be extremely concise, target under 150 tokens. ' +
  'Output only the compressed content, nothing else.'

let _cache: CompressionCache | null = null
export function getCache(config: Config): CompressionCache {
  if (!_cache) _cache = new CompressionCache(config.cacheMaxEntries)
  return _cache
}

function estimatePressure(messages: unknown[], extraChars = 0): number {
  const chars = JSON.stringify(messages).length + extraChars
  return Math.min(chars / 800_000, 1.0)
}

// ── Compression backends ──────────────────────────────────────────────────────

async function compressWithHaiku(text: string, apiKey: string): Promise<string> {
  // apiKey can be either a real API key (sk-ant-...) or an OAuth bearer token.
  // The Anthropic SDK accepts both: apiKey → x-api-key header,
  // authToken → Authorization: Bearer header.
  const authOpts = apiKey.startsWith('sk-') ? { apiKey } : { authToken: apiKey }
  // Force real API URL — ANTHROPIC_BASE_URL points to this proxy, which would cause
  // infinite recursion if we let the SDK inherit it from the environment.
  const client = new Anthropic({ ...authOpts, baseURL: 'https://api.anthropic.com' })
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: `${COMPRESS_PROMPT}\n\n---\n${text.slice(0, 4000)}` }],
  })
  return (resp.content[0] as { text: string }).text
}

async function compressWithGptMini(text: string, apiKey: string): Promise<string> {
  // apiKey can be a real key (sk-...) or an OAuth bearer token
  // Force real API URL — openai_base_url points to this proxy, which would cause
  // infinite recursion if we let the SDK inherit it from the environment.
  const client = new OpenAI({ apiKey, baseURL: 'https://api.openai.com/v1' })
  const resp = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 300,
    messages: [{ role: 'user', content: `${COMPRESS_PROMPT}\n\n---\n${text.slice(0, 4000)}` }],
  })
  return resp.choices[0].message.content ?? ''
}

async function compressWithGeminiFlash(text: string, apiKey: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-8b:generateContent?key=${apiKey}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${COMPRESS_PROMPT}\n\n---\n${text.slice(0, 4000)}` }] }],
    }),
  })
  const data = (await resp.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> }
  return data.candidates[0].content.parts[0].text
}

async function compressWithOllama(text: string, baseUrl: string, model: string): Promise<string> {
  const client = new OpenAI({ apiKey: 'ollama', baseURL: `${baseUrl.replace(/\/$/, '')}/v1` })
  const resp = await client.chat.completions.create({
    model,
    max_tokens: 300,
    messages: [{ role: 'user', content: `${COMPRESS_PROMPT}\n\n---\n${text.slice(0, 4000)}` }],
  })
  return resp.choices[0].message.content ?? ''
}

// ── AI compression orchestrator ───────────────────────────────────────────────

type CompressFn = (text: string) => Promise<string>

/**
 * Resolve which compression backend to actually use based on the runtime override.
 *
 * - 'auto'         → use the default backend for this API (the `defaultFn` passed in)
 * - 'local'        → use Ollama / squeezr-1B (always local, no API call)
 * - 'haiku'        → force Anthropic Haiku regardless of which API the request came from
 * - 'gpt-mini'     → force OpenAI gpt-4o-mini
 * - 'gemini-flash' → force Google Gemini Flash
 *
 * If the chosen backend has no key available (e.g. user picked haiku but only ever used
 * OpenAI), falls back to defaultFn so we never break compression.
 */
function getEffectiveCompressFn(defaultFn: CompressFn, config: Config): CompressFn {
  const backend = effectiveBackend()
  if (backend === 'auto') return defaultFn
  if (backend === 'local') {
    return (text: string) => compressWithOllama(text, config.localUpstreamUrl, config.localCompressionModel)
  }
  // Cross-backend usage: need a key. Lazy-loaded to avoid circular import.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { storedKey } = require('./limits.js') as typeof import('./limits.js')
  if (backend === 'haiku') {
    const k = storedKey('anthropic')
    if (!k) { console.log('[squeezr] backend=haiku but no anthropic key seen yet — fallback to auto'); return defaultFn }
    return (text: string) => compressWithHaiku(text, k)
  }
  if (backend === 'gpt-mini') {
    const k = storedKey('openai')
    if (!k) { console.log('[squeezr] backend=gpt-mini but no openai key seen yet — fallback to auto'); return defaultFn }
    return (text: string) => compressWithGptMini(text, k)
  }
  if (backend === 'gemini-flash') {
    const k = storedKey('gemini')
    if (!k) { console.log('[squeezr] backend=gemini-flash but no gemini key seen yet — fallback to auto'); return defaultFn }
    return (text: string) => compressWithGeminiFlash(text, k)
  }
  return defaultFn
}

async function runCompression(
  items: Array<{ index: number; subIndex?: number; text: string; tool: string }>,
  compressFn: CompressFn,
  config: Config,
): Promise<Array<{ index: number; subIndex?: number; original: string; result: string; tool: string }>> {
  const cache = getCache(config)
  const results = await Promise.allSettled(
    items.map(async (item) => {
      const preprocessed = preprocess(item.text)
      if (config.cacheEnabled) {
        const cached = cache.get(preprocessed)
        if (cached) return { ...item, original: item.text, result: cached }
      }
      const compressed = await circuitBreaker.call(() => compressFn(preprocessed))
      if (config.cacheEnabled) cache.set(preprocessed, compressed)
      return { ...item, original: item.text, result: compressed }
    }),
  )
  const failures = results.filter(r => r.status === 'rejected').length
  if (failures > 0) console.log(`[squeezr] ${failures} AI compression(s) failed (circuit: ${circuitBreaker.getState()})`)
  return results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => (r as PromiseFulfilledResult<{ index: number; subIndex?: number; original: string; result: string; tool: string }>).value)
}

// ── Session cache helper ──────────────────────────────────────────────────────

function buildAndCache(original: string, result: string): { fullString: string; savedChars: number; overheadChars: number } {
  const ratio = Math.round((1 - result.length / Math.max(original.length, 1)) * 100)
  const id = storeOriginal(original)
  const fullString = `[squeezr:${id} -${ratio}%] ${result}`
  const overheadChars = fullString.length - result.length  // tag overhead
  // Real savings: original minus what's actually sent (fullString, including tag)
  const savedChars = original.length - fullString.length
  setBlock(hashText(original), { fullString, savedChars, originalChars: original.length })
  return { fullString, savedChars, overheadChars }
}

// ── Anthropic format ──────────────────────────────────────────────────────────

interface AnthropicMessage {
  role: string
  content: string | Array<{ type: string; tool_use_id?: string; content?: unknown }>
}

function extractAnthropicToolResults(
  messages: AnthropicMessage[],
  toolIdMap: Map<string, string>,
): Array<{ index: number; subIndex: number; text: string; tool: string; toolUseId: string }> {
  const results = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j]
      if (block.type !== 'tool_result') continue
      const text = typeof block.content === 'string' ? block.content
        : Array.isArray(block.content) ? (block.content as Array<{ type?: string; text?: string }>)
            .filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
        : ''
      const toolUseId = block.tool_use_id ?? ''
      if (text.length > 0) {
        results.push({ index: i, subIndex: j, text, tool: toolIdMap.get(toolUseId) ?? 'unknown', toolUseId })
      }
    }
  }
  return results
}

// ── User text blocks ──────────────────────────────────────────────────────────
// Plain text blocks in user messages (NOT tool_result). This is where Claude
// Desktop attachments + large pastes live. We compress deterministically only —
// never AI — and skip the LAST user message so the active instruction is never
// touched. Min length filters out greetings / single-line prompts.
function extractAnthropicUserTextBlocks(
  messages: AnthropicMessage[],
  minLength: number,
): Array<{ index: number; subIndex: number; text: string; isString: boolean }> {
  const out: Array<{ index: number; subIndex: number; text: string; isString: boolean }> = []
  const userIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') userIndices.push(i)
  }
  // Skip the most recent user message — it's the live ask, must stay intact.
  const eligible = userIndices.slice(0, Math.max(0, userIndices.length - 1))
  for (const i of eligible) {
    const msg = messages[i]
    if (typeof msg.content === 'string') {
      if (msg.content.length >= minLength) {
        out.push({ index: i, subIndex: -1, text: msg.content, isString: true })
      }
    } else if (Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j] as { type?: string; text?: string }
        if (block.type !== 'text') continue
        const text = block.text ?? ''
        if (text.length >= minLength) out.push({ index: i, subIndex: j, text, isString: false })
      }
    }
  }
  return out
}

// ── tool_use inputs ───────────────────────────────────────────────────────────
// Long fields inside the `input` JSON of an assistant tool_use block:
//   Bash      → command (rarely long, but happens with here-docs)
//   Edit      → old_string, new_string
//   Write     → content
//   NotebookEdit → new_source
//   Grep      → pattern (usually short — skip)
// We only touch OLD turns (not last assistant message) to keep the active call
// at full fidelity, in case the upstream re-reads it for tool dispatch logic.
const TOOL_USE_INPUT_FIELDS: Record<string, string[]> = {
  bash: ['command'],
  edit: ['old_string', 'new_string'],
  write: ['content'],
  notebookedit: ['new_source'],
  multiedit: ['edits'], // array of {old_string,new_string}
}

function compressToolUseInputDet(
  input: unknown,
  toolName: string,
): { input: unknown; saved: number } {
  const fields = TOOL_USE_INPUT_FIELDS[toolName.toLowerCase()]
  if (!fields || !input || typeof input !== 'object') return { input, saved: 0 }
  const obj = input as Record<string, unknown>
  let saved = 0
  let mutated = false
  const out: Record<string, unknown> = { ...obj }
  for (const field of fields) {
    const val = obj[field]
    if (typeof val === 'string' && val.length >= 200) {
      const det = preprocess(val)
      if (det.length < val.length) {
        out[field] = det
        saved += val.length - det.length
        mutated = true
      }
    } else if (Array.isArray(val) && field === 'edits') {
      const newEdits = val.map((e: unknown) => {
        if (!e || typeof e !== 'object') return e
        const edit = e as Record<string, unknown>
        const ne: Record<string, unknown> = { ...edit }
        for (const k of ['old_string', 'new_string']) {
          const s = edit[k]
          if (typeof s === 'string' && s.length >= 200) {
            const det = preprocess(s)
            if (det.length < s.length) { ne[k] = det; saved += s.length - det.length; mutated = true }
          }
        }
        return ne
      })
      if (mutated) out[field] = newEdits
    }
  }
  return mutated ? { input: out, saved } : { input, saved: 0 }
}

function extractAnthropicAssistantToolUses(
  messages: AnthropicMessage[],
  keepRecentAssistant: number,
): Array<{ index: number; subIndex: number; tool: string }> {
  const out: Array<{ index: number; subIndex: number; tool: string }> = []
  const assistantIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant') assistantIndices.push(i)
  }
  const eligible = assistantIndices.slice(0, Math.max(0, assistantIndices.length - keepRecentAssistant))
  for (const i of eligible) {
    const msg = messages[i]
    if (!Array.isArray(msg.content)) continue
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j] as { type?: string; name?: string }
      if (block.type !== 'tool_use') continue
      out.push({ index: i, subIndex: j, tool: block.name ?? 'unknown' })
    }
  }
  return out
}

/**
 * Extract text content from assistant messages.
 * Assistant messages can be either a plain string or an array of blocks containing
 * `text` and `tool_use` blocks. We only care about `text` blocks here.
 *
 * The last `keepRecentAssistant` assistant messages are excluded so the model
 * always has the most recent few turns at full fidelity.
 */
function extractAnthropicAssistantTexts(
  messages: AnthropicMessage[],
  keepRecentAssistant: number,
  minLength: number,
): Array<{ index: number; subIndex: number; text: string; isString: boolean }> {
  const results: Array<{ index: number; subIndex: number; text: string; isString: boolean }> = []
  // First pass: identify all assistant messages
  const assistantIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant') assistantIndices.push(i)
  }
  // Skip the last keepRecentAssistant ones
  const eligible = assistantIndices.slice(0, Math.max(0, assistantIndices.length - keepRecentAssistant))
  for (const i of eligible) {
    const msg = messages[i]
    if (typeof msg.content === 'string') {
      if (msg.content.length >= minLength) {
        results.push({ index: i, subIndex: -1, text: msg.content, isString: true })
      }
    } else if (Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j]
        if (block.type !== 'text') continue
        const text = (block as { text?: string }).text ?? ''
        if (text.length >= minLength) {
          results.push({ index: i, subIndex: j, text, isString: false })
        }
      }
    }
  }
  return results
}

function buildAnthropicToolIdMap(messages: AnthropicMessage[]): { nameMap: Map<string, string>; skipIds: Set<string> } {
  const nameMap = new Map<string, string>()
  const skipIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block.type !== 'tool_use' || !('id' in block) || !('name' in block)) continue
      const id = block.id as string
      nameMap.set(id, block.name as string)
      if (/squeezr:\s*skip/i.test(JSON.stringify((block as Record<string, unknown>).input ?? ''))) skipIds.add(id)
    }
  }
  return { nameMap, skipIds }
}

export async function compressAnthropicMessages(
  messages: AnthropicMessage[],
  apiKey: string,
  config: Config,
  systemExtraChars = 0,
): Promise<[AnthropicMessage[], Savings]> {
  if (config.disabled) return [messages, emptySavings()]

  const pressure = estimatePressure(messages, systemExtraChars)
  const threshold = effectiveThreshold(config, pressure)
  const { nameMap: toolIdMap, skipIds } = buildAnthropicToolIdMap(messages)
  const allResults = extractAnthropicToolResults(messages, toolIdMap)
    .filter(r => !skipIds.has(r.toolUseId) && !config.shouldSkipTool(r.tool))

  if (allResults.length === 0) return [messages, emptySavings()]

  // Clone once — all modifications go here
  const msgs = structuredClone(messages) as AnthropicMessage[]

  // ── Step 0: Cross-turn dedup (Read / Bash / Grep) ────────────────────────────
  // If the exact same tool output appears multiple times in the conversation,
  // keep the most recent occurrence at full fidelity and replace earlier ones
  // with a short reference. Hash is MD5-exact, so any byte difference = no dedup.
  // Zero quality risk: original content is always recoverable via squeezr_expand.
  const dedupedSet = new Set<string>()  // "index:subIndex" keys — skip in later steps
  let readDedupSaved = 0
  // Per-tool short label used in the dedup placeholder text
  const DEDUP_TOOLS: Record<string, string> = {
    read: 'file content as a later read',
    bash: 'bash output as a later call',
    grep: 'grep result as a later search',
  }
  {
    const hashToId = new Map<string, string>()  // hash → expand id of most recent
    const seenMostRecent = new Set<string>()
    let dedupCount = 0
    // Scan newest → oldest: first encounter of each hash = most recent
    for (let i = allResults.length - 1; i >= 0; i--) {
      const { index, subIndex, text, tool } = allResults[i]
      const toolLower = tool.toLowerCase()
      const label = DEDUP_TOOLS[toolLower]
      if (!label) continue
      // Skip tiny outputs — not worth the placeholder overhead (~80 chars)
      if (text.length < 200) continue
      const hash = hashText(text)
      if (!seenMostRecent.has(hash)) {
        seenMostRecent.add(hash)
        hashToId.set(hash, storeOriginal(text))
      } else {
        const id = hashToId.get(hash)!
        ;(msgs[index].content as Array<{ content?: unknown }>)[subIndex].content =
          `[same ${label} in conversation — squeezr_expand(${id}) to retrieve]`
        dedupedSet.add(`${index}:${subIndex}`)
        dedupCount++
        readDedupSaved += text.length
      }
    }
    if (readDedupSaved > 0) {
      const tokens = Math.round(readDedupSaved / 3.5)
      console.log(`[squeezr/dedup] ${dedupCount} duplicate tool output(s) collapsed: -${readDedupSaved.toLocaleString()} chars (~${tokens} tokens)`)
      hitPattern('readDedup', dedupCount)
    }
  }

  // ── Step 1: Deterministic preprocessing on ALL tool results (turn 1+) ───────
  // Replaces RTK: applied to recent blocks too, no manual `rtk` prefix needed.
  const detT0 = Date.now()
  let detSaved = 0
  for (const { index, subIndex, text, tool } of allResults) {
    if (dedupedSet.has(`${index}:${subIndex}`)) continue  // already replaced by dedup
    const det = preprocessForTool(text, tool, pressure)
    if (det !== text) {
      ;(msgs[index].content as Array<{ content?: unknown }>)[subIndex].content = det
      detSaved += text.length - det.length
    }
  }
  const detMs = Date.now() - detT0
  if (detSaved > 0) {
    const tokens = Math.round(detSaved / 3.5)
    console.log(`[squeezr/det] Deterministic: -${detSaved.toLocaleString()} chars (~${tokens} tokens) across ${allResults.length} block(s)`)
  }

  // ── Step 1.5: Deterministic preprocessing on assistant messages ─────────────
  // Only runs if compress_conversation is enabled in config. Zero AI calls,
  // pure regex/whitespace cleanup — safe.
  // Skips the last keep_recent_assistant messages so the immediate context is
  // always at full fidelity. Skips messages below assistant_threshold.
  if (config.compressConversation) {
    const keepRecentAsst = config.keepRecentAssistant
    const minLen = config.assistantThreshold
    const assistantBlocks = extractAnthropicAssistantTexts(msgs, keepRecentAsst, minLen)
    let asstDetSaved = 0
    let asstCount = 0
    for (const blk of assistantBlocks) {
      const det = preprocessAssistant(blk.text)
      if (det.length < blk.text.length) {
        const saved = blk.text.length - det.length
        if (blk.isString) {
          msgs[blk.index].content = det
        } else {
          ;(msgs[blk.index].content as Array<{ text?: string }>)[blk.subIndex].text = det
        }
        asstDetSaved += saved
        asstCount++
      }
    }
    if (asstDetSaved > 0) {
      const tokens = Math.round(asstDetSaved / 3.5)
      console.log(`[squeezr/asst-det] Assistant deterministic: -${asstDetSaved.toLocaleString()} chars (~${tokens} tokens) across ${asstCount} message(s)`)
    }
    detSaved += asstDetSaved
  }

  // ── Step 1.6: Deterministic on user text blocks (Claude Desktop attachments) ─
  // Plain text inside user messages — pastes, attachments, project context.
  // The last user message is never touched (live ask). Pure regex, zero AI.
  if (config.compressConversation) {
    const userBlocks = extractAnthropicUserTextBlocks(msgs, config.assistantThreshold)
    let userDetSaved = 0
    let userCount = 0
    for (const blk of userBlocks) {
      const det = preprocessAssistant(blk.text)
      if (det.length < blk.text.length) {
        const saved = blk.text.length - det.length
        if (blk.isString) {
          msgs[blk.index].content = det
        } else {
          ;(msgs[blk.index].content as Array<{ text?: string }>)[blk.subIndex].text = det
        }
        userDetSaved += saved
        userCount++
      }
    }
    if (userDetSaved > 0) {
      const tokens = Math.round(userDetSaved / 3.5)
      console.log(`[squeezr/user-det] User text deterministic: -${userDetSaved.toLocaleString()} chars (~${tokens} tokens) across ${userCount} block(s)`)
    }
    detSaved += userDetSaved
  }

  // ── Step 1.7: Deterministic on tool_use inputs (Edit/Write/Bash bodies) ─────
  // The `input` JSON of historical tool calls — Edit's old_string/new_string,
  // Write's content. These are huge and previously unprocessed. Skip the most
  // recent N assistant turns (`keepRecentAssistant`) so the live tool call
  // stays intact.
  if (config.compressConversation) {
    const toolUses = extractAnthropicAssistantToolUses(msgs, config.keepRecentAssistant)
    let tuSaved = 0
    let tuCount = 0
    for (const { index, subIndex, tool } of toolUses) {
      const blocks = msgs[index].content as Array<{ type?: string; input?: unknown }>
      const orig = blocks[subIndex].input
      const { input: next, saved } = compressToolUseInputDet(orig, tool)
      if (saved > 0) {
        blocks[subIndex].input = next
        tuSaved += saved
        tuCount++
      }
    }
    if (tuSaved > 0) {
      const tokens = Math.round(tuSaved / 3.5)
      console.log(`[squeezr/toolinput-det] tool_use input deterministic: -${tuSaved.toLocaleString()} chars (~${tokens} tokens) across ${tuCount} call(s)`)
    }
    detSaved += tuSaved
  }

  // ── Step 2: AI compression for old blocks above threshold ─────────────────
  const candidates = allResults.slice(0, Math.max(0, allResults.length - effectiveKeepRecent(config)))
  const toProcess = candidates.filter(c => c.text.length >= threshold && !dedupedSet.has(`${c.index}:${c.subIndex}`))

  if (toProcess.length === 0) return [msgs, emptySavings(false, detSaved, readDedupSaved, detMs)]

  // Circuit breaker: skip AI compression entirely if backend is down
  if (!circuitBreaker.shouldAllow()) {
    console.log(`[squeezr] Circuit breaker open — skipping AI compression for ${toProcess.length} block(s)`)
    return [msgs, emptySavings(false, detSaved, readDedupSaved, detMs)]
  }

  if (config.dryRun) {
    const potential = toProcess.reduce((sum, c) => sum + c.text.length, 0)
    console.log(`[squeezr dry-run] Would AI-compress ${toProcess.length} block(s) | potential -${potential.toLocaleString()} chars | pressure=${Math.round(pressure * 100)}%`)
    return [msgs, emptySavings(true, detSaved, readDedupSaved, detMs)]
  }

  // Differential: split session cache hits from uncached
  const sessionHits: Array<{ index: number; subIndex: number; tool: string; block: SessionBlock }> = []
  const toCompress: Array<{ index: number; subIndex: number; text: string; tool: string }> = []
  const lastMsgIdx = messages.length - 1
  for (const c of toProcess) {
    const cached = getBlock(hashText(c.text))
    if (cached) {
      sessionHits.push({ index: c.index, subIndex: c.subIndex, tool: c.tool, block: cached })
    } else if (aiEnabled() && c.index === lastMsgIdx && !config.aiSkipTools.has(c.tool.toLowerCase())) {
      // Only AI-compress genuinely new blocks (from the last user message).
      // Historical uncached blocks skip AI compression → prevents burst on first activation.
      toCompress.push(c)
    }
  }

  const aiT0 = Date.now()
  const defaultFn: CompressFn = (t) => compressWithHaiku(t, apiKey)
  const fn = getEffectiveCompressFn(defaultFn, config)
  const freshlyCompressed = toCompress.length > 0
    ? await runCompression(toCompress, fn, config)
    : []
  const aiMs = Date.now() - aiT0

  let totalOriginal = 0
  let totalCompressed = 0
  let totalOverhead = 0
  let totalAiSaved = 0
  const byTool: Savings['byTool'] = []

  for (const { index, subIndex, tool, block } of sessionHits) {
    ;(msgs[index].content as Array<{ content?: unknown }>)[subIndex].content = block.fullString
    totalOriginal += block.originalChars
    totalCompressed += block.originalChars - block.savedChars
    totalAiSaved += block.savedChars
    byTool.push({ tool, savedChars: block.savedChars, originalChars: block.originalChars })
  }

  for (const { index, subIndex, original, result, tool } of freshlyCompressed) {
    const { fullString, savedChars, overheadChars } = buildAndCache(original, result)
    ;(msgs[index].content as Array<{ content?: unknown }>)[subIndex!].content = fullString
    totalOriginal += original.length
    totalCompressed += original.length - savedChars
    totalOverhead += overheadChars
    totalAiSaved += savedChars
    byTool.push({ tool, savedChars, originalChars: original.length })
  }

  if (pressure >= 0.5) console.log(`[squeezr] Context pressure: ${Math.round(pressure * 100)}% → threshold=${threshold} chars`)
  if (sessionHits.length > 0) console.log(`[squeezr] Session cache: ${sessionHits.length} block(s) reused (KV cache preserved)`)

  return [msgs, {
    compressed: freshlyCompressed.length,
    savedChars: totalOriginal - totalCompressed,
    originalChars: totalOriginal,
    byTool,
    dryRun: false,
    sessionCacheHits: sessionHits.length,
    detSavedChars: detSaved,
    dedupSavedChars: readDedupSaved,
    aiSavedChars: totalAiSaved,
    overheadChars: totalOverhead,
    detMs,
    aiMs,
  }]
}

// ── OpenAI format ─────────────────────────────────────────────────────────────

interface OpenAIMessage {
  role: string
  content?: string | null
  tool_call_id?: string
  tool_calls?: Array<{ id: string; function: { name: string } }>
}

function extractOpenAIToolResults(messages: OpenAIMessage[]): Array<{ index: number; text: string; tool: string; skip: boolean }> {
  const nameMap = new Map<string, string>()
  const skipCallIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const tc of msg.tool_calls ?? []) {
      nameMap.set(tc.id, tc.function.name)
      if (/squeezr:\s*skip/i.test((tc.function as Record<string, unknown>).arguments as string ?? '')) skipCallIds.add(tc.id)
    }
  }
  const results = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'tool' || !msg.content) continue
    const text = typeof msg.content === 'string' ? msg.content : ''
    const callId = msg.tool_call_id ?? ''
    if (text) results.push({ index: i, text, tool: nameMap.get(callId) ?? 'unknown', skip: skipCallIds.has(callId) })
  }
  return results
}

export async function compressOpenAIMessages(
  messages: OpenAIMessage[],
  apiKey: string,
  config: Config,
  isLocal = false,
): Promise<[OpenAIMessage[], Savings]> {
  if (config.disabled) return [messages, emptySavings()]

  const pressure = estimatePressure(messages)
  const threshold = effectiveThreshold(config, pressure)
  const allResults = extractOpenAIToolResults(messages)
    .filter(r => !r.skip && !config.shouldSkipTool(r.tool))

  if (allResults.length === 0) return [messages, emptySavings()]

  const msgs = structuredClone(messages) as OpenAIMessage[]

  // Step 0: Cross-turn dedup (Read / Bash / Grep) — see compressAnthropicMessages for details
  const dedupedIndices = new Set<number>()
  let readDedupSaved = 0
  const OAI_DEDUP_TOOLS: Record<string, string> = {
    read: 'file content as a later read',
    bash: 'bash output as a later call',
    grep: 'grep result as a later search',
  }
  {
    const hashToId = new Map<string, string>()
    const seenMostRecent = new Set<string>()
    let dedupCount = 0
    for (let i = allResults.length - 1; i >= 0; i--) {
      const { index, text, tool } = allResults[i]
      const toolLower = tool.toLowerCase()
      const label = OAI_DEDUP_TOOLS[toolLower]
      if (!label) continue
      if (text.length < 200) continue
      const hash = hashText(text)
      if (!seenMostRecent.has(hash)) {
        seenMostRecent.add(hash); hashToId.set(hash, storeOriginal(text))
      } else {
        msgs[index].content = `[same ${label} in conversation — squeezr_expand(${hashToId.get(hash)}) to retrieve]`
        dedupedIndices.add(index); dedupCount++; readDedupSaved += text.length
      }
    }
    if (readDedupSaved > 0) {
      console.log(`[squeezr/dedup] ${dedupCount} duplicate tool output(s) collapsed: -${readDedupSaved.toLocaleString()} chars`)
      hitPattern('readDedup', dedupCount)
    }
  }

  // Step 1: Deterministic preprocessing on ALL tool results
  const oaiDetT0 = Date.now()
  let detSaved = 0
  for (const { index, text, tool } of allResults) {
    if (dedupedIndices.has(index)) continue
    const det = preprocessForTool(text, tool, pressure)
    if (det !== text) {
      msgs[index].content = det
      detSaved += text.length - det.length
    }
  }
  const oaiDetMs = Date.now() - oaiDetT0
  if (detSaved > 0) {
    const tag = isLocal ? 'ollama' : 'codex'
    console.log(`[squeezr/det/${tag}] Deterministic: -${detSaved.toLocaleString()} chars across ${allResults.length} block(s)`)
  }

  // Step 1.5: Deterministic on user/assistant prose messages (skip last user msg)
  if (config.compressConversation) {
    const minLen = config.assistantThreshold
    // Last user-role message index — never touch it
    let lastUserIdx = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if ((msgs[i] as OpenAIMessage).role === 'user') { lastUserIdx = i; break }
    }
    let proseSaved = 0
    let proseCount = 0
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i] as OpenAIMessage
      if (m.role !== 'user' && m.role !== 'assistant') continue
      if (i === lastUserIdx) continue
      if (typeof m.content !== 'string') continue
      if (!m.content || m.content.length < minLen) continue
      const det = preprocessAssistant(m.content)
      if (det.length < m.content.length) {
        proseSaved += m.content.length - det.length
        proseCount++
        m.content = det
      }
    }
    if (proseSaved > 0) {
      const tag = isLocal ? 'ollama' : 'codex'
      const tokens = Math.round(proseSaved / 3.5)
      console.log(`[squeezr/prose-det/${tag}] Prose deterministic: -${proseSaved.toLocaleString()} chars (~${tokens} tokens) across ${proseCount} message(s)`)
      detSaved += proseSaved
    }
  }

  // Step 2: AI compression for old blocks above threshold
  const candidates = allResults.slice(0, Math.max(0, allResults.length - effectiveKeepRecent(config)))
  const toProcess = candidates.filter(c => c.text.length >= threshold && !dedupedIndices.has(c.index))

  if (toProcess.length === 0) return [msgs, emptySavings(false, detSaved, readDedupSaved, oaiDetMs)]

  // Circuit breaker: skip AI compression entirely if backend is down
  if (!circuitBreaker.shouldAllow()) {
    console.log(`[squeezr] Circuit breaker open — skipping AI compression for ${toProcess.length} block(s)`)
    return [msgs, emptySavings(false, detSaved, readDedupSaved, oaiDetMs)]
  }

  if (config.dryRun) {
    const tag = isLocal ? 'ollama' : 'codex'
    console.log(`[squeezr dry-run/${tag}] Would AI-compress ${toProcess.length} block(s) | potential -${toProcess.reduce((s, c) => s + c.text.length, 0).toLocaleString()} chars`)
    return [msgs, emptySavings(true, detSaved, readDedupSaved, oaiDetMs)]
  }

  const sessionHits: Array<{ index: number; tool: string; block: SessionBlock }> = []
  const toCompress: Array<{ index: number; text: string; tool: string }> = []
  const lastOAIMsgIdx = messages.length - 1
  const lastAssistantIdx = (messages as Array<{ role: string }>).reduce(
    (best, m, i) => (m.role === 'assistant' ? i : best), -1)
  const newStartIdx = lastAssistantIdx >= 0 ? lastAssistantIdx : lastOAIMsgIdx
  for (const c of toProcess) {
    const cached = getBlock(hashText(c.text))
    if (cached) {
      sessionHits.push({ index: c.index, tool: c.tool, block: cached })
    } else if (aiEnabled() && c.index > newStartIdx && !config.aiSkipTools.has(c.tool.toLowerCase())) {
      toCompress.push(c)
    }
  }

  const defaultFn: CompressFn = isLocal
    ? t => compressWithOllama(t, config.localUpstreamUrl, config.localCompressionModel)
    : t => compressWithGptMini(t, apiKey)
  const compressFn = getEffectiveCompressFn(defaultFn, config)

  const oaiAiT0 = Date.now()
  const freshlyCompressed = toCompress.length > 0
    ? await runCompression(toCompress, compressFn, config)
    : []
  const oaiAiMs = Date.now() - oaiAiT0

  let totalOriginal = 0, totalCompressed = 0, totalOverhead = 0, totalAiSaved = 0
  const byTool: Savings['byTool'] = []

  for (const { index, tool, block } of sessionHits) {
    msgs[index].content = block.fullString
    totalOriginal += block.originalChars
    totalCompressed += block.originalChars - block.savedChars
    totalAiSaved += block.savedChars
    byTool.push({ tool, savedChars: block.savedChars, originalChars: block.originalChars })
  }

  for (const { index, original, result, tool } of freshlyCompressed) {
    const { fullString, savedChars, overheadChars } = buildAndCache(original, result)
    msgs[index].content = fullString
    totalOriginal += original.length
    totalCompressed += original.length - savedChars
    totalOverhead += overheadChars
    totalAiSaved += savedChars
    byTool.push({ tool, savedChars, originalChars: original.length })
  }

  if (pressure >= 0.5) {
    const tag = isLocal ? 'ollama' : 'codex'
    console.log(`[squeezr/${tag}] Context pressure: ${Math.round(pressure * 100)}% → threshold=${threshold} chars`)
  }
  if (sessionHits.length > 0) console.log(`[squeezr] Session cache: ${sessionHits.length} block(s) reused`)

  return [msgs, { compressed: freshlyCompressed.length, savedChars: totalOriginal - totalCompressed, originalChars: totalOriginal, byTool, dryRun: false, sessionCacheHits: sessionHits.length, detSavedChars: detSaved, dedupSavedChars: readDedupSaved, aiSavedChars: totalAiSaved, overheadChars: totalOverhead, detMs: oaiDetMs, aiMs: oaiAiMs }]
}

// ── Gemini format ─────────────────────────────────────────────────────────────

interface GeminiContent {
  role: string
  parts: Array<{ text?: string; functionCall?: unknown; functionResponse?: { name: string; response: unknown } }>
}

export async function compressGeminiContents(
  contents: GeminiContent[],
  apiKey: string,
  config: Config,
): Promise<[GeminiContent[], Savings]> {
  if (config.disabled) return [contents, emptySavings()]

  const pressure = estimatePressure(contents)
  const threshold = effectiveThreshold(config, pressure)

  const allResults: Array<{ index: number; subIndex: number; text: string; tool: string }> = []
  for (let i = 0; i < contents.length; i++) {
    if (contents[i].role !== 'user') continue
    for (let j = 0; j < contents[i].parts.length; j++) {
      const part = contents[i].parts[j]
      if (!part.functionResponse) continue
      const tool = part.functionResponse.name
      if (config.shouldSkipTool(tool)) continue
      const text = typeof part.functionResponse.response === 'string'
        ? part.functionResponse.response
        : JSON.stringify(part.functionResponse.response)
      if (text.length > 0) allResults.push({ index: i, subIndex: j, text, tool })
    }
  }

  if (allResults.length === 0) return [contents, emptySavings()]

  const cts = structuredClone(contents) as GeminiContent[]

  // Step 0: Cross-turn dedup (Read / Bash / Grep) — see compressAnthropicMessages for details
  const geminiDedupedSet = new Set<string>()
  let geminiReadDedupSaved = 0
  const GEMINI_DEDUP_TOOLS: Record<string, string> = {
    read: 'file content as a later read',
    bash: 'bash output as a later call',
    grep: 'grep result as a later search',
  }
  {
    const hashToId = new Map<string, string>()
    const seenMostRecent = new Set<string>()
    let dedupCount = 0
    for (let i = allResults.length - 1; i >= 0; i--) {
      const { index, subIndex, text, tool } = allResults[i]
      const toolLower = tool.toLowerCase()
      const label = GEMINI_DEDUP_TOOLS[toolLower]
      if (!label) continue
      if (text.length < 200) continue
      const hash = hashText(text)
      if (!seenMostRecent.has(hash)) {
        seenMostRecent.add(hash); hashToId.set(hash, storeOriginal(text))
      } else {
        cts[index].parts[subIndex].functionResponse!.response = { output: `[same ${label} in conversation — squeezr_expand(${hashToId.get(hash)}) to retrieve]` }
        geminiDedupedSet.add(`${index}:${subIndex}`); dedupCount++; geminiReadDedupSaved += text.length
      }
    }
    if (geminiReadDedupSaved > 0) {
      console.log(`[squeezr/dedup/gemini] ${dedupCount} duplicate tool output(s) collapsed: -${geminiReadDedupSaved.toLocaleString()} chars`)
      hitPattern('readDedup', dedupCount)
    }
  }

  // Step 1: Deterministic preprocessing on ALL tool results
  const gemDetT0 = Date.now()
  let detSaved = 0
  for (const { index, subIndex, text, tool } of allResults) {
    if (geminiDedupedSet.has(`${index}:${subIndex}`)) continue
    const det = preprocessForTool(text, tool, pressure)
    if (det !== text) {
      cts[index].parts[subIndex].functionResponse!.response = det
      detSaved += text.length - det.length
    }
  }
  const gemDetMs = Date.now() - gemDetT0
  if (detSaved > 0) console.log(`[squeezr/det/gemini] Deterministic: -${detSaved.toLocaleString()} chars across ${allResults.length} block(s)`)

  // Step 1.5: Deterministic on text parts in user/model messages (skip last user msg)
  if (config.compressConversation) {
    const minLen = config.assistantThreshold
    let lastUserIdx = -1
    for (let i = cts.length - 1; i >= 0; i--) {
      if (cts[i].role === 'user') { lastUserIdx = i; break }
    }
    let proseSaved = 0
    let proseCount = 0
    for (let i = 0; i < cts.length; i++) {
      if (i === lastUserIdx) continue
      const role = cts[i].role
      if (role !== 'user' && role !== 'model') continue
      for (let j = 0; j < cts[i].parts.length; j++) {
        const part = cts[i].parts[j]
        const t = part.text
        if (typeof t !== 'string' || t.length < minLen) continue
        const det = preprocessAssistant(t)
        if (det.length < t.length) {
          proseSaved += t.length - det.length
          proseCount++
          part.text = det
        }
      }
    }
    if (proseSaved > 0) {
      const tokens = Math.round(proseSaved / 3.5)
      console.log(`[squeezr/prose-det/gemini] Prose deterministic: -${proseSaved.toLocaleString()} chars (~${tokens} tokens) across ${proseCount} part(s)`)
      detSaved += proseSaved
    }
  }

  // Step 2: AI compression for old blocks above threshold
  const candidates = allResults.slice(0, Math.max(0, allResults.length - effectiveKeepRecent(config)))
    .filter(c => c.text.length >= threshold && !geminiDedupedSet.has(`${c.index}:${c.subIndex}`))

  if (candidates.length === 0) return [cts, emptySavings(false, detSaved, geminiReadDedupSaved, gemDetMs)]

  // Circuit breaker: skip AI compression entirely if backend is down
  if (!circuitBreaker.shouldAllow()) {
    console.log(`[squeezr] Circuit breaker open — skipping AI compression for ${candidates.length} block(s)`)
    return [cts, emptySavings(false, detSaved, geminiReadDedupSaved, gemDetMs)]
  }

  if (config.dryRun) {
    console.log(`[squeezr dry-run/gemini] Would AI-compress ${candidates.length} block(s) | potential -${candidates.reduce((s, c) => s + c.text.length, 0).toLocaleString()} chars`)
    return [cts, emptySavings(true, detSaved, geminiReadDedupSaved, gemDetMs)]
  }

  const sessionHits: Array<{ index: number; subIndex: number; tool: string; block: SessionBlock }> = []
  const toCompress: Array<{ index: number; subIndex: number; text: string; tool: string }> = []
  for (const c of candidates) {
    const cached = getBlock(hashText(c.text))
    if (cached) sessionHits.push({ index: c.index, subIndex: c.subIndex, tool: c.tool, block: cached })
    else if (aiEnabled()) toCompress.push(c)
  }

  const gemAiT0 = Date.now()
  const gemDefaultFn: CompressFn = (t) => compressWithGeminiFlash(t, apiKey)
  const gemFn = getEffectiveCompressFn(gemDefaultFn, config)
  const freshlyCompressed = toCompress.length > 0
    ? await runCompression(toCompress, gemFn, config)
    : []
  const gemAiMs = Date.now() - gemAiT0

  let totalOriginal = 0, totalCompressed = 0, totalOverhead = 0, totalAiSaved = 0
  const byTool: Savings['byTool'] = []

  for (const { index, subIndex, tool, block } of sessionHits) {
    cts[index].parts[subIndex].functionResponse!.response = { output: block.fullString }
    totalOriginal += block.originalChars
    totalCompressed += block.originalChars - block.savedChars
    totalAiSaved += block.savedChars
    byTool.push({ tool, savedChars: block.savedChars, originalChars: block.originalChars })
  }

  for (const { index, subIndex, original, result, tool } of freshlyCompressed) {
    const { fullString, savedChars, overheadChars } = buildAndCache(original, result)
    cts[index].parts[subIndex!].functionResponse!.response = { output: fullString }
    totalOriginal += original.length
    totalCompressed += original.length - savedChars
    totalOverhead += overheadChars
    totalAiSaved += savedChars
    byTool.push({ tool, savedChars, originalChars: original.length })
  }

  if (sessionHits.length > 0) console.log(`[squeezr/gemini] Session cache: ${sessionHits.length} block(s) reused`)

  return [cts, { compressed: freshlyCompressed.length, savedChars: totalOriginal - totalCompressed, originalChars: totalOriginal, byTool, dryRun: false, sessionCacheHits: sessionHits.length, detSavedChars: detSaved, dedupSavedChars: geminiReadDedupSaved, aiSavedChars: totalAiSaved, overheadChars: totalOverhead, detMs: gemDetMs, aiMs: gemAiMs }]
}

export function emptySavings(dryRun = false, detSavedChars = 0, dedupSavedChars = 0, detMs = 0): Savings {
  return { compressed: 0, savedChars: 0, originalChars: 0, byTool: [], dryRun, sessionCacheHits: 0, detSavedChars, dedupSavedChars, aiSavedChars: 0, overheadChars: 0, detMs, aiMs: 0 }
}
