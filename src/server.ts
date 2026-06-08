import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import { Hono, type Context } from 'hono'
import { stream, streamSSE } from 'hono/streaming'
import { config, applyMode, runtimeOverrides, anthropicNativeCompactEnabled, effectiveBackend, USER_CONFIG_DIR, USER_CONFIG_PATH, type CompressionBackend } from './config.js'
import { Stats } from './stats.js'
import type { LatencyInfo } from './stats.js'
import { DASHBOARD_HTML, LOGO_SVG } from './dashboard.js'
import { getCache, emptySavings, aiUsageCounters, aiUsageByModel, localAiUsageCounters, compressionGuardCounters, aiUsageToday } from './compressor.js'
import {
  compressAnthropicMessages,
  compressOpenAIMessages,
  compressGeminiContents,
  isOAuthSubscriptionKey,
} from './compressor.js'
import { isBypassed, setBypassed, toggleBypassed } from './bypass.js'
import { isAiCompressionEnabled, setAiCompression, toggleAiCompression } from './aiToggle.js'
import { circuitBreaker } from './circuitBreaker.js'
import {
  injectExpandToolAnthropic,
  injectExpandToolOpenAI,
  handleAnthropicExpandCall,
  handleOpenAIExpandCall,
  retrieveOriginal,
  expandStoreSize,
  EXPAND_TOOL_ANTHROPIC_CHARS,
} from './expand.js'
import { compressSystemPrompt } from './systemPrompt.js'
import { captureRequest } from './requestCapture.js'
import { dedupSkillBlocks } from './skillDedup.js'
import { collapseStaleTurns } from './staleTurns.js'
import { compressToolDescriptions } from './toolDescComp.js'
import { filterMcpTools } from './mcpFilter.js'
import { anthropicDirectFetch, isAnthropicUrl } from './anthropicDirectFetch.js'
import { sessionCacheSize, clearSessionCache } from './sessionCache.js'
import { detPatternHits } from './deterministic.js'
import { recentLogLines } from './logFeed.js'
import { governQuality } from './qualityGovernor.js'
import { VERSION } from './version.js'
import {
  recordRequest,
  getHistorySessions,
  getCurrentSession,
  getProjectAggregates,
  getAllSessionsForHistory,
  setSessionExtrasProvider,
} from './history.js'
import {
  updateAnthropicFromHeaders,
  updateOpenAIFromHeaders,
  updateGeminiFrom429,
  addAnthropicUsage,
  addOpenAIUsage,
  addGeminiUsage,
  makeSseUsageParser,
  maybeRefreshOpenAIBilling,
  maybeRefreshOpenAISessionLimits,
  storeKey,
  storedKey,
  limitsSnapshot,
} from './limits.js'

// ── System-prompt compression backend selector ──────────────────────────────────
// Maps the configured compression backend to the model used for system-prompt
// compression. Returns null when the only option would be a billed Haiku call on
// an OAuth subscription token (which burns the 5h plan) — the caller then applies
// deterministic-only compression instead of skipping the prompt untouched.
function systemPromptBackend(apiKey: string): 'haiku' | 'gpt-mini' | 'gemini-flash' | 'ollama' | null {
  const b = effectiveBackend()
  if (b === 'local') return 'ollama'           // Zest, no API call
  if (b === 'gpt-mini') return 'gpt-mini'
  if (b === 'gemini-flash') return 'gemini-flash'
  // 'auto' or 'haiku' → Haiku, but only with a billed API key, never on OAuth.
  return isOAuthSubscriptionKey(apiKey) ? null : 'haiku'
}

// ── Project name extraction ────────────────────────────────────────────────────
// Manual project override — set via /squeezr/project endpoint or MCP tool
let manualProject: string | null = null

export function setManualProject(name: string | null): void {
  manualProject = name
}

export function getManualProject(): string | null {
  return manualProject
}

// Reads the CWD from Claude Code's system prompt (injected as <cwd>…</cwd> or
// "current working directory: …") and returns the last path component.

function extractProjectName(body: Record<string, unknown>): string {
  if (manualProject) return manualProject

  try {
    const system = body.system
    let text = ''
    if (Array.isArray(system)) {
      text = (system as Array<{ type?: string; text?: string }>)
        .map(s => s.text ?? '')
        .join(' ')
    } else if (typeof system === 'string') {
      text = system
    }

    // Claude Code format: <cwd>/path/to/project</cwd>
    const xmlCwd = text.match(/<cwd>([^<]+)<\/cwd>/)
    if (xmlCwd) {
      const parts = xmlCwd[1].trim().replace(/\\/g, '/').split('/').filter(Boolean)
      if (parts.length) return parts[parts.length - 1]
    }

    // Plain-text format: "current working directory: /path"
    const plainCwd = text.match(/(?:current working directory|cwd)[:\s]+([^\n<]+)/i)
    if (plainCwd) {
      const parts = plainCwd[1].trim().replace(/\\/g, '/').split('/').filter(Boolean)
      if (parts.length) return parts[parts.length - 1]
    }

    // Fallback: extract LAST meaningful path segment from system prompt
    // e.g. C:\Users\Ramos\Documents\InvoiceApp\src → InvoiceApp
    // Only match filesystem paths (not URLs like https://github.com)
    const pathMatch = text.match(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|workspace|projects|Documents)[\\/])[^\s<>"*?|]+/i)
    if (pathMatch && !pathMatch[0].includes('://')) {
      const parts = pathMatch[0].replace(/\\/g, '/').split('/').filter(Boolean)
      const skip = new Set([
        'users', 'home', 'documents', 'workspace', 'projects', 'desktop',
        'dev', 'src', 'repos', 'mnt', 'c', 'var', 'tmp', 'opt', 'usr',
        'lib', 'bin', 'etc', 'node_modules', '.claude', '.config',
      ])
      for (const pt of parts) {
        if (!skip.has(pt.toLowerCase()) && !/^[a-z]:$/i.test(pt) && pt.length > 1) return pt
      }
      if (parts.length) return parts[parts.length - 1]
    }
  } catch { /* ignore */ }
  return 'unknown'
}

const ANTHROPIC_API = 'https://api.anthropic.com'
const OPENAI_API = 'https://api.openai.com'
const GOOGLE_API = 'https://generativelanguage.googleapis.com'

const SKIP_REQ_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'expect', 'x-squeezr-client', 'x-squeezr-dryrun'])

function readCodexToken(): string | null {
  try {
    const d = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf-8'))
    return (d?.tokens?.access_token as string) ?? null
  } catch { return null }
}
const SKIP_RESP_HEADERS = new Set(['content-encoding', 'transfer-encoding', 'connection', 'content-length'])

export const stats = new Stats()

// Feed AI-usage + session-cache totals into each persisted SessionRecord so the
// Savings page can filter them by day/week/month (v1.61.0).
setSessionExtrasProvider(() => {
  const s = stats.summary()
  return {
    aiUsage: {
      calls: aiUsageCounters.calls,
      inputTokens: aiUsageCounters.inputTokens,
      outputTokens: aiUsageCounters.outputTokens,
      savedTokens: Math.round((s.breakdown?.tool_results_ai ?? 0) / 3.5),
    },
    sessionCache: {
      reuses: s.session_cache_hits ?? 0,
      expands: s.expand?.calls ?? 0,
    },
  }
})

function forwardHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of headers.entries()) {
    if (!SKIP_REQ_HEADERS.has(k.toLowerCase())) out[k] = v
  }
  return out
}

function extractOpenAIKey(headers: Headers): string {
  const auth = headers.get('authorization') ?? ''
  return auth.replace(/^bearer\s+/i, '').trim()
}

function extractGoogleKey(headers: Headers, url: URL): string {
  return headers.get('x-goog-api-key') ?? url.searchParams.get('key') ?? ''
}

function detectUpstream(headers: Headers): string {
  if (headers.get('x-goog-api-key')) return GOOGLE_API
  const auth = headers.get('authorization') ?? ''
  if (auth && !headers.get('x-api-key')) return OPENAI_API
  return ANTHROPIC_API
}

function estimateChars(data: unknown): number {
  return JSON.stringify(data).length
}
function estimateSystemChars(system: unknown): number {
  if (typeof system === 'string') return system.length
  if (Array.isArray(system)) return JSON.stringify(system).length
  return 0
}
function estimateFullRequestChars(body: Record<string, unknown>): number {
  return estimateChars(body.messages ?? [])
    + estimateChars(body.tools ?? [])
    + estimateSystemChars(body.system)
}

// Outgoing fetch — uses Node's native fetch for everything EXCEPT
// api.anthropic.com, which is forced through direct DNS so that the system
// hosts file redirect installed by `squeezr enable-claude-desktop` does NOT
// loop the main proxy back to itself (or to the desktop proxy with its
// self-signed cert, which is what was breaking Claude Code in the terminal
// with infinite "Retrying" loops).
//
// This is NOT a state-dependent branch on whether Claude Desktop is enabled
// — that proved fragile. The behaviour is now constant: api.anthropic.com
// ALWAYS uses direct DNS. The result is identical for users who never touch
// Claude Desktop (the hosts file is fine, the direct resolver returns the
// same IPs) and correct for users who do.
function outgoingFetch(url: string, init: RequestInit): Promise<Response> {
  if (isAnthropicUrl(url)) return anthropicDirectFetch(url, init)
  return fetch(url, init)
}

async function proxyStream(upstream: string, body: unknown, headers: Record<string, string>, params?: URLSearchParams): Promise<Response> {
  const url = params?.toString() ? `${upstream}?${params}` : upstream
  return outgoingFetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export const app = new Hono()

// ── CORS middleware (required for Cursor IDE and browser-based tools) ─────────
// Cursor's Electron renderer sends OPTIONS preflight before every POST.
// Without this the request is blocked and Cursor shows a network error.

app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    })
  }
  await next()
  c.res.headers.set('Access-Control-Allow-Origin', '*')
  c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
  c.res.headers.set('Access-Control-Allow-Headers', '*')
})

// ── Client detection from User-Agent ─────────────────────────────────────────
// `hint` comes from the desktop proxy via `x-squeezr-client` and is the
// authoritative source when present (the desktop proxy *knows* which listener
// received the request). Falls back to UA heuristics otherwise.
const VALID_CLIENT_HINTS = new Set([
  'claude_code', 'claude_desktop', 'codex_cli', 'codex_desktop',
  'aider', 'opencode', 'cursor', 'cline', 'windsurf', 'continue',
])

function detectAnthropicClient(ua: string, hint?: string | null): string {
  if (hint && VALID_CLIENT_HINTS.has(hint)) return hint
  const u = ua.toLowerCase()
  if (u.includes('claude-code') || u.includes('claude_code')) return 'claude_code'
  if (u.includes('claude-desktop') || u.includes('claude desktop') || u.includes('electron')) return 'claude_desktop'
  if (u.includes('aider')) return 'aider'
  if (u.includes('opencode') || u.includes('open-code')) return 'opencode'
  if (u.includes('cursor')) return 'cursor'
  if (u.includes('cline') || u.includes('roo')) return 'cline'
  if (u.includes('windsurf')) return 'windsurf'
  return 'claude_code' // default: most likely Claude Code if using /v1/messages
}

function detectOpenAIClient(ua: string, hint?: string | null): string {
  if (hint && VALID_CLIENT_HINTS.has(hint)) return hint
  const u = ua.toLowerCase()
  if (u.includes('codex')) return 'codex_desktop'
  if (u.includes('cursor')) return 'cursor'
  if (u.includes('continue')) return 'continue'
  if (u.includes('cline') || u.includes('roo')) return 'cline'
  if (u.includes('windsurf')) return 'windsurf'
  if (u.includes('aider')) return 'aider'
  return 'openai_other'
}

// ── Anthropic / Claude Code ───────────────────────────────────────────────────

app.post('/v1/messages', async (c) => {
  const body = await c.req.json<Record<string, unknown>>()
  // Support both API key (x-api-key: sk-ant-...) and OAuth bearer token
  // (Authorization: Bearer ...) — Claude Code subscription uses OAuth
  const apiKey = c.req.header('x-api-key')
    ?? c.req.header('authorization')?.replace(/^bearer\s+/i, '').trim()
    ?? process.env.ANTHROPIC_API_KEY
    ?? ''

const clientId = detectAnthropicClient(c.req.header('user-agent') ?? '', c.req.header('x-squeezr-client'))
  const modelId  = String(body.model ?? 'unknown')
  // Request capture (opt-in via compression.capture_requests = true).
  // Saves anonymized payloads to ~/.squeezr/captures/ for offline analysis.
  // Auth headers are redacted; first N requests only (bounded disk use).
  if (config.captureRequests) {
    const allHeaders: Record<string, string> = {}
    c.req.raw.headers.forEach((value, key) => { allHeaders[key] = value })
    captureRequest(body, {
      client: clientId,
      model: modelId,
      method: 'POST',
      path: '/v1/messages',
      headers: allHeaders,
    }, { enabled: true, limit: config.captureLimit })
  }
  // Extract project name BEFORE compressing system prompt (compression destroys <cwd> tags)
  const project = extractProjectName(body)

  const messages = (body.messages ?? []) as unknown[]
  // Measure FULL request (messages + tools + system) before ANY compression
  const originalRequestChars = estimateFullRequestChars(body)
  const originalChars = estimateChars(messages)  // kept for compressAnthropicMessages pressure calc

  // Dry-run mode: exercises the compression pipeline but does NOT forward to
  // upstream. Used by the post-start self-test to verify the request path is
  // wired correctly without consuming any API quota.
  if (c.req.header('x-squeezr-dryrun') === '1') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [dryMessages, savings] = await compressAnthropicMessages(messages as any, apiKey, config)
    const compressedChars = estimateChars(dryMessages as unknown[])
    return c.json({
      identity: 'squeezr',
      dry_run: true,
      original_chars: originalChars,
      compressed_chars: compressedChars,
      saved_chars: Math.max(0, originalChars - compressedChars),
      savings,
    })
  }

  // Bypass mode: skip all compression, still record request stats
  if (isBypassed()) {
    stats.recordWithProject(project, originalRequestChars, originalRequestChars, emptySavings(), undefined, clientId, modelId)
    recordRequest(project, 0, 0, [], originalRequestChars)
    storeKey('anthropic', apiKey)
    const fwdHeaders = forwardHeaders(c.req.raw.headers)
    if (body.stream) {
      const upstream = await proxyStream(`${ANTHROPIC_API}/v1/messages`, body, fwdHeaders)
      updateAnthropicFromHeaders(upstream.headers)
      for (const [k, v] of upstream.headers.entries()) {
        if (!SKIP_RESP_HEADERS.has(k.toLowerCase())) c.header(k, v)
      }
      return stream(c, async (s) => {
        const reader = upstream.body!.getReader()
        const decoder = new TextDecoder()
        const sseParser = makeSseUsageParser('anthropic', (inp, out, cc, cr) => addAnthropicUsage(inp, out, cc ?? 0, cr ?? 0))
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          await s.write(value)
          sseParser(decoder.decode(value, { stream: true }))
        }
      })
    }
    const resp = await outgoingFetch(`${ANTHROPIC_API}/v1/messages`, {
      method: 'POST',
      headers: { ...fwdHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    updateAnthropicFromHeaders(resp.headers)
    const respBody = await resp.json()
    const respHeaders: Record<string, string> = {}
    for (const [k, v] of resp.headers.entries()) {
      if (!SKIP_RESP_HEADERS.has(k.toLowerCase())) respHeaders[k] = v
    }
    return c.json(respBody, resp.status as any, respHeaders)
  }

// Track savings from each pre-pass for accurate stats reporting
  let toolDescSaved = 0
  let mcpFilterSaved = 0
  let skillDedupSaved = 0
  let syspromptSaved = 0
  let staleTurnsSaved = 0

  // MCP tool filtering per-server — drop tools from blocked servers entirely.
  // Runs BEFORE tool desc compression so dropped tools never reach later passes.
  if (Array.isArray(body.tools) && (config.mcpBlockServers.size > 0 || config.mcpAllowServers.size > 0)) {
    const mf = filterMcpTools(
      body.tools as unknown[],
      messages as Parameters<typeof filterMcpTools>[1],
      config.mcpBlockServers,
      config.mcpAllowServers,
    )
    if (mf.result.removedTools > 0) {
      body.tools = mf.tools
      mcpFilterSaved = mf.result.savedChars
      const tokens = Math.round(mf.result.savedChars / 3.5)
      console.log(`[squeezr/mcp-filter] ${mf.result.removedTools} tool(s) from [${mf.result.removedServers.join(', ')}]: -${mf.result.savedChars.toLocaleString()} chars (~${tokens} tokens)`)
    }
    if (mf.result.keptUsedServers.length > 0) {
      console.log(`[squeezr/mcp-filter] kept (in use): ${mf.result.keptUsedServers.join(', ')}`)
    }
  }

  // Tool description compression
  if (config.toolDescCompress && Array.isArray(body.tools)) {
    const td = compressToolDescriptions(body.tools as unknown[], config.toolDescMaxChars, config.toolDescFirstPara, config.toolDescSafeOnly, config.toolDescExpand)
    toolDescSaved = td.savedChars
    if (td.savedChars > 0) {
      const tokens = Math.round(td.savedChars / 3.5)
      console.log(`[squeezr/tool-desc] ${td.compressedTools}/${td.totalTools} tool(s): -${td.savedChars.toLocaleString()} chars (~${tokens} tokens)`)
    }
  }

  // System prompt compression (handles both string and array formats — Claude Code sends array).
  // The AI backend FOLLOWS the configured compression backend — it no longer hardcodes Haiku.
  // 'local' → 'ollama' (deterministic-only, no API call); 'auto'/'haiku' → 'haiku' ONLY with a
  // billed API key, never on an OAuth subscription token (that would burn the 5h plan).
  const spBackend = systemPromptBackend(apiKey)
  if (config.compressSystemPrompt && !config.dryRun && spBackend) {
    if (typeof body.system === 'string') {
      const dd = dedupSkillBlocks(body.system)
      skillDedupSaved += dd.savedChars
      body.system = dd.text
      const sp = await compressSystemPrompt(body.system as string, apiKey, spBackend)
      syspromptSaved += sp.originalLen - sp.compressedLen
      body.system = sp.text
    } else if (Array.isArray(body.system)) {
      for (const block of body.system as Array<{ type?: string; text?: string }>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const dd = dedupSkillBlocks(block.text)
          skillDedupSaved += dd.savedChars
          block.text = dd.text
          const sp = await compressSystemPrompt(block.text, apiKey, spBackend)
          syspromptSaved += sp.originalLen - sp.compressedLen
          block.text = sp.text
        }
      }
    }
  } else if (config.compressSystemPrompt && !config.dryRun && !spBackend) {
    // Backend would have hit Haiku on an OAuth token — still apply the free
    // deterministic skill-block dedup, just skip the billed AI pass.
    if (typeof body.system === 'string') {
      const dd = dedupSkillBlocks(body.system)
      skillDedupSaved += dd.savedChars
      body.system = dd.text
    } else if (Array.isArray(body.system)) {
      for (const block of body.system as Array<{ type?: string; text?: string }>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const dd = dedupSkillBlocks(block.text)
          skillDedupSaved += dd.savedChars
          block.text = dd.text
        }
      }
    }
  }

  const systemExtraChars = typeof body.system === 'string'
    ? body.system.length
    : Array.isArray(body.system)
      ? (body.system as Array<{ text?: string }>).reduce((s, b) => s + (b.text?.length ?? 0), 0)
      : 0

  // Stale turn summarization — DISABLED when prompt cache markers are present.
  // Its collapse boundary moves forward one turn per request, mutating the cached
  // prefix every turn → permanent cache invalidation (re-bills the full context).
  // Without cache markers (clients that don't cache) it runs freely.
  const msgsHaveCacheMarkers = (messages as Array<{ content?: unknown }>).some(m =>
    Array.isArray(m.content) && (m.content as Array<{ cache_control?: unknown }>).some(b => b && typeof b === 'object' && b.cache_control))
  if (config.staleTurns && !msgsHaveCacheMarkers) {
    const stale = collapseStaleTurns(
      messages as Array<{ role: string; content: string | Array<{ type?: string; text?: string }> }>,
      config.staleTurnThreshold,
      config.staleTurnKeepRecent,
    )
    staleTurnsSaved = stale.savedChars
    if (stale.savedChars > 0) {
      const tokens = Math.round(stale.savedChars / 3.5)
      console.log(`[squeezr/stale-turns] ${stale.collapsedBlocks} block(s) in ${stale.staleCount} old turn(s): -${stale.savedChars.toLocaleString()} chars (~${tokens} tokens)`)
    }
  }

  const compT0 = Date.now()
  const [compressedMsgs, savings] = await compressAnthropicMessages(messages as Parameters<typeof compressAnthropicMessages>[0], apiKey, config, systemExtraChars)
  const compLatency: LatencyInfo = { totalMs: Date.now() - compT0, detMs: savings.detMs, aiMs: savings.aiMs }
body.messages = compressedMsgs

  // Measure AFTER all compression, BEFORE expand tool injection (inject adds ~1K to tools)
  const compressedRequestChars = estimateChars(compressedMsgs)
    + estimateChars(body.tools ?? [])
    + estimateSystemChars(body.system)

  // Inject expand tool (after measurement so its size doesn't distort savings_pct)
  injectExpandToolAnthropic(body)

  // Attach per-feature savings to the savings object for accurate breakdown reporting
  savings.toolDescSavedChars = toolDescSaved
  savings.mcpFilterSavedChars = mcpFilterSaved
  savings.staleTurnsSavedChars = staleTurnsSaved
  savings.skillDedupSavedChars = skillDedupSaved
  savings.syspromptSavedChars = syspromptSaved

  stats.recordWithProject(project, originalRequestChars, compressedRequestChars, savings, compLatency, clientId, modelId)
  recordRequest(project, Math.max(0, originalRequestChars - compressedRequestChars), savings.compressed, savings.byTool, originalRequestChars, modelId, clientId)

  storeKey('anthropic', apiKey)
  const fwdHeaders = forwardHeaders(c.req.raw.headers)

  // Anthropic native context compaction beta (compact-2026-01-12)
  // When enabled, Anthropic auto-summarizes the conversation server-side
  // when input tokens exceed threshold. Stacks with Squeezr's compression.
  if (anthropicNativeCompactEnabled()) {
    const existingBeta = fwdHeaders['anthropic-beta'] || ''
    if (!existingBeta.includes('compact-2026-01-12')) {
      fwdHeaders['anthropic-beta'] = existingBeta
        ? `${existingBeta},compact-2026-01-12`
        : 'compact-2026-01-12'
    }
  }

  if (body.stream) {
    const upstream = await proxyStream(`${ANTHROPIC_API}/v1/messages`, body, fwdHeaders)
    // Extract rate limit headers immediately (available before body starts)
    updateAnthropicFromHeaders(upstream.headers)
    // Forward anthropic-ratelimit-* (and other response) headers so Claude Code
    // can populate rate_limits in the statusline JSON (issue #4).
    for (const [k, v] of upstream.headers.entries()) {
      if (!SKIP_RESP_HEADERS.has(k.toLowerCase())) c.header(k, v)
    }
    return stream(c, async (s) => {
      const reader = upstream.body!.getReader()
      const decoder = new TextDecoder()
      const sseParser = makeSseUsageParser('anthropic', (inp, out, cc, cr) => addAnthropicUsage(inp, out, cc ?? 0, cr ?? 0))
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await s.write(value)
        sseParser(decoder.decode(value, { stream: true }))
      }
    })
  }

  const resp = await outgoingFetch(`${ANTHROPIC_API}/v1/messages`, {
    method: 'POST',
    headers: { ...fwdHeaders, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  // Extract rate limits and token usage from non-streaming response
  updateAnthropicFromHeaders(resp.headers)
  const respBody = await resp.json() as Record<string, unknown>
  if (respBody.usage) {
    const u = respBody.usage as { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
    addAnthropicUsage(u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_creation_input_tokens ?? 0, u.cache_read_input_tokens ?? 0)
  }

  // Handle expand() call if model requested one (track expand rate)
  const expandCall = handleAnthropicExpandCall(respBody)
  if (expandCall) {
    stats.recordExpand(true)
    const { toolUseId, original } = expandCall
    const continueMessages = [
      ...(body.messages as unknown[]),
      { role: 'assistant', content: respBody.content },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: original }],
      },
    ]
    body.messages = continueMessages
    const continuedResp = await fetch(`${ANTHROPIC_API}/v1/messages`, {
      method: 'POST',
      headers: { ...fwdHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    updateAnthropicFromHeaders(continuedResp.headers)
    const continuedBody = await continuedResp.json()
    const continuedHeaders: Record<string, string> = {}
    for (const [k, v] of continuedResp.headers.entries()) {
      if (!SKIP_RESP_HEADERS.has(k.toLowerCase())) continuedHeaders[k] = v
    }
    return c.json(continuedBody, continuedResp.status as any, continuedHeaders)
  }

  const respHeaders: Record<string, string> = {}
  for (const [k, v] of resp.headers.entries()) {
    if (!SKIP_RESP_HEADERS.has(k.toLowerCase())) respHeaders[k] = v
  }
  return c.json(respBody, resp.status as any, respHeaders)
})

// ── OpenAI / Codex / Ollama ───────────────────────────────────────────────────

app.post('/v1/chat/completions', async (c) => {
  const body = await c.req.json<Record<string, unknown>>()
  const openAIKey = extractOpenAIKey(c.req.raw.headers)
  const isLocal = config.isLocalKey(openAIKey)
  const upstream = isLocal ? `${config.localUpstreamUrl.replace(/\/$/, '')}/v1/chat/completions` : `${OPENAI_API}/v1/chat/completions`

  const oaiClientId = detectOpenAIClient(c.req.header('user-agent') ?? '', c.req.header('x-squeezr-client'))
  const oaiModelId  = String(body.model ?? 'unknown')

  // Extract project name BEFORE compressing system prompt
  const oaiProject = extractProjectName(body)

const messages = (body.messages ?? []) as unknown[]
  const originalOaiRequestChars = estimateFullRequestChars(body)
  const originalChars = estimateChars(messages)  // kept for compressOpenAIMessages pressure calc

  // Bypass mode: skip all compression, still record request stats
  if (isBypassed()) {
    stats.recordWithProject(oaiProject, originalOaiRequestChars, originalOaiRequestChars, emptySavings(), undefined, oaiClientId, oaiModelId)
    recordRequest(oaiProject, 0, 0, [], originalOaiRequestChars)
    if (!isLocal) storeKey('openai', openAIKey)
    const fwdHeaders = forwardHeaders(c.req.raw.headers)
    if (body.stream) {
      const resp = await fetch(upstream, {
        method: 'POST',
        headers: { ...fwdHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!isLocal) updateOpenAIFromHeaders(resp.headers)
      return stream(c, async (s) => {
        const reader = resp.body!.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          await s.write(value)
        }
      })
    }
    const resp = await fetch(upstream, {
      method: 'POST',
      headers: { ...fwdHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!isLocal) updateOpenAIFromHeaders(resp.headers)
    const respBody = await resp.json()
    const respHeaders: Record<string, string> = {}
    for (const [k, v] of resp.headers.entries()) {
      if (!SKIP_RESP_HEADERS.has(k.toLowerCase())) respHeaders[k] = v
    }
    return c.json(respBody, resp.status as any, respHeaders)
  }

// Compress system message for non-local
  let oaiSyspromptSaved = 0
  if (!isLocal && config.compressSystemPrompt && !config.dryRun) {
    const msgs = messages as Array<{ role: string; content?: string }>
    if (msgs[0]?.role === 'system' && typeof msgs[0].content === 'string') {
      const sp = await compressSystemPrompt(msgs[0].content, openAIKey, 'gpt-mini')
      msgs[0].content = sp.text
      oaiSyspromptSaved = sp.originalLen - sp.compressedLen
    }
  }

  const oaiCompT0 = Date.now()
  const [compressedMsgs, savings] = await compressOpenAIMessages(
    messages as Parameters<typeof compressOpenAIMessages>[0],
    openAIKey,
    config,
    isLocal,
  )
  const oaiCompLatency: LatencyInfo = { totalMs: Date.now() - oaiCompT0, detMs: savings.detMs, aiMs: savings.aiMs }
  body.messages = compressedMsgs

// Measure after all compressions, before expand injection
  const oaiCompressedRequestChars = estimateChars(compressedMsgs)
    + estimateChars(body.tools ?? [])
    + estimateSystemChars(body.system)
  if (!isLocal) injectExpandToolOpenAI(body)
  savings.syspromptSavedChars = oaiSyspromptSaved
  stats.recordWithProject(oaiProject, originalOaiRequestChars, oaiCompressedRequestChars, savings, oaiCompLatency, oaiClientId, oaiModelId)
  recordRequest(oaiProject, Math.max(0, originalOaiRequestChars - oaiCompressedRequestChars), savings.compressed, savings.byTool, originalOaiRequestChars, oaiModelId, oaiClientId)

  if (!isLocal) storeKey('openai', openAIKey)
  const fwdHeaders = forwardHeaders(c.req.raw.headers)

  if (body.stream) {
    // Ask OpenAI to include usage in the final chunk (harmless for most clients)
    if (!isLocal && !(body.stream_options as Record<string, unknown>)?.include_usage) {
      body.stream_options = { ...(body.stream_options as Record<string, unknown> ?? {}), include_usage: true }
    }
    const upstreamResp = await proxyStream(upstream, body, fwdHeaders)
    if (!isLocal) {
      updateOpenAIFromHeaders(upstreamResp.headers)
      maybeRefreshOpenAIBilling(openAIKey).catch(() => {})
    }
    return stream(c, async (s) => {
      const reader = upstreamResp.body!.getReader()
      const decoder = new TextDecoder()
      const sseParser = makeSseUsageParser('openai', (inp, out) => addOpenAIUsage(inp, out))
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await s.write(value)
        if (!isLocal) sseParser(decoder.decode(value, { stream: true }))
      }
    })
  }

  const resp = await fetch(upstream, {
    method: 'POST',
    headers: { ...fwdHeaders, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!isLocal) {
    updateOpenAIFromHeaders(resp.headers)
    maybeRefreshOpenAIBilling(openAIKey).catch(() => {})
  }
  const respBody = await resp.json() as Record<string, unknown>
  if (!isLocal && respBody.usage) {
    const u = respBody.usage as { prompt_tokens?: number; completion_tokens?: number }
    addOpenAIUsage(u.prompt_tokens ?? 0, u.completion_tokens ?? 0)
  }

  const expandCall = !isLocal ? handleOpenAIExpandCall(respBody) : null
  if (expandCall) {
    stats.recordExpand(true)
    const { toolCallId, original } = expandCall
    const continueMessages = [
      ...(body.messages as unknown[]),
      (respBody.choices as Array<{ message: unknown }>)[0].message,
      { role: 'tool', tool_call_id: toolCallId, content: original },
    ]
    body.messages = continueMessages
    const continuedResp = await fetch(upstream, {
      method: 'POST',
      headers: { ...fwdHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return c.json(await continuedResp.json(), continuedResp.status as any)
  }

  const respHeaders: Record<string, string> = {}
  for (const [k, v] of resp.headers.entries()) {
    if (!SKIP_RESP_HEADERS.has(k.toLowerCase())) respHeaders[k] = v
  }
  return c.json(respBody, resp.status as any, respHeaders)
})

// ── Gemini CLI ────────────────────────────────────────────────────────────────

app.post('/v1beta/models/*', async (c) => {
  const body = await c.req.json<Record<string, unknown>>()
  const url = new URL(c.req.url)
  const googleKey = extractGoogleKey(c.req.raw.headers, url)
  const modelPath = c.req.path.replace('/v1beta/models/', '')

const contents = (body.contents ?? []) as unknown[]
  const geminiProject = extractProjectName(body)
  const geminiModelId = modelPath.split(':')[0] || 'gemini'
  const originalGeminiRequestChars = estimateChars(body.contents ?? [])
    + estimateChars(body.tools ?? [])
    + estimateSystemChars(body.systemInstruction)
  const originalChars = estimateChars(contents)  // kept for pressure calc

  // Bypass mode: skip all compression, still record request stats
  if (isBypassed()) {
    stats.recordWithProject(geminiProject, originalGeminiRequestChars, originalGeminiRequestChars, emptySavings(), undefined, 'gemini', geminiModelId)
    recordRequest(geminiProject, 0, 0, [], originalGeminiRequestChars)
    const targetUrl = `${GOOGLE_API}/v1beta/models/${modelPath}`
    const fwdHeaders = forwardHeaders(c.req.raw.headers)
    const params = url.searchParams
    const paramStr = params.toString()
    const resp = await fetch(paramStr ? `${targetUrl}?${paramStr}` : targetUrl, {
      method: 'POST',
      headers: { ...fwdHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const respHeaders: Record<string, string> = {}
    for (const [k, v] of resp.headers.entries()) {
      if (!SKIP_RESP_HEADERS.has(k.toLowerCase())) respHeaders[k] = v
    }
    return c.body(await resp.arrayBuffer(), resp.status as any, respHeaders)
  }

  // Store gemini key so it's available if backend is later switched to gemini-flash from a different API request
  if (googleKey) storeKey('gemini', googleKey)
  const gemCompT0 = Date.now()
  const [compressedContents, savings] = await compressGeminiContents(
    contents as Parameters<typeof compressGeminiContents>[0],
    googleKey,
    config,
  )
  const gemCompLatency: LatencyInfo = { totalMs: Date.now() - gemCompT0, detMs: savings.detMs, aiMs: savings.aiMs }
  body.contents = compressedContents

  const gemCompressedRequestChars = estimateChars(compressedContents)
    + estimateChars(body.tools ?? [])
    + estimateSystemChars(body.systemInstruction)
  stats.recordWithProject(geminiProject, originalGeminiRequestChars, gemCompressedRequestChars, savings, gemCompLatency, 'gemini', geminiModelId)
  recordRequest(geminiProject, Math.max(0, originalGeminiRequestChars - gemCompressedRequestChars), savings.compressed, savings.byTool, originalGeminiRequestChars, geminiModelId, 'gemini')

  const targetUrl = `${GOOGLE_API}/v1beta/models/${modelPath}`
  const fwdHeaders = forwardHeaders(c.req.raw.headers)
  const params = url.searchParams

  if (modelPath.includes('stream')) {
    const upstreamResp = await proxyStream(targetUrl, body, fwdHeaders, params)
    if (upstreamResp.status === 429) updateGeminiFrom429(upstreamResp.headers)
    return stream(c, async (s) => {
      const reader = upstreamResp.body!.getReader()
      const decoder = new TextDecoder()
      // Gemini streaming sends JSON array chunks with usageMetadata, not Anthropic-style SSE
      let gemBuf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await s.write(value)
        gemBuf += decoder.decode(value, { stream: true })
        const metaMatch = gemBuf.match(/"usageMetadata"\s*:\s*\{[^}]+\}/)
        if (metaMatch) {
          try {
            const meta = JSON.parse(`{${metaMatch[0]}}`) as { usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number } }
            addGeminiUsage(meta.usageMetadata.promptTokenCount ?? 0, meta.usageMetadata.candidatesTokenCount ?? 0)
          } catch { /* ignore parse errors */ }
          gemBuf = ''
        }
      }
    })
  }

  const paramStr = params.toString()
  const resp = await fetch(paramStr ? `${targetUrl}?${paramStr}` : targetUrl, {
    method: 'POST',
    headers: { ...fwdHeaders, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (resp.status === 429) updateGeminiFrom429(resp.headers)

  // Extract Gemini usage from response body
  const geminiRespBuf = await resp.arrayBuffer()
  try {
    const geminiRespJson = JSON.parse(new TextDecoder().decode(geminiRespBuf)) as Record<string, unknown>
    const meta = geminiRespJson.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined
    if (meta) addGeminiUsage(meta.promptTokenCount ?? 0, meta.candidatesTokenCount ?? 0)
  } catch { /* ignore */ }

  const respHeaders: Record<string, string> = {}
  for (const [k, v] of resp.headers.entries()) {
    if (!SKIP_RESP_HEADERS.has(k.toLowerCase())) respHeaders[k] = v
  }
  return c.body(geminiRespBuf, resp.status as any, respHeaders)
})

// ── Squeezr internal endpoints ────────────────────────────────────────────────

async function buildStatsPayload() {
  await maybeRefreshOpenAISessionLimits().catch(() => {})
  const session = stats.summary()

  // All-time totals. `stats.json` (persisted) is a single continuous counter and is
  // the source of truth. We do NOT max() against the per-session sum from history:
  // history sums savedTokens across many proxy sessions that each re-processed the
  // same growing conversation, so it massively over-counts (the 125M-vs-25M bug).
  // History is only a fallback if stats.json was reset/corrupted (persisted == 0).
  const allSessions = getAllSessionsForHistory()
  const historyTotalSavedTokens = allSessions.reduce((s, r) => s + (r.savedTokens || 0), 0)
  const historyTotalOriginalTokens = allSessions.reduce((s, r) => s + (r.originalChars ? Math.round(r.originalChars / 3.5) : 0), 0)
  const historyTotalRequests = allSessions.reduce((s, r) => s + (r.requests || 0), 0)

  const persisted = Stats.loadGlobal()
  const persistedSaved = Math.round(((persisted.total_saved_chars as number) ?? 0) / 3.5)
  const persistedOriginal = Math.round(((persisted.total_original_chars as number) ?? 0) / 3.5)
  const persistedRequests = (persisted.requests as number) ?? 0

  const allTimeSavedTokens = persistedSaved > 0
    ? persistedSaved
    : Math.max(Math.round(session.total_saved_chars / 3.5), historyTotalSavedTokens)
  const allTimeOriginalTokens = persistedOriginal > 0
    ? persistedOriginal
    : Math.max(Math.round(session.total_original_chars / 3.5), historyTotalOriginalTokens)
  const allTimeRequests = persistedRequests > 0
    ? persistedRequests
    : Math.max(session.requests, historyTotalRequests)

  // Ratio: compute from all-time totals so it matches the all-time Tokens Saved /
  // processed cards. The session.savings_pct comes from this-process-only counters
  // and shows misleading 0-2% values right after restart when the persisted history
  // is multiple orders of magnitude larger than the current session.
  const allTimeSavingsPct = allTimeOriginalTokens > 0
    ? Math.round((allTimeSavedTokens / allTimeOriginalTokens) * 1000) / 10
    : 0

  // Breakdown: prefer persisted all-time values over session-only counters so
  // deterministic/dedup/sysprompt numbers stay consistent with the hero cards.
  const allTimeBreakdown = {
    tool_results_det: (persisted.det_saved_chars as number) ?? (session.breakdown?.tool_results_det ?? 0),
    tool_results_ai:  (persisted.ai_saved_chars as number) ?? (session.breakdown?.tool_results_ai ?? 0),
    read_dedup:       (persisted.dedup_saved_chars as number) ?? (session.breakdown?.read_dedup ?? 0),
    tool_desc:        (persisted.tool_desc_saved_chars as number) ?? (session.breakdown?.tool_desc ?? 0),
    mcp_filter:       (persisted.mcp_filter_saved_chars as number) ?? (session.breakdown?.mcp_filter ?? 0),
    stale_turns:      (persisted.stale_turns_saved_chars as number) ?? (session.breakdown?.stale_turns ?? 0),
    skill_dedup:      (persisted.skill_dedup_saved_chars as number) ?? (session.breakdown?.skill_dedup ?? 0),
    system_prompt:    (persisted.sysprompt_saved_chars as number) ?? (session.breakdown?.system_prompt ?? 0),
    overhead:         (persisted.overhead_chars as number) ?? (session.breakdown?.overhead ?? 0),
    ai_calls:         (persisted.ai_compression_calls as number) ?? (session.breakdown?.ai_calls ?? 0),
  }

  // ── Today (local calendar day) ──────────────────────────────────────────────
  // Read the date-stamped daily counters from stats.json. If the stored date is
  // not today (no request yet since midnight), all today totals are 0 — never
  // fall back to all-time, so the overview strictly reflects 00:00–now.
  const todayKey = new Date().toLocaleDateString('en-CA')
  const isToday = persisted.today_date === todayKey
  const todaySavedTokens = isToday ? Math.round(((persisted.today_saved_chars as number) ?? 0) / 3.5) : 0
  const todayOriginalTokens = isToday ? Math.round(((persisted.today_original_chars as number) ?? 0) / 3.5) : 0
  const todayRequests = isToday ? ((persisted.today_requests as number) ?? 0) : 0
const todaySavingsPct = todayOriginalTokens > 0
    ? Math.round((todaySavedTokens / todayOriginalTokens) * 1000) / 10
    : 0
  // Efficiency: savings as a % of the content we ACTUALLY compress (tool results),
  // not diluted by recent/kept/uncompressible payload. The honest "how good is the
  // compressor" number, vs savings_pct which is the overall request reduction.
  const compOrig = isToday ? ((persisted.today_comp_original_chars as number) ?? 0) : 0
  const compSaved = isToday ? ((persisted.today_comp_saved_chars as number) ?? 0) : 0
  const todayEfficiencyPct = compOrig > 0 ? Math.round((compSaved / compOrig) * 1000) / 10 : 0
  // Convert today's char-based per-model/per-client maps to the same token shape
  // the dashboard's buildModelHtml/buildClientHtml + calcCostFromModels expect.
  const toTokenBreakdown = (raw: unknown): Record<string, { requests: number; original_tokens: number; saved_tokens: number; savings_pct: number }> => {
    const out: Record<string, { requests: number; original_tokens: number; saved_tokens: number; savings_pct: number }> = {}
    if (isToday && raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, { requests?: number; originalChars?: number; savedChars?: number }>)) {
        const orig = v.originalChars ?? 0
        const saved = v.savedChars ?? 0
        out[k] = {
          requests: v.requests ?? 0,
          original_tokens: Math.round(orig / 3.5),
          saved_tokens: Math.round(saved / 3.5),
          savings_pct: orig > 0 ? Math.round((saved / orig) * 1000) / 10 : 0,
        }
      }
    }
    return out
  }
  // Today's AI usage (real backend calls + spend), date-guarded so a stale day reads 0.
  const aiTodayLive = aiUsageToday.date === todayKey
  const aiTodayCalls = aiTodayLive ? aiUsageToday.cloudCalls + aiUsageToday.localCalls : 0
  const aiTodayLocalCalls = aiTodayLive ? aiUsageToday.localCalls : 0
  const aiTodaySpentTokens = aiTodayLive ? aiUsageToday.cloudInputTokens + aiUsageToday.cloudOutputTokens : 0
  const aiTodaySavedTokens = isToday ? Math.round(((persisted.today_ai_saved_chars as number) ?? 0) / 3.5) : 0
  const today = {
    saved_tokens: todaySavedTokens,
    original_tokens: todayOriginalTokens,
    requests: todayRequests,
    ai_calls: aiTodayCalls,           // real AI backend calls today (cloud + local)
    savings_pct: todaySavingsPct,
    efficiency_pct: todayEfficiencyPct,   // % saved on compressed content (not diluted)
    date: todayKey,
    by_model: toTokenBreakdown(persisted.today_by_model),
    by_client: toTokenBreakdown(persisted.today_by_client),
    // AI Compression card (today-scoped, persists across restart, resets at midnight)
    ai_saved_tokens: aiTodaySavedTokens,
    ai_spent_tokens: aiTodaySpentTokens,
    ai_local_calls: aiTodayLocalCalls,
  }

  return {
    ...session,
    today,
    total_original_chars: allTimeOriginalTokens * 3.5,
    total_saved_chars: allTimeSavedTokens * 3.5,
    total_saved_tokens: allTimeSavedTokens,
    requests: allTimeRequests,
    savings_pct: allTimeSavingsPct,
    breakdown: allTimeBreakdown,
anthropic_native_compact: anthropicNativeCompactEnabled(),
    compression_backend: effectiveBackend(),
    // AI compression card: counters persisted across restarts (loaded at startup
    // from ai-usage.json) so the card doesn't reset to 0. Saved uses the all-time
    // persisted AI saving so it matches the persisted calls.
ai_usage: {
      // Cloud AI (Haiku/GPT/Gemini) — counts as cost
      calls: aiUsageCounters.calls,
      input_tokens: aiUsageCounters.inputTokens,
      output_tokens: aiUsageCounters.outputTokens,
      saved_chars: allTimeBreakdown.tool_results_ai ?? (session.breakdown?.tool_results_ai ?? 0),
      by_model: aiUsageByModel,
      // Local AI (Zest/Ollama) — free, no cost, savings still count
      local_calls: localAiUsageCounters.calls,
      local_input_tokens: localAiUsageCounters.inputTokens,
      local_output_tokens: localAiUsageCounters.outputTokens,
    },
    cache: getCache(config).stats(),
    expand_store_size: expandStoreSize(),
    session_cache_size: sessionCacheSize(),
    dry_run: config.dryRun,
    ai_compression_enabled: isAiCompressionEnabled(),
    pattern_hits: detPatternHits,
    version: VERSION,
    port: config.port,
    mode: runtimeOverrides.mode,
    limits: limitsSnapshot(),
    bypassed: isBypassed(),
    circuit_breaker: circuitBreaker.snapshot(),
    activity: recentLogLines(),
    guard: {
      accepted: compressionGuardCounters.accepted,
      rejected: compressionGuardCounters.rejected,
      reject_rate_pct: (compressionGuardCounters.accepted + compressionGuardCounters.rejected) > 0
        ? Math.round((compressionGuardCounters.rejected / (compressionGuardCounters.accepted + compressionGuardCounters.rejected)) * 1000) / 10
        : 0,
    },
// Reality check — HONEST net: gross saved (already net of the [squeezr:ID] tag)
    // minus the proxy's own costs it doesn't otherwise subtract: the squeezr_expand
    // tool injected into every request, and cloud AI compression spend (Zest=free).
    reality: (() => {
      // TODAY-scoped to match the hero (avoids the all-time-vs-today confusion).
      const grossSaved = todaySavedTokens
      const expandToolTokens = Math.round((todayRequests * EXPAND_TOOL_ANTHROPIC_CHARS) / 3.5)
      const aiSpent = aiTodaySpentTokens // cloud tokens today; local Zest is free
      const net = Math.max(0, grossSaved - expandToolTokens - aiSpent)
      const netPct = todayOriginalTokens > 0 ? Math.round((net / todayOriginalTokens) * 1000) / 10 : 0
      return {
        gross_saved_tokens: grossSaved,
        expand_tool_tokens: expandToolTokens,
        ai_spent_tokens: aiSpent,
        net_saved_tokens: net,
        net_pct: netPct,
      }
    })(),
    // Quality governor: evaluate the expand rate and auto-adjust AI aggressiveness.
    quality: (() => {
      const ratePct = session.expand?.rate_pct ?? 0
      const comps = session.compressions ?? 0
      const guardSamples = compressionGuardCounters.accepted + compressionGuardCounters.rejected
      const rejectRate = guardSamples > 0 ? Math.round((compressionGuardCounters.rejected / guardSamples) * 1000) / 10 : 0
      const g = governQuality(ratePct, comps, rejectRate, guardSamples)
      return { health: g.health, expand_rate_pct: ratePct, reject_rate_pct: rejectRate, ai_min_chars: g.aiMinChars, backoff_level: g.level }
    })(),
  }
}

app.get('/squeezr/stats', (c) => {
  return buildStatsPayload().then(d => c.json(d))
})

// ── POST /squeezr/ports — write port config to squeezr.toml ─────────────────
app.post('/squeezr/ports', async (c) => {
  const body = await c.req.json<{ port?: number; mitm_port?: number }>()
  const { port: newPort, mitm_port: newMitm } = body
  if (!newPort || !newMitm || newPort < 1024 || newMitm < 1024 || newPort === newMitm) {
    return c.text('Invalid ports', 400)
  }
  try {
    // Always write to ~/.squeezr/squeezr.toml — the bundled package toml gets
    // wiped on every `npm install -g`, which used to silently reset user
    // ports back to 8080 + autoscan after every update.
    const tomlPath = USER_CONFIG_PATH
    mkdirSync(USER_CONFIG_DIR, { recursive: true })
    let content = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf-8') : '[proxy]\n'

    // Update or insert [proxy] port and mitm_port
    const updateKey = (src: string, key: string, val: number): string => {
      const re = new RegExp(`^(\\s*${key}\\s*=\\s*)\\d+`, 'm')
      return re.test(src) ? src.replace(re, `$1${val}`) : src.replace(/(\[proxy\][^\[]*)/s, `$1${key} = ${val}\n`)
    }
    if (!content.includes('[proxy]')) content = '[proxy]\n' + content
    content = updateKey(content, 'port', newPort)
    content = updateKey(content, 'mitm_port', newMitm)
    writeFileSync(tomlPath, content, 'utf-8')
    return c.json({ ok: true, port: newPort, mitm_port: newMitm, toml: tomlPath })
  } catch (err: any) {
    return c.text('Failed to write squeezr.toml: ' + err.message, 500)
  }
})

app.get('/squeezr/health', (c) => {
  const cb = circuitBreaker.snapshot()
  const s = stats.summary()
  return c.json({
    // Magic identifier so callers can distinguish a real squeezr instance from
    // any other HTTP service that happens to answer 200 on this port (e.g. a
    // Docker container occupying the configured port).
    identity: 'squeezr',
    status: 'ok',
    version: VERSION,
    uptime_seconds: s.uptime_seconds,
    mode: runtimeOverrides.mode,
    bypassed: isBypassed(),
    circuit_breaker: {
      state: cb.state,
      consecutive_failures: cb.consecutive_failures,
      total_trips: cb.total_trips,
      last_success_ago_s: cb.last_success_time
        ? Math.round((Date.now() - cb.last_success_time) / 1000)
        : null,
    },
    expand_store: {
      size: expandStoreSize(),
      pressure: expandStoreSize() > 5000 ? 'high' : expandStoreSize() > 1000 ? 'medium' : 'low',
    },
    compression: {
      requests: s.requests,
      savings_pct: s.savings_pct,
    },
    port: config.port,
    mitm_port: config.mitmPort,
  })
})

// ── Self-test endpoint ─────────────────────────────────────────────────────
// Last self-test results are populated by src/selfTest.ts at startup and on
// demand via GET /squeezr/selftest?run=1.

let lastSelfTest: unknown = null
export function setLastSelfTest(result: unknown): void {
  lastSelfTest = result
}

app.get('/squeezr/selftest', async (c) => {
  if (c.req.query('run') === '1') {
    const { runSelfTest } = await import('./selfTest.js')
    const result = await runSelfTest({ port: Number(c.req.query('port')) || 0 })
    return c.json(result)
  }
  if (!lastSelfTest) {
    return c.json({ status: 'not_run', message: 'Self-test has not been executed yet. Call ?run=1 to execute.' })
  }
  return c.json(lastSelfTest)
})

// ── Project management ─────────────────────────────────────────────────────

app.get('/squeezr/project', (c) => {
  return c.json({ project: getManualProject() ?? stats.currentProjectName() })
})

app.post('/squeezr/project', async (c) => {
  const body = await c.req.json<{ project?: string | null }>()
  if (body.project === null || body.project === '') {
    setManualProject(null)
    return c.json({ project: stats.currentProjectName(), manual: false })
  }
  if (typeof body.project === 'string') {
    setManualProject(body.project)
    stats.setProject(body.project)
    return c.json({ project: body.project, manual: true })
  }
  return c.json({ error: 'Invalid project name' }, 400)
})

app.get('/squeezr/expand/:id', (c) => {
  const id = c.req.param('id')
  const original = retrieveOriginal(id)
  stats.recordExpand(!!original)
  if (!original) return c.json({ error: 'Not found or expired' }, 404)
  return c.json({ id, content: original })
})

// ── Dashboard + SSE + config ──────────────────────────────────────────────────

app.get('/squeezr/dashboard', (c) => {
  return c.html(DASHBOARD_HTML)
})
app.get('/squeezr/favicon.svg', (c) => {
  c.header('Content-Type', 'image/svg+xml')
  c.header('Cache-Control', 'public, max-age=86400')
  return c.body(LOGO_SVG)
})

app.get('/squeezr/events', (c) => {
  return streamSSE(c, async (s) => {
    await s.writeSSE({ data: JSON.stringify(await buildStatsPayload()) })
    while (true) {
      await s.sleep(2000)
      try {
        await s.writeSSE({ data: JSON.stringify(await buildStatsPayload()) })
      } catch { break }
    }
  })
})

app.get('/squeezr/limits', async (c) => {
  await maybeRefreshOpenAISessionLimits().catch(() => {})
  return c.json(limitsSnapshot())
})

// ── History + Projects endpoints ──────────────────────────────────────────────

app.get('/squeezr/history', (c) => {
  // sessions returns ONLY historical (past) sessions, current is separate
  // to avoid double-counting when dashboard does sessions.concat(current)
  return c.json({
    sessions: getHistorySessions().filter(s => s.id !== getCurrentSession().id),
    current: getCurrentSession(),
  })
})

app.get('/squeezr/projects', (c) => {
  return c.json({ projects: getProjectAggregates() })
})

// ── Control endpoints ─────────────────────────────────────────────────────────

app.post('/squeezr/control/stop', (c) => {
  // Respond first, then exit gracefully after a tick
  setTimeout(() => process.emit('SIGTERM' as any), 200)
  return c.json({ ok: true, message: 'Squeezr proxy shutting down…' })
})
app.post('/squeezr/control/restart', (c) => {
  // Spawn a fresh instance then exit so config changes take effect
  import('node:child_process').then(({ spawn }) => {
    import('node:url').then(({ fileURLToPath }) => {
      import('node:path').then(({ dirname, join }) => {
        import('node:os').then(({ homedir }) => {
          import('node:fs').then(({ openSync, closeSync }) => {
            const distDir = dirname(fileURLToPath(import.meta.url))
            const distIndex = join(distDir, 'index.js')
            const logFile = join(homedir(), '.squeezr', 'squeezr.log')
            try {
              const logFd = openSync(logFile, 'a')
              const child = spawn(process.execPath, [distIndex], {
                detached: true,
                stdio: ['ignore', logFd, logFd] as const,
                windowsHide: true,
                env: { ...process.env, SQUEEZR_DAEMON: '1', SQUEEZR_RESTART: '1' },
              })
              child.unref()
              closeSync(logFd)
              console.log(`[squeezr] Restart: new instance spawned (pid ${child.pid})`)
            } catch (e) {
              console.log(`[squeezr] Restart spawn failed: ${(e as Error).message}`)
            }
            setTimeout(() => process.emit('SIGTERM' as any), 300)
          })
        })
      })
    })
  })
  return c.json({ ok: true, message: 'Restarting Squeezr…' })
})

app.post('/squeezr/config', async (c) => {
  const body = await c.req.json<{ mode?: string }>()
  if (body.mode && ['soft','normal','aggressive','critical'].includes(body.mode)) {
    applyMode(body.mode as 'soft' | 'normal' | 'aggressive' | 'critical')
  }
  return c.json({ ok: true, mode: runtimeOverrides.mode })
})

// ── Bypass mode (runtime-only compression toggle) ────────────────────────────

app.get('/squeezr/bypass', (c) => {
  return c.json({ bypassed: isBypassed() })
})

app.post('/squeezr/bypass', async (c) => {
  try {
    const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({} as { enabled?: boolean }))
    if (typeof body.enabled === 'boolean') {
      setBypassed(body.enabled)
    } else {
      toggleBypassed()
    }
  } catch {
    toggleBypassed()
  }
  return c.json({ bypassed: isBypassed() })
})

// AI compression master toggle (persisted). When off, zero AI calls happen.
app.get('/squeezr/ai-compression', (c) => {
  return c.json({ enabled: isAiCompressionEnabled() })
})

app.post('/squeezr/ai-compression', async (c) => {
  try {
    const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({} as { enabled?: boolean }))
    if (typeof body.enabled === 'boolean') setAiCompression(body.enabled)
    else toggleAiCompression()
  } catch {
    toggleAiCompression()
  }
  return c.json({ enabled: isAiCompressionEnabled() })
})

// ── Distillation endpoint — uses captured OAuth token to compress with Opus ──
// Allows external scripts to do high-quality compression using the user's Claude
// Pro/Max subscription (no API key needed). Used by recipes/Zest (zest-0.8b) for training.
app.post('/squeezr/distill', async (c) => {
  const rawBody = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const text = String(rawBody.text ?? '')
  const variant = String(rawBody.variant ?? 'balanced')
  const model = String(rawBody.model ?? 'claude-opus-4-7-20260416')
  if (!text || text.length < 10) {
    return c.json({ error: 'text required' }, 400)
  }

  const token = storedKey('anthropic')
  if (!token) {
    return c.json({ error: 'No anthropic OAuth token captured yet. Use Claude Code once first.' }, 401)
  }

  const VARIANT_PROMPTS: Record<string, string> = {
    conservative: 'CONSERVATIVE compression (30-40% reduction). Keep most detail: all file paths, function names, error messages with line numbers, test failures with assertions, all distinct stack frames. Remove only decorative content, whitespace, duplicate progress indicators.',
    balanced: 'BALANCED compression (50-60% reduction). Keep file paths, function names, error messages with line numbers (truncate long messages to essentials), failing test names and assertions, key values. Remove verbose explanations, repeated info, decorative formatting, stack traces beyond first frame.',
    aggressive: 'AGGRESSIVE compression (70-85% reduction). Bare essentials only: file paths, identifier names, error type + line, test pass/fail counts + failing test names, single most important value. Remove all explanations, all but critical assertions, all stack frames, all progress/timestamps/decorations.',
  }
  const variantPrompt = VARIANT_PROMPTS[variant] ?? VARIANT_PROMPTS.balanced

  const prompt = `You are an expert at compressing AI coding tool outputs.

${variantPrompt}

Output ONLY the compressed text. No preamble, no markdown fences, no explanation.

---
TOOL OUTPUT TO COMPRESS:

${text}`

  try {
// OAuth tokens (sk-ant-oat...) must go as Bearer + oauth beta header — as x-api-key they 401
    const isOAuth = token.startsWith('sk-ant-oat') || !token.startsWith('sk-')
    const authOpts = isOAuth ? { authToken: token } : { apiKey: token }
    const oauthHeaders = isOAuth ? { 'anthropic-beta': 'oauth-2025-04-20' } : undefined
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ ...authOpts, baseURL: 'https://api.anthropic.com', defaultHeaders: oauthHeaders })
    const t0 = Date.now()
    const resp = await client.messages.create({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    })
    const compressed = (resp.content[0] as { text: string }).text.trim()
    return c.json({
      compressed,
      original_length: text.length,
      compressed_length: compressed.length,
      ratio: 1 - compressed.length / Math.max(text.length, 1),
      variant,
      model,
      latency_ms: Date.now() - t0,
    })
  } catch (e: any) {
    const status = e?.status ?? 500
    return c.json({ error: String(e?.message ?? e), status }, status as 429 | 500)
  }
})

// Write `backend = "..."` into the [compression] table of ~/.squeezr/squeezr.toml,
// preserving the rest of the file. Inserts the [compression] table if missing.
function persistBackendToToml(backend: CompressionBackend): void {
  try {
    const tomlPath = USER_CONFIG_PATH
    mkdirSync(USER_CONFIG_DIR, { recursive: true })
    let content = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf-8') : '[compression]\n'
    if (!/\[compression\]/.test(content)) content = '[compression]\n' + content
    const re = /^(\s*backend\s*=\s*)["'][^"']*["']/m
    if (re.test(content)) {
      content = content.replace(re, `$1"${backend}"`)
    } else {
      // Insert right after the [compression] header line.
      content = content.replace(/(\[compression\][^\n]*\n)/, `$1backend = "${backend}"\n`)
    }
    writeFileSync(tomlPath, content, 'utf-8')
    console.log(`[squeezr] backend persisted to squeezr.toml: ${backend}`)
  } catch (e) {
    console.log(`[squeezr] failed to persist backend to toml: ${(e as Error).message}`)
  }
}

// Clear the session compression cache. Useful after switching backend (e.g. from
// Haiku to Zest): the cache may hold results produced by the OLD backend, which
// get replayed for free and prevent the new backend from ever running. Clearing
// forces the new backend to recompress fresh blocks.
app.post('/squeezr/cache/clear', (c) => {
  // Clear BOTH compression caches so the active backend (e.g. Zest) actually
  // recompresses, instead of replaying results made by the old backend:
  //  1. session cache (session_cache.json) — per-tool-result blocks
  //  2. LRU compression cache (cache.json)  — preprocessed-text → result, the
  //     one that was silently serving Haiku-era compressions without calling Zest.
  const sessionBefore = sessionCacheSize()
  clearSessionCache()
  const lruBefore = getCache(config).clear()
  console.log(`[squeezr] caches cleared — session: ${sessionBefore} block(s), LRU: ${lruBefore} entr(ies). Next requests recompress with the active backend.`)
  return c.json({ ok: true, session_cleared: sessionBefore, lru_cleared: lruBefore })
})
// Get/set compression backend (which AI model compresses tool results)
app.get('/squeezr/backend', (c) => {
  return c.json({ backend: effectiveBackend() })
})

app.post('/squeezr/backend', async (c) => {
  try {
    const body = await c.req.json<{ backend?: string }>().catch(() => ({} as { backend?: string }))
    const valid: CompressionBackend[] = ['auto', 'local', 'haiku', 'gpt-mini', 'gemini-flash']
    if (body.backend && valid.includes(body.backend as CompressionBackend)) {
      runtimeOverrides.compressionBackend = body.backend as CompressionBackend
      // Persist to ~/.squeezr/squeezr.toml so the choice survives restarts — the
      // previous in-memory-only override silently reverted to `auto` (= Haiku on
      // OAuth) on every restart, which burned the user's 5h plan.
      persistBackendToToml(body.backend as CompressionBackend)
    }
  } catch { /* ignore */ }
  return c.json({ backend: effectiveBackend() })
})

// Toggle Anthropic native compaction beta (compact-2026-01-12)
app.get('/squeezr/native-compact', (c) => {
  return c.json({ enabled: anthropicNativeCompactEnabled() })
})

app.post('/squeezr/native-compact', async (c) => {
  try {
    const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({} as { enabled?: boolean }))
    if (typeof body.enabled === 'boolean') {
      runtimeOverrides.anthropicNativeCompact = body.enabled
    } else {
      runtimeOverrides.anthropicNativeCompact = !anthropicNativeCompactEnabled()
    }
  } catch {
    runtimeOverrides.anthropicNativeCompact = !anthropicNativeCompactEnabled()
  }
  return c.json({ enabled: anthropicNativeCompactEnabled() })
})

// ── OAuth token refresh proxy (Codex: set CODEX_REFRESH_TOKEN_URL_OVERRIDE=http://localhost:PORT/oauth/token) ──

app.post('/oauth/token', async (c) => {
  const body = await c.req.arrayBuffer()
  const resp = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': c.req.header('content-type') ?? 'application/json' },
    body,
  })
  const data = await resp.arrayBuffer()
  return c.body(data, resp.status as any, { 'content-type': 'application/json' })
})


// ── Catch-all ─────────────────────────────────────────────────────────────────

app.all('*', async (c) => {
  let upstream = detectUpstream(c.req.raw.headers)
  const url = new URL(c.req.url)
  const NEEDS_V1 = new Set(['/models', '/engines', '/files', '/embeddings', '/moderations', '/completions', '/edits', '/responses'])
  const pathname = NEEDS_V1.has(url.pathname) ? `/v1${url.pathname}` : url.pathname

  // /responses is exclusively an OpenAI Codex endpoint — override upstream regardless
  // of what detectUpstream inferred from headers (Codex sends no auth to custom base URLs).
  if (pathname === '/v1/responses') upstream = OPENAI_API

  const targetUrl = `${upstream}${pathname}${url.search}`
  const body = await c.req.arrayBuffer()
  const fwdHeaders = forwardHeaders(c.req.raw.headers)

  // Inject Codex OAuth token from ~/.codex/auth.json when no auth header present.
  if (upstream === OPENAI_API && !fwdHeaders['authorization']) {
    const codexToken = readCodexToken()
    if (codexToken) fwdHeaders['authorization'] = `Bearer ${codexToken}`
  }

  const resp = await fetch(targetUrl, {
    method: c.req.method,
    headers: fwdHeaders,
    body: body.byteLength > 0 ? body : undefined,
  })

  const respHeaders: Record<string, string> = {}
  for (const [k, v] of resp.headers.entries()) {
    if (!SKIP_RESP_HEADERS.has(k.toLowerCase())) respHeaders[k] = v
  }

  const contentType = resp.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    return stream(c, async (s) => {
      const reader = resp.body!.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await s.write(value)
      }
    })
  }
  return c.body(await resp.arrayBuffer(), resp.status as any, respHeaders)
})
