import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { CompressionCache } from './cache.js'
import { preprocess, preprocessAssistant, preprocessForTool, hitPattern } from './deterministic.js'
import { storeOriginal } from './expand.js'
import { dedupImagesAnthropic } from './imageDedup.js'
import { dedupAttachments } from './attachmentDedup.js'
import { compressRepeatedReads } from './diffRead.js'
import { compressDuplicateToolResults } from './toolResultDedup.js'
import { hashText, getBlock, setBlock, SessionBlock } from './sessionCache.js'
import type { Config } from './config.js'
import { effectiveThreshold, effectiveKeepRecent, effectiveAiMinChars, aiEnabled, effectiveBackend, runtimeOverrides } from './config.js'
import { circuitBreaker } from './circuitBreaker.js'
import { tryConsumeAiCall, _config as _aiRateConfig } from './aiRateLimit.js'
import { isAiCompressionEnabled } from './aiToggle.js'
import { validateCompression } from './compressionGuard.js'
import { looksStructured } from './structuredGuard.js'
import { looksIncompressible } from './compressibilityProbe.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface Savings {
  compressed: number
  savedChars: number
  originalChars: number
  byTool: Array<{ tool: string; savedChars: number; originalChars: number; count?: number }>
  dryRun: boolean
  sessionCacheHits: number
  // Honest breakdown for accurate gain reporting
  detSavedChars?: number       // deterministic preprocessing savings (tool results)
  dedupSavedChars?: number     // read-dedup savings
  aiSavedChars?: number        // AI compression savings (net, after tag overhead)
  overheadChars?: number       // chars added by [squeezr:XXXX] tags
  toolDescSavedChars?: number  // tool description compression savings
  mcpFilterSavedChars?: number // MCP tool filtering savings
  staleTurnsSavedChars?: number // stale turn summarization savings
  skillDedupSavedChars?: number // skill/plugin block dedup savings (system prompt pre-pass)
  syspromptSavedChars?: number // system prompt Haiku compression savings
  localAiCalls?: number        // local AI (Zest) calls — free, no cloud cost
  localAiSavedChars?: number   // chars saved by local AI (Zest)
  // Compression EFFICIENCY denominator: original size of the content we actually
  // ran compression on (tool results), so the dashboard can show savings as a % of
  // what we targeted — not diluted by recent/kept/uncompressible payload.
  compressibleOriginalChars?: number
  // Non-cached (full-price) tail accounting: original + saved on the content AFTER
  // the prompt-cache barrier. Lets the dashboard show the compression % over the
  // tokens actually billed at full price (excludes the cheap cached prefix).
  nonCachedOriginalChars?: number
  nonCachedSavedChars?: number
  // Latency tracking (ms)
  detMs?: number               // deterministic preprocessing time
  aiMs?: number                // AI compression time
}

const COMPRESS_PROMPT =
  'You compress a coding tool output to save tokens WHILE preserving every fact ' +
  'needed to act on it. Rules:\n' +
  '1. Keep VERBATIM and complete (never paraphrase, abbreviate, or omit): file paths, ' +
  'URLs, error/exception names and codes, line numbers, identifiers (function/class/' +
  'variable names), numeric values, and quoted strings.\n' +
  '2. Remove only redundancy: repeated/duplicate lines, boilerplate, filler prose, ' +
  'decorative formatting, and obvious padding.\n' +
  '3. Keep one item per line; preserve the original order.\n' +
  'If almost everything is essential (e.g. many distinct paths), return it nearly ' +
  'unchanged rather than dropping items. Output ONLY the compressed text.'

// ── Sizing helpers (shared by every compression backend) ──────────────────────
const CHARS_PER_TOK = 3.5
// Output budget scaled to input size so large blocks aren't truncated to a stub
// (the old fixed 300-token cap silently cut summaries of big tool outputs short).
// Target ~35% of the input as the compressed summary, clamped to a sane range.
function scaledNumPredict(inputChars: number): number {
  const t = Math.round((inputChars / CHARS_PER_TOK) * 0.35)
  return Math.max(200, Math.min(1024, t))
}
// Max input chars we send to Ollama in ONE call. With num_ctx=4096 and ~3.5
// chars/token, the prompt + input must fit the context; ~13000 chars leaves room
// for the system prompt and the generated summary.
const OLLAMA_NUM_CTX = 4096
const OLLAMA_SAFE_INPUT = 13000
// Never chunk beyond this — past it, deterministic compression is the safe choice
// (chunking too many pieces defeats the savings and risks join artifacts).
const OLLAMA_MAX_CHUNKS = 4

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

// ── AI usage tracking (session) ───────────────────────────────────────────────
// Real token spend of the compression calls themselves — shown in the dashboard
// "AI Compression" card so the user sees cost vs. benefit of the AI layer.
export const aiUsageCounters = { calls: 0, inputTokens: 0, outputTokens: 0 }
// Local (Zest/Ollama) usage tracked separately — local calls are FREE so their
// token counts should NOT appear in the "cost" column of the AI Compression card.
// Savings are still counted in the normal savedChars pipeline.
export const localAiUsageCounters = { calls: 0, inputTokens: 0, outputTokens: 0 }
// Quality guardrail outcomes this proxy session — how many AI results were
// accepted vs rejected (low ratio / dropped key tokens). Surfaced on the dashboard.
export const compressionGuardCounters = { accepted: 0, rejected: 0, retriedOk: 0 }
// Per-compression-model spend — so the dashboard "By Model" section can show
// what each compression backend (Haiku, GPT-mini, etc.) actually costs in tokens.
export const aiUsageByModel: Record<string, { calls: number; inputTokens: number; outputTokens: number }> = {}
// TODAY's AI usage (local calendar day) — so the AI Compression card matches the
// today-scoped Overview hero instead of mixing all-time AI with today totals.
// Persisted with the rest of ai-usage.json; resets when the local date rolls over.
export const aiUsageToday = {
  date: '', cloudCalls: 0, cloudInputTokens: 0, cloudOutputTokens: 0,
  localCalls: 0, localInputTokens: 0, localOutputTokens: 0,
}
function rollAiUsageToday(): void {
  const k = new Date().toLocaleDateString('en-CA')
  if (aiUsageToday.date !== k) {
    aiUsageToday.date = k
    aiUsageToday.cloudCalls = 0; aiUsageToday.cloudInputTokens = 0; aiUsageToday.cloudOutputTokens = 0
    aiUsageToday.localCalls = 0; aiUsageToday.localInputTokens = 0; aiUsageToday.localOutputTokens = 0
  }
}
// Compression model IDs — single source of truth. Used both for the API call and
// as the fallback label if the response doesn't echo back its model name.
const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const GPT_MINI_MODEL = 'gpt-4o-mini'
const GEMINI_FLASH_MODEL = 'gemini-1.5-flash-8b'
// ── AI usage persistence ──────────────────────────────────────────────────────
// The AI Compression card (calls / spent) and By-Model cost used to reset to 0 on
// restart because these counters were in-memory only. Persist them to disk and
// reload at startup so the dashboard shows cumulative all-time usage.
const AI_USAGE_FILE = join(homedir(), '.squeezr', 'ai-usage.json')
function loadAiUsage(): void {
  try {
    if (!existsSync(AI_USAGE_FILE)) return
    const d = JSON.parse(readFileSync(AI_USAGE_FILE, 'utf-8')) as {
      cloud?: typeof aiUsageCounters; local?: typeof localAiUsageCounters
      byModel?: typeof aiUsageByModel; today?: typeof aiUsageToday
    }
    if (d.cloud) Object.assign(aiUsageCounters, d.cloud)
    if (d.local) Object.assign(localAiUsageCounters, d.local)
    if (d.byModel) for (const [k, v] of Object.entries(d.byModel)) aiUsageByModel[k] = v
    if (d.today) Object.assign(aiUsageToday, d.today)
  } catch { /* ignore */ }
}
function persistAiUsage(): void {
  try {
    const dir = join(homedir(), '.squeezr')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = AI_USAGE_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify({ cloud: aiUsageCounters, local: localAiUsageCounters, byModel: aiUsageByModel, today: aiUsageToday }))
    renameSync(tmp, AI_USAGE_FILE)
  } catch { /* ignore */ }
}
loadAiUsage()
function recordAiUsage(model: string, inputTokens: number, outputTokens: number): void {
  const isLocal = model.startsWith('local:')
  rollAiUsageToday()
  if (isLocal) {
    // Local models (Zest/Ollama) are free — track calls but NOT in cost counters
    localAiUsageCounters.calls++
    localAiUsageCounters.inputTokens += inputTokens
    localAiUsageCounters.outputTokens += outputTokens
    aiUsageToday.localCalls++
    aiUsageToday.localInputTokens += inputTokens
    aiUsageToday.localOutputTokens += outputTokens
  } else {
    // Cloud models (Haiku/GPT/Gemini) — track in cost counters
    aiUsageCounters.calls++
    aiUsageCounters.inputTokens += inputTokens
    aiUsageCounters.outputTokens += outputTokens
    aiUsageToday.cloudCalls++
    aiUsageToday.cloudInputTokens += inputTokens
    aiUsageToday.cloudOutputTokens += outputTokens
  }
  if (!aiUsageByModel[model]) aiUsageByModel[model] = { calls: 0, inputTokens: 0, outputTokens: 0 }
  aiUsageByModel[model].calls++
  aiUsageByModel[model].inputTokens += inputTokens
  aiUsageByModel[model].outputTokens += outputTokens
  persistAiUsage()
}
/**
 * True when the Anthropic credential is a Claude Code / Claude Desktop OAuth
 * subscription token (sk-ant-oat...) or any non-`sk-` bearer. A Haiku compression
 * call made with such a token bills against the user's OWN 5h plan quota — it burns
 * the plan instead of saving it. We must NEVER auto-route compression to Haiku on
 * these keys; only an explicit, billed API key (sk-ant-api...) is safe for Haiku.
 */
export function isOAuthSubscriptionKey(apiKey: string): boolean {
  return apiKey.startsWith('sk-ant-oat') || !apiKey.startsWith('sk-')
}
// Build the compression prompt, optionally with a correction appended (used by the
// guardrail's retry: tells the model exactly which tokens it must NOT drop).
function promptWith(extra?: string): string {
  return extra ? `${COMPRESS_PROMPT}\n${extra}` : COMPRESS_PROMPT
}

async function compressWithHaiku(text: string, apiKey: string, extra?: string): Promise<string> {
  // apiKey can be a real API key (sk-ant-api...), a Claude Code OAuth access
  // token (sk-ant-oat...), or another bearer token. OAuth tokens MUST go as
  // Authorization: Bearer + the oauth beta header — sent as x-api-key they 401.
  const isOAuth = isOAuthSubscriptionKey(apiKey)
  const authOpts = isOAuth ? { authToken: apiKey } : { apiKey }
  const oauthHeaders = isOAuth ? { 'anthropic-beta': 'oauth-2025-04-20' } : undefined
  // Force real API URL — ANTHROPIC_BASE_URL points to this proxy, which would cause
  // infinite recursion if we let the SDK inherit it from the environment.
  const client = new Anthropic({ ...authOpts, baseURL: 'https://api.anthropic.com', defaultHeaders: oauthHeaders })
  const input = text.slice(0, OLLAMA_SAFE_INPUT)
  const resp = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: scaledNumPredict(input.length),
    messages: [{ role: 'user', content: `${promptWith(extra)}\n\n---\n${input}` }],
  })
  // Model name comes from the response, not a literal — survives model upgrades
  recordAiUsage(resp.model ?? HAIKU_MODEL, resp.usage?.input_tokens ?? 0, resp.usage?.output_tokens ?? 0)
  return (resp.content[0] as { text: string }).text
}

async function compressWithGptMini(text: string, apiKey: string, extra?: string): Promise<string> {
  // apiKey can be a real key (sk-...) or an OAuth bearer token
  // Force real API URL — openai_base_url points to this proxy, which would cause
  // infinite recursion if we let the SDK inherit it from the environment.
  const client = new OpenAI({ apiKey, baseURL: 'https://api.openai.com/v1' })
  const input = text.slice(0, OLLAMA_SAFE_INPUT)
  const resp = await client.chat.completions.create({
    model: GPT_MINI_MODEL,
    max_tokens: scaledNumPredict(input.length),
    messages: [{ role: 'user', content: `${promptWith(extra)}\n\n---\n${input}` }],
  })
  recordAiUsage(resp.model ?? GPT_MINI_MODEL, resp.usage?.prompt_tokens ?? 0, resp.usage?.completion_tokens ?? 0)
  return resp.choices[0].message.content ?? ''
}

async function compressWithGeminiFlash(text: string, apiKey: string, extra?: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH_MODEL}:generateContent?key=${apiKey}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${promptWith(extra)}\n\n---\n${text.slice(0, OLLAMA_SAFE_INPUT)}` }] }],
    }),
  })
  const data = (await resp.json()) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    modelVersion?: string
  }
  recordAiUsage(data.modelVersion ?? GEMINI_FLASH_MODEL, data.usageMetadata?.promptTokenCount ?? 0, data.usageMetadata?.candidatesTokenCount ?? 0)
  return data.candidates[0].content.parts[0].text
}

// One Ollama call over a single chunk that already fits the context window.
async function ollamaCompressChunk(chunk: string, baseUrl: string, model: string, extra?: string): Promise<string> {
  const base = baseUrl.replace(/\/$/, '')
  // Use Ollama's native API (/api/chat) instead of the OpenAI-compat endpoint so we
  // can pass think:false — Qwen3.5 has thinking mode enabled by default and the OpenAI
  // compat endpoint doesn't expose this flag. Without think:false the model wastes
  // 2000-5000 tokens on internal reasoning before outputting the compression.
  const nativeUrl = `${base}/api/chat`
  const body = {
    model,
    stream: false,
    think: false,
    options: { temperature: 0, top_p: 1, top_k: 1, num_predict: scaledNumPredict(chunk.length), num_ctx: OLLAMA_NUM_CTX },
    messages: [{ role: 'user', content: `${promptWith(extra)}\n\n---\n${chunk}` }],
  }
  const response = await fetch(nativeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Ollama API error: ${response.status}`)
  const data = await response.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number }
  recordAiUsage(`local:${model}`, data.prompt_eval_count ?? 0, data.eval_count ?? 0)
  return data.message?.content ?? ''
}

// Split text into <= maxChars pieces on line boundaries (never mid-line), so a
// chunk boundary can't bisect a path/stack-frame/JSON line. Exported for tests.
export function splitOnLines(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const lines = text.split('\n')
  const chunks: string[] = []
  let cur = ''
  for (const line of lines) {
    if (cur.length + line.length + 1 > maxChars && cur.length > 0) {
      chunks.push(cur)
      cur = ''
    }
    // A single line longer than maxChars: hard-split it (rare; huge minified blobs).
    if (line.length > maxChars) {
      for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars))
      continue
    }
    cur += (cur ? '\n' : '') + line
  }
  if (cur) chunks.push(cur)
  return chunks
}

// Compress a tool-result block of ANY size with the local model. Unlike the old
// implementation (which sliced to 4000 chars and silently dropped the rest while
// REPLACING the whole block), this represents the ENTIRE block:
//  - block <= SAFE_INPUT  → one call over the whole block
//  - block  > SAFE_INPUT  → split on line boundaries (<= MAX_CHUNKS) and join
//  - too big to chunk safely → return the original (deterministic stays applied)
export async function compressLargeText(text: string, baseUrl: string, model: string, extra?: string): Promise<string> {
  if (text.length <= OLLAMA_SAFE_INPUT) {
    return ollamaCompressChunk(text, baseUrl, model, extra)
  }
  const chunks = splitOnLines(text, OLLAMA_SAFE_INPUT)
  if (chunks.length > OLLAMA_MAX_CHUNKS) {
    // Past our safe chunk budget: don't risk a lossy/expensive multi-call join.
    // Return the original — deterministic compression already ran on it upstream.
    return text
  }
  const parts: string[] = []
  for (const chunk of chunks) {
    try {
      parts.push(await ollamaCompressChunk(chunk, baseUrl, model, extra))
    } catch {
      // A failed chunk → keep that chunk's original text rather than a partial join.
      parts.push(chunk)
    }
  }
  return parts.join('\n')
}

// ── AI compression orchestrator ───────────────────────────────────────────────

// Optional `extra` = correction instruction appended to the prompt (guardrail retry).
type CompressFn = (text: string, extra?: string) => Promise<string>

/**
 * Resolve which compression backend to actually use based on the runtime override.
 *
 * - 'auto'         → use the default backend for this API (the `defaultFn` passed in)
 * - 'local'        → use Ollama / Zest (zest-0.8b) (always local, no API call)
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
    return (text: string, extra?: string) => compressLargeText(text, config.localUpstreamUrl, config.localCompressionModel, extra)
  }
  // Cross-backend usage: need a key. Lazy-loaded to avoid circular import.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { storedKey } = require('./limits.js') as typeof import('./limits.js')
  if (backend === 'haiku') {
    const k = storedKey('anthropic')
    if (!k) { console.log('[squeezr] backend=haiku but no anthropic key seen yet — fallback to auto'); return defaultFn }
    return (text: string, extra?: string) => compressWithHaiku(text, k, extra)
  }
  if (backend === 'gpt-mini') {
    const k = storedKey('openai')
    if (!k) { console.log('[squeezr] backend=gpt-mini but no openai key seen yet — fallback to auto'); return defaultFn }
    return (text: string, extra?: string) => compressWithGptMini(text, k, extra)
  }
  if (backend === 'gemini-flash') {
    const k = storedKey('gemini')
    if (!k) { console.log('[squeezr] backend=gemini-flash but no gemini key seen yet — fallback to auto'); return defaultFn }
    return (text: string, extra?: string) => compressWithGeminiFlash(text, k, extra)
  }
  return defaultFn
}

// Local (Zest/Ollama) backends are FREE and run on the user's machine: a cold
// model load + a long generation easily exceeds the 5s cloud timeout, and the
// 20/5min rate limit (built to cap Haiku COST) only starves free local compression.
// So for local we use a generous timeout and skip the rate limit entirely.
// 15s balances "don't time out on a cold model load + generation" (the 5s cloud
// default tripped the circuit breaker → AI compression died) against added request
// latency (compression is inline). Measured Zest: ~0.9s hot, ~3.3s cold. Configurable.
const LOCAL_CALL_TIMEOUT_MS = Number(process.env.SQUEEZR_LOCAL_TIMEOUT_MS) || 15_000

async function runCompression(
  items: Array<{ index: number; subIndex?: number; text: string; tool: string }>,
  compressFn: CompressFn,
  config: Config,
  isLocal = false,
): Promise<Array<{ index: number; subIndex?: number; original: string; result: string; tool: string }>> {
  const cache = getCache(config)
  const callTimeout = isLocal ? LOCAL_CALL_TIMEOUT_MS : undefined
  let rateLimited = 0
  const processItem = async (item: { index: number; subIndex?: number; text: string; tool: string }) => {
      const preprocessed = preprocess(item.text)
      if (config.cacheEnabled) {
        const cached = cache.get(preprocessed)
        if (cached) return { ...item, original: item.text, result: cached }
      }
      // Hard rate limit: a cache miss means a real API call — gate it (CLOUD ONLY;
      // the limit exists to cap Haiku spend). Local Zest is free → never throttled.
      if (!isLocal && !tryConsumeAiCall()) { rateLimited++; throw new Error('ai-rate-limited') }
      let compressed = await circuitBreaker.call(() => compressFn(preprocessed), callTimeout)
      // QUALITY GUARDRAIL: reject results that don't save enough or that dropped a
      // critical token (path/URL/error code) or too many key tokens. A rejected
      // block is left in its deterministic-only form (never cached, never used).
      let guard = validateCompression(item.text, compressed)
      // RETRY-WITH-CORRECTION: instead of just rejecting a result that dropped
      // critical tokens, give the model a second shot telling it EXACTLY which
      // tokens it must keep verbatim. Turns many rejects into accepts → more real
      // savings. Only one retry (bounded cost), and only for the dropped-token case.
      if (!guard.accept && guard.lostHard && guard.lostHard.length > 0 && (isLocal || tryConsumeAiCall())) {
        const must = guard.lostHard.slice(0, 25).join(', ')
        const correction = `CRITICAL: your previous output OMITTED these tokens, which MUST appear verbatim in the result: ${must}. Redo the compression of the SAME input keeping every one of them, plus all other paths/URLs/error codes/identifiers.`
        const retry = await circuitBreaker.call(() => compressFn(preprocessed, correction), callTimeout)
        const retryGuard = validateCompression(item.text, retry)
        if (retryGuard.accept) { compressed = retry; guard = retryGuard; compressionGuardCounters.retriedOk++ }
      }
      if (!guard.accept) {
        compressionGuardCounters.rejected++
        throw new Error('guard-rejected')
      }
      compressionGuardCounters.accepted++
      if (config.cacheEnabled) cache.set(preprocessed, compressed)
      return { ...item, original: item.text, result: compressed }
  }
  // Local (Ollama) serialises requests anyway — running them SEQUENTIALLY means
  // each block's timeout clock counts only its own call, not the queue wait behind
  // siblings (which was causing false "timeout" → circuit-breaker trips). Cloud
  // backends are genuinely concurrent, so keep them parallel.
  let results: PromiseSettledResult<Awaited<ReturnType<typeof processItem>>>[]
  if (isLocal) {
    results = []
    for (const item of items) {
      try { results.push({ status: 'fulfilled', value: await processItem(item) }) }
      catch (reason) { results.push({ status: 'rejected', reason } as PromiseRejectedResult) }
    }
  } else {
    results = await Promise.allSettled(items.map(processItem))
  }
  if (rateLimited > 0) {
    console.log(`[squeezr] AI rate limit hit — ${rateLimited} block(s) left uncompressed this window (max ${_aiRateConfig.MAX_CALLS_PER_WINDOW}/${_aiRateConfig.WINDOW_MS / 60000}min). Deterministic compression still applied.`)
  }
  const guardRejected = results.filter(r => r.status === 'rejected' && (r as PromiseRejectedResult).reason?.message === 'guard-rejected').length
  if (guardRejected > 0) {
    console.log(`[squeezr/guard] ${guardRejected} AI compression(s) rejected (low ratio or dropped key tokens) — kept deterministic form`)
  }
  // 'guard-rejected' and 'ai-rate-limited' are intentional skips, not backend failures.
  const failures = results.filter(r => r.status === 'rejected'
    && (r as PromiseRejectedResult).reason?.message !== 'ai-rate-limited'
    && (r as PromiseRejectedResult).reason?.message !== 'guard-rejected').length
  if (failures > 0) {
    const firstErr = (results.find(r => r.status === 'rejected'
      && (r as PromiseRejectedResult).reason?.message !== 'ai-rate-limited'
      && (r as PromiseRejectedResult).reason?.message !== 'guard-rejected') as PromiseRejectedResult | undefined)?.reason
    console.log(`[squeezr] ${failures} AI compression(s) failed (circuit: ${circuitBreaker.getState()}): ${firstErr}`)
  }
  return results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => (r as PromiseFulfilledResult<{ index: number; subIndex?: number; original: string; result: string; tool: string }>).value)
}

// ── Session cache helper ──────────────────────────────────────────────────────

function buildAndCache(original: string, result: string): { fullString: string; savedChars: number; overheadChars: number } {
  const ratio = Math.round((1 - result.length / Math.max(original.length, 1)) * 100)
  const id = storeOriginal(original)
  // Self-instructing marker: the breadcrumb at the point of use. Names the verb and
  // repeats the ID so the model can call expand directly. Still starts with
  // `[squeezr:` so toolResultDedup's already-compressed guard keeps matching.
  const fullString = `[squeezr:${id} -${ratio}% — squeezr_expand("${id}") for full exact text] ${result}`
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

// Index of the LAST message that carries a cache_control marker. Everything at
// this index or earlier is part of Anthropic's cached prefix — mutating it
// invalidates the cache and makes the whole prefix re-bill at full price (the
// 2026-06-04 incident: a 180K-token conversation re-billed every turn). We never
// touch messages at or before this barrier. Returns -1 when there's no cache
// marker (short conversations / clients without caching) → compress freely.
function lastCacheControlMessageIndex(messages: AnthropicMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content
    if (!Array.isArray(c)) continue
    for (const blk of c) {
      if (blk && typeof blk === 'object' && (blk as { cache_control?: unknown }).cache_control) return i
    }
  }
  return -1
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
  // When cache markers are present: use a FIXED threshold (ignore pressure-adaptive).
  // Adaptive threshold changes between requests as the context grows → different blocks
  // get compressed → cache prefix differs → Anthropic prompt cache invalidated.
  // With cache markers we must be byte-stable: always use the normal-mode threshold (800).
  const cacheBarrierEarly = lastCacheControlMessageIndex(messages)
  const threshold = cacheBarrierEarly >= 0
    ? (runtimeOverrides.threshold ?? config.adaptiveMid)  // fixed 800 when cached
    : effectiveThreshold(config, pressure)                 // adaptive only when no cache
  const { nameMap: toolIdMap, skipIds } = buildAnthropicToolIdMap(messages)
  // Cache barrier: never compress messages at or before the last cache_control
  // marker — doing so invalidates Anthropic's prompt cache and re-bills the whole
  // prefix at full price. -1 = no cache markers, compress everything.
const cacheBarrier = cacheBarrierEarly  // reuse value computed above
  const hasCacheMarkers = cacheBarrier >= 0
  // Non-cached (full-price) tail = messages AFTER the cache barrier. The cached
  // prefix is billed at 0.1x by Anthropic and we deliberately don't compress it, so
  // it shouldn't count against our compression ratio. We measure the tail's size
  // BEFORE compression here and AFTER at the return → honest "% on full-price content"
  // (no double-count: it's a real before/after of the same region).
  const tailStart = cacheBarrier + 1 // 0 when no markers → whole conversation is full-price
  const tailChars = (ms: AnthropicMessage[]): number => {
    let n = 0
    for (let i = Math.max(0, tailStart); i < ms.length; i++) {
      const c = ms[i].content
      n += typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length
    }
    return n
  }
  const nonCachedOriginalChars = tailChars(messages)
  const allResults = extractAnthropicToolResults(messages, toolIdMap)
    .filter(r => !skipIds.has(r.toolUseId) && !config.shouldSkipTool(r.tool))
  // NOTE: we do NOT filter allResults by the barrier. Deterministic compression
  // (Step 1) is applied to the whole history with a FIXED pressure so its output
  // is byte-stable between requests → the cached prefix stays identical → cache
  // hits. The UNSTABLE passes (cross-turn/image/attachment/diff dedup, AI) are the
  // ones that must respect the barrier; they're gated individually below.

  if (allResults.length === 0) return [messages, emptySavings()]

// Clone once — all modifications go here
  const msgs = structuredClone(messages) as AnthropicMessage[]
  // These dedup passes MOVE/REPLACE content (the "kept" occurrence shifts as new
  // duplicates arrive) → not byte-stable between requests → they'd invalidate the
  // prompt cache. So when Claude Code is using the cache (markers present), we skip
  // them entirely. Without cache markers they run freely (max compression).
  // Note: cached content is already cheap via cache-read, so not deduping it costs
  // almost nothing; deduping it would re-bill the whole prefix.
  const ZERO_DEDUP = { savedChars: 0, dedupCount: 0 }
  // ── Image dedup (vision tokens are ~$15/MTok) ───────────────────────────────
  const imgDedup = hasCacheMarkers ? ZERO_DEDUP : dedupImagesAnthropic(msgs as Parameters<typeof dedupImagesAnthropic>[0])
  // ── Attachment / artifact dedup (large repeated text blocks) ────────────────
  const attDedup = hasCacheMarkers ? ZERO_DEDUP : dedupAttachments(msgs as Parameters<typeof dedupAttachments>[0])
  // ── Diff-based repeated Read ────────────────────────────────────────────────
  const diffReads = hasCacheMarkers ? { savedChars: 0, collapsedCount: 0 } : compressRepeatedReads(msgs as Parameters<typeof compressRepeatedReads>[0])
  // ── Cross-turn dedup of identical tool outputs (Bash/Grep/etc re-run) ────────
  const dupResults = hasCacheMarkers ? { savedChars: 0, collapsedCount: 0 } : compressDuplicateToolResults(msgs as Parameters<typeof compressDuplicateToolResults>[0])
  // ── Step 0: Cross-turn dedup (Read / Bash / Grep) ────────────────────────────
  // If the exact same tool output appears multiple times in the conversation,
  // keep the most recent occurrence at full fidelity and replace earlier ones
  // with a short reference. Hash is MD5-exact, so any byte difference = no dedup.
  // Zero quality risk: original content is always recoverable via squeezr_expand.
  const dedupedSet = new Set<string>()  // "index:subIndex" keys — skip in later steps
  let readDedupSaved = 0
  // Per-tool tally for the "Top Tools" panel. Counts deterministic + dedup work,
  // not just AI — so the panel shows activity even when AI compression is off.
  const detByTool: Record<string, { count: number; savedChars: number; originalChars: number }> = {}
  const tallyTool = (tool: string, saved: number, original: number) => {
    const k = tool || 'unknown'
    if (!detByTool[k]) detByTool[k] = { count: 0, savedChars: 0, originalChars: 0 }
    detByTool[k].count++
    detByTool[k].savedChars += saved
    detByTool[k].originalChars += original
  }
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
      // Cross-turn dedup moves the "kept" occurrence → not cache-stable. Skip
      // anything in the cached prefix so we never invalidate the prompt cache.
      if (index <= cacheBarrier) continue
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
        tallyTool(tool, text.length, text.length)
      }
    }
    if (readDedupSaved > 0) {
      const tokens = Math.round(readDedupSaved / 3.5)
      console.log(`[squeezr/dedup] ${dedupCount} duplicate tool output(s) collapsed: -${readDedupSaved.toLocaleString()} chars (~${tokens} tokens)`)
      hitPattern('readDedup', dedupCount)
    }
  }

  // ── Step 1: Deterministic preprocessing on ALL tool results (turn 1+) ───────
  // Applied to the WHOLE history. Uses a FIXED pressure (DET_PRESSURE) instead of
  // the live `pressure` so the output is byte-identical between requests — that's
  // what keeps Anthropic's prompt cache valid (variable pressure = the prefix
  // changes every turn = cache miss = the 2026-06-04 over-bill). One cache miss
  // happens the first time the level changes; stable forever after.
  const DET_PRESSURE = 0
  const detT0 = Date.now()
  let detSaved = 0
  for (const { index, subIndex, text, tool } of allResults) {
    if (dedupedSet.has(`${index}:${subIndex}`)) continue  // already replaced by dedup
    const det = preprocessForTool(text, tool, DET_PRESSURE)
    if (det !== text) {
      ;(msgs[index].content as Array<{ content?: unknown }>)[subIndex].content = det
      detSaved += text.length - det.length
      tallyTool(tool, text.length - det.length, text.length)
    }
  }
  const detMs = Date.now() - detT0
  if (detSaved > 0) {
    const tokens = Math.round(detSaved / 3.5)
    console.log(`[squeezr/det] Deterministic: -${detSaved.toLocaleString()} chars (~${tokens} tokens) across ${allResults.length} block(s)`)
  }

  // Assistant turns queued for AI compression (Fase B2) — filled in Step 1.5,
  // processed after the tool-result AI stage (reuses the same compressFn + guard).
  const asstAiCandidates: Array<{ index: number; subIndex: number; text: string; tool: string }> = []
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
      const afterDet = det.length < blk.text.length ? det : blk.text
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
      // Fase B2: queue long OLD assistant turns for AI compression (gated, default off).
      // extractAnthropicAssistantTexts already excludes the last keepRecentAssistant.
      // Like the tool-result AI, we rely on Zest byte-stability (temp=0) + session
      // cache for cache-safety rather than gating on cache markers.
      if (config.compressAssistantAi && afterDet.length >= config.assistantAiMinChars) {
        asstAiCandidates.push({ index: blk.index, subIndex: blk.isString ? -1 : blk.subIndex, text: afterDet, tool: 'assistant' })
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

  // Deterministic per-tool tally → byTool array (Top Tools shows det work, not just AI)
  const detByToolArr = (): Savings['byTool'] =>
    Object.entries(detByTool).map(([tool, d]) => ({ tool, savedChars: d.savedChars, originalChars: d.originalChars, count: d.count }))

  // ── Step 2: AI compression for old blocks above threshold ─────────────────
  // AI output is NOT byte-stable (Haiku varies; session cache only stabilizes it
  // AFTER the first call). So AI must NEVER touch the cached prefix — only blocks
  // past the barrier are eligible. The deterministic pass above already handled
  // the prefix (stably). Without cache markers (cacheBarrier=-1) everything is eligible.
// AI minimum block size. Governed at runtime by effectiveAiMinChars() (default
  // 1000, raised automatically by the quality governor if the expand rate climbs).
  // The per-block acceptance guardrail (compressionGuard) rejects any result that
  // doesn't save enough or drops key tokens, so a smaller floor can't hurt quality.
  const aiThreshold = Math.max(threshold, effectiveAiMinChars())
const candidates = allResults.slice(0, Math.max(0, allResults.length - effectiveKeepRecent(config)))
  // Note: we do NOT filter by cacheBarrier here. The barrier was designed for
  // non-deterministic AI backends (Haiku varies between calls). Zest uses
  // temperature=0 → same input always produces same output → byte-stable →
  // cache-safe. Removing the barrier lets Zest compress tool results that
  // land before the cache marker, which is the common case in Claude Code.
  // Structured data (JSON/JSONL/record dumps/tables) is EXCLUDED from AI
  // compression: the model can silently alter field values (e.g. blank a `date`
  // to '') and corrupt the data view. These blocks keep their deterministic-only
  // form (recoverable via squeezr_expand). Prose still gets AI-compressed.
  let structuredSkipped = 0
  let incompressibleSkipped = 0
  const toProcess = candidates.filter(c => {
    if (c.text.length < aiThreshold) return false
    if (dedupedSet.has(`${c.index}:${c.subIndex}`)) return false
    if (looksStructured(c.text)) { structuredSkipped++; return false }
    // Dense/incompressible blocks would be rejected by the guard anyway (saving
    // < min-ratio) — skip the wasted AI call and keep the deterministic form.
    if (looksIncompressible(c.text)) { incompressibleSkipped++; return false }
    return true
  })
  if (structuredSkipped > 0) {
    console.log(`[squeezr/struct-guard] ${structuredSkipped} structured block(s) kept deterministic-only (AI skipped to avoid data corruption)`)
  }
  if (incompressibleSkipped > 0) {
    console.log(`[squeezr/probe] ${incompressibleSkipped} dense block(s) skipped AI (low compressibility — would reject; kept deterministic, no wasted Zest call)`)
  }

// Only bail early if there's NOTHING for the AI stage — neither tool-result
  // blocks nor queued assistant turns (Fase B2). Otherwise fall through so the
  // assistant-turn AI compression still runs even when no tool results qualify.
  if (toProcess.length === 0 && asstAiCandidates.length === 0) return [msgs, emptySavings(false, detSaved, readDedupSaved, detMs, detByToolArr())]

  // Circuit breaker: skip AI compression entirely if backend is down
  if (!circuitBreaker.shouldAllow()) {
    console.log(`[squeezr] Circuit breaker open — skipping AI compression for ${toProcess.length + asstAiCandidates.length} block(s)`)
    return [msgs, emptySavings(false, detSaved, readDedupSaved, detMs, detByToolArr())]
  }

  if (config.dryRun) {
    const potential = toProcess.reduce((sum, c) => sum + c.text.length, 0)
    console.log(`[squeezr dry-run] Would AI-compress ${toProcess.length} block(s) | potential -${potential.toLocaleString()} chars | pressure=${Math.round(pressure * 100)}%`)
    return [msgs, emptySavings(true, detSaved, readDedupSaved, detMs, detByToolArr())]
  }

  // Differential: split session cache hits from uncached
  const sessionHits: Array<{ index: number; subIndex: number; tool: string; block: SessionBlock }> = []
  let toCompress: Array<{ index: number; subIndex: number; text: string; tool: string }> = []
  for (const c of toProcess) {
    const cached = getBlock(hashText(c.text))
    if (cached) {
      sessionHits.push({ index: c.index, subIndex: c.subIndex, tool: c.tool, block: cached })
    } else if (isAiCompressionEnabled() && aiEnabled() && !config.aiSkipTools.has(c.tool.toLowerCase())) {
      toCompress.push(c)
    }
  }
  // Cap AI calls per request to avoid a burst when first activating on a long
  // conversation. Largest blocks first (max gain); the rest compress on later
  // requests — session cache makes this converge in a few turns.
  // (The previous guard `c.index === lastMsgIdx` was dead logic: the last message
  // is always inside keepRecent, so AI compression never fired for Anthropic.)
  const MAX_AI_BLOCKS_PER_REQUEST = 5
  if (toCompress.length > MAX_AI_BLOCKS_PER_REQUEST) {
    toCompress = [...toCompress]
      .sort((a, b) => b.text.length - a.text.length)
      .slice(0, MAX_AI_BLOCKS_PER_REQUEST)
  }

  const aiT0 = Date.now()
  // SAFETY: never auto-route AI compression to Haiku on an OAuth subscription
  // token — it bills against the user's 5h plan quota. When the resolved backend
  // would hit Haiku (`auto` default, or explicit `haiku`) on such a key, skip AI
  // entirely (deterministic savings already applied). The user can still pick a
  // local (Zest) / gpt-mini / gemini-flash backend, which is billed elsewhere.
  const resolvedBackend = effectiveBackend()
  const wouldHitHaiku = resolvedBackend === 'auto' || resolvedBackend === 'haiku'
  // Snapshot real backend-call counters so we can report ACTUAL Zest calls this
  // request (a block served from the LRU cache produces a result WITHOUT a call).
  const cloudCallsBefore = aiUsageCounters.calls
  const localCallsBefore = localAiUsageCounters.calls
  let freshlyCompressed: Array<{ index: number; subIndex?: number; original: string; result: string; tool: string }> = []
  let asstAiCompressed: Array<{ index: number; subIndex?: number; original: string; result: string; tool: string }> = []
  const aiBlocked = wouldHitHaiku && isOAuthSubscriptionKey(apiKey)
  if (aiBlocked) {
    console.log('[squeezr] AI compression skipped: backend would use Haiku on an OAuth subscription token (would burn your 5h plan). Pick "Zest (local)" in the dashboard to compress with AI for free.')
  } else {
    const defaultFn: CompressFn = (t, extra) => compressWithHaiku(t, apiKey, extra)
    const fn = getEffectiveCompressFn(defaultFn, config)
    if (toCompress.length > 0) freshlyCompressed = await runCompression(toCompress, fn, config, resolvedBackend === 'local')
    // Fase B2: AI-compress long old assistant turns (same guard + retry pipeline).
    if (asstAiCandidates.length > 0 && isAiCompressionEnabled() && aiEnabled()) {
      asstAiCompressed = await runCompression(asstAiCandidates, fn, config, resolvedBackend === 'local')
    }
  }
  const aiMs = Date.now() - aiT0
  // REAL calls made this request (excludes LRU-cache-served blocks).
  const realLocalCalls = localAiUsageCounters.calls - localCallsBefore
  const realCloudCalls = aiUsageCounters.calls - cloudCallsBefore

  let totalOriginal = 0
  let totalCompressed = 0
  let totalOverhead = 0
  let totalAiSaved = 0
  // Start from the deterministic tally so Top Tools reflects det + dedup + AI.
  const byTool: Savings['byTool'] = detByToolArr()

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

  // Fase B2: apply AI-compressed assistant turns. subIndex === -1 → string content;
  // otherwise it's a text block inside the content array. Wrapped with the expand
  // tag so the model can recover the full turn if needed.
  let asstAiSaved = 0
  for (const { index, subIndex, original, result } of asstAiCompressed) {
    const { fullString, savedChars, overheadChars } = buildAndCache(original, result)
    if (subIndex === -1) {
      msgs[index].content = fullString
    } else {
      ;(msgs[index].content as Array<{ text?: string }>)[subIndex!].text = fullString
    }
    totalOriginal += original.length
    totalCompressed += original.length - savedChars
    totalOverhead += overheadChars
    totalAiSaved += savedChars
    asstAiSaved += savedChars
    byTool.push({ tool: 'assistant', savedChars, originalChars: original.length })
  }
  if (asstAiSaved > 0) {
    console.log(`[squeezr/asst-ai] Assistant AI: -${asstAiSaved.toLocaleString()} chars (~${Math.round(asstAiSaved / 3.5)} tokens) across ${asstAiCompressed.length} turn(s)`)
  }

  if (pressure >= 0.5) console.log(`[squeezr] Context pressure: ${Math.round(pressure * 100)}% → threshold=${threshold} chars`)
  if (sessionHits.length > 0) console.log(`[squeezr] Session cache: ${sessionHits.length} block(s) reused (KV cache preserved)`)

  // Persist the count of REAL local (Zest) backend calls this request — NOT
  // freshlyCompressed.length, which also counts blocks served from the LRU cache
  // (no backend call). localAiUsageCounters only moves on a true Ollama call.
  const localCallsThisReq = realLocalCalls
  const localSavedThisReq = localCallsThisReq > 0
    ? freshlyCompressed.reduce((s, f) => s + (f.original.length - f.result.length), 0)
    : 0
void realCloudCalls // (reserved for future cloud-call accounting symmetry)
  // Non-cached tail AFTER compression → honest full-price savings (no double-count).
  const nonCachedFinalChars = tailChars(msgs)
  const nonCachedSavedChars = Math.max(0, nonCachedOriginalChars - nonCachedFinalChars)
  return [msgs, {
    compressed: freshlyCompressed.length,
    savedChars: totalOriginal - totalCompressed,
    originalChars: totalOriginal,
    nonCachedOriginalChars,
    nonCachedSavedChars,
    byTool,
    dryRun: false,
    sessionCacheHits: sessionHits.length,
    detSavedChars: detSaved,
    dedupSavedChars: readDedupSaved + imgDedup.savedChars + attDedup.savedChars + diffReads.savedChars + dupResults.savedChars,
    aiSavedChars: totalAiSaved,
    overheadChars: totalOverhead,
    localAiCalls: localCallsThisReq,
    localAiSavedChars: localSavedThisReq,
    // Original size of the blocks AI actually compressed (fresh + cache-reused),
    // so efficiency = aiSaved / this = the real AI compression ratio (~75-90%).
    compressibleOriginalChars: totalOriginal,
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
  let toCompress: Array<{ index: number; text: string; tool: string }> = []
  for (const c of toProcess) {
    const cached = getBlock(hashText(c.text))
    if (cached) {
      sessionHits.push({ index: c.index, tool: c.tool, block: cached })
    } else if (isAiCompressionEnabled() && aiEnabled() && !config.aiSkipTools.has(c.tool.toLowerCase())) {
      toCompress.push(c)
    }
  }
  // Cap per request — same anti-burst strategy as the Anthropic path.
  // (Previous `c.index > newStartIdx` guard was dead logic: blocks after the last
  // assistant message are inside keepRecent, so AI compression never fired.)
  const MAX_OAI_AI_BLOCKS = 5
  if (toCompress.length > MAX_OAI_AI_BLOCKS) {
    toCompress = [...toCompress]
      .sort((a, b) => b.text.length - a.text.length)
      .slice(0, MAX_OAI_AI_BLOCKS)
  }

  const defaultFn: CompressFn = isLocal
    ? (t, extra) => compressLargeText(t, config.localUpstreamUrl, config.localCompressionModel, extra)
    : (t, extra) => compressWithGptMini(t, apiKey, extra)
  const compressFn = getEffectiveCompressFn(defaultFn, config)

  const oaiAiT0 = Date.now()
  const freshlyCompressed = toCompress.length > 0
    ? await runCompression(toCompress, compressFn, config, effectiveBackend() === 'local')
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
    else if (isAiCompressionEnabled() && aiEnabled()) toCompress.push(c)
  }

  const gemAiT0 = Date.now()
  const gemDefaultFn: CompressFn = (t) => compressWithGeminiFlash(t, apiKey)
  const gemFn = getEffectiveCompressFn(gemDefaultFn, config)
  const freshlyCompressed = toCompress.length > 0
    ? await runCompression(toCompress, gemFn, config, effectiveBackend() === 'local')
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

export function emptySavings(dryRun = false, detSavedChars = 0, dedupSavedChars = 0, detMs = 0, byTool: Savings['byTool'] = [], compressibleOriginalChars = 0): Savings {
  return { compressed: 0, savedChars: 0, originalChars: 0, byTool, dryRun, sessionCacheHits: 0, detSavedChars, dedupSavedChars, aiSavedChars: 0, overheadChars: 0, detMs, aiMs: 0, compressibleOriginalChars }
}
