import { describe, it, expect, vi, beforeEach } from 'vitest'
import { clearExpandStore } from '../expand.js'
import { clearSessionCache } from '../sessionCache.js'
import { runtimeOverrides } from '../config.js'

// Mock AI SDKs before importing compressor
vi.mock('@anthropic-ai/sdk', () => ({
  // function (not arrow) — `new Anthropic()` requires a constructable implementation
  default: vi.fn().mockImplementation(function () {
    return {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ text: 'AI compressed summary' }],
        }),
      },
    }
  }),
}))

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: 'AI compressed summary' } }],
          }),
        },
      },
    }
  }),
}))

// Force the AI compression master toggle ON for these tests (production default
// is off + persisted to disk; tests must not depend on the user's local state).
vi.mock('../aiToggle.js', () => ({
  isAiCompressionEnabled: () => true,
  setAiCompression: () => {},
  toggleAiCompression: () => true,
}))

// Mock fetch for the fetch-based backends. Must satisfy BOTH shapes because the
// default backend is now `local` (Ollama, /api/chat → {message:{content}}) and
// effectiveBackend() reads the global config singleton, not the per-test config.
// Gemini uses {candidates}. `ok: true` keeps ollamaCompressChunk from throwing.
const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({
    candidates: [{ content: { parts: [{ text: 'AI compressed summary' }] } }],
    message: { content: 'AI compressed summary' },
    prompt_eval_count: 10,
    eval_count: 5,
  }),
})
vi.stubGlobal('fetch', mockFetch)

import {
  compressAnthropicMessages,
  compressOpenAIMessages,
  compressGeminiContents,
  getCache,
} from '../compressor.js'

// Minimal config mock
const baseConfig = {
  disabled: false,
  dryRun: false,
  cacheEnabled: false,  // disable to avoid file I/O in tests
  cacheMaxEntries: 100,
  keepRecent: 1,
  threshold: 50,
  adaptiveEnabled: false,
  adaptiveLow: 1500,
  adaptiveMid: 800,
  adaptiveHigh: 400,
  adaptiveCritical: 150,
  localUpstreamUrl: 'http://localhost:11434',
  localCompressionModel: 'qwen2.5-coder:1.5b',
  thresholdForPressure: () => 50,
  isLocalKey: () => false,
  shouldSkipTool: () => false,
  skipTools: new Set<string>(),
  onlyTools: new Set<string>(),
  aiSkipTools: new Set<string>(),
  aiCompression: true,  // tests exercise the AI path; production default is false
  compressConversation: false,
  keepRecentAssistant: 3,
  assistantThreshold: 300,
} as any

beforeEach(() => {
  clearExpandStore()
  clearSessionCache()
  vi.clearAllMocks()
  // effectiveBackend() reads the GLOBAL config singleton (default `local`), so by
  // default these tests exercise the Ollama path (mock fetch above returns a valid
  // Ollama-shaped body). Tests that need a specific cloud backend set it explicitly.
  runtimeOverrides.compressionBackend = undefined
})

// ── Anthropic format ──────────────────────────────────────────────────────────

describe('compressAnthropicMessages', () => {
  function makeMessages(toolResults: string[]) {
    return toolResults.flatMap((text, i) => [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `tool_${i}`, name: 'Bash' }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `tool_${i}`, content: text }],
      },
    ])
  }

  it('returns messages unchanged when disabled', async () => {
    const msgs = makeMessages(['some tool output'])
    const [result] = await compressAnthropicMessages(msgs as any, 'key', { ...baseConfig, disabled: true })
    expect(result).toEqual(msgs)
  })

  it('returns messages unchanged when no tool results', async () => {
    const msgs = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }]
    const [result] = await compressAnthropicMessages(msgs as any, 'key', baseConfig)
    expect(result).toEqual(msgs)
  })

  it('does not compress recent blocks (keepRecent=1)', async () => {
    const longText = 'x'.repeat(200)
    const msgs = makeMessages([longText])
    const [result] = await compressAnthropicMessages(msgs as any, 'key', baseConfig)
    // Only 1 message, it's recent — should not be AI compressed
    const block = (result[1] as any).content[0]
    expect(block.content).not.toContain('[squeezr:')
  })

  it('compresses old blocks beyond keepRecent', async () => {
    // distinct texts — identical blocks would be collapsed by cross-turn dedup first
    const msgs = makeMessages(['x'.repeat(1600), 'y'.repeat(1600)])
    const [result, savings] = await compressAnthropicMessages(msgs as any, 'key', baseConfig)
    // First block should be compressed
    const firstBlock = (result[1] as any).content[0]
    expect(firstBlock.content).toContain('[squeezr:')
    expect(savings.compressed).toBe(1)
  })

  it('embeds squeezr ID and ratio in compressed content', async () => {
    const msgs = makeMessages(['x'.repeat(1600), 'y'.repeat(1600)])
    const [result] = await compressAnthropicMessages(msgs as any, 'key', baseConfig)
    const compressed = (result[1] as any).content[0].content as string
    expect(compressed).toMatch(/\[squeezr:[a-f0-9]{6} -\d+% — squeezr_expand\("[a-f0-9]{6}"\) for full exact text\]/)
  })

  it('does not compress blocks below threshold', async () => {
    const shortText = 'short'  // below threshold of 50
    const msgs = makeMessages([shortText, shortText])
    const [, savings] = await compressAnthropicMessages(msgs as any, 'key', baseConfig)
    expect(savings.compressed).toBe(0)
  })

  it('returns dry-run savings without modifying messages', async () => {
    const msgs = makeMessages(['x'.repeat(1600), 'y'.repeat(1600)])
    const [result, savings] = await compressAnthropicMessages(msgs as any, 'key', { ...baseConfig, dryRun: true })
    expect(savings.dryRun).toBe(true)
    // Messages should not be modified
    const block = (result[1] as any).content[0]
    expect(block.content).not.toContain('[squeezr:')
  })

  it('uses session cache on second call with same content', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default as any
    const msgs = makeMessages(['x'.repeat(200), 'y'.repeat(200)])

    // First call — compresses
    await compressAnthropicMessages(msgs as any, 'key', baseConfig)
    const callsAfterFirst = Anthropic.mock.results[0]?.value?.messages?.create?.mock?.calls?.length ?? 0

    // Second call — should hit session cache
    await compressAnthropicMessages(msgs as any, 'key', baseConfig)
    const callsAfterSecond = Anthropic.mock.results[1]?.value?.messages?.create?.mock?.calls?.length ?? 0

    // Session cache should prevent additional AI calls for the same content
    expect(callsAfterSecond).toBe(0)
  })

  it('applies deterministic preprocessing to all blocks including recent', async () => {
    // Recent block with git diff — deterministic should still apply
    const gitDiff = `diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,3 @@\n context1\n-old\n+new\n context2\n context3\n context4`
    const msgs = makeMessages([gitDiff])
    const [result] = await compressAnthropicMessages(msgs as any, 'key', baseConfig)
    const content = (result[1] as any).content[0].content as string
    // context3 and context4 should be stripped by git diff pattern
    expect(content).not.toContain('context4')
  })

  it('tracks savings correctly', async () => {
    const msgs = makeMessages(['x'.repeat(1600), 'y'.repeat(1600)])
    const [, savings] = await compressAnthropicMessages(msgs as any, 'key', baseConfig)
    expect(savings.savedChars).toBeGreaterThan(0)
    expect(savings.originalChars).toBeGreaterThan(0)
    expect(savings.byTool.length).toBeGreaterThan(0)
  })

  it('NEVER AI-compresses tool results at or before the cache_control barrier', async () => {
    // AI compression is not byte-stable → would invalidate the prompt cache.
    // A block under (or before) the last cache_control marker must never get an
    // [squeezr:ID] AI placeholder. Deterministic cleanup MAY touch it (it's stable).
    const oldText = 'old line\n'.repeat(50)   // compressible (dup lines) but cached
    const newText = 'new line\n'.repeat(50)
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'Bash' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: oldText, cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: newText }] },
    ]
    const [result, savings] = await compressAnthropicMessages(msgs as any, 'key', baseConfig)
    // Cached block must NOT have an AI placeholder, and cache_control must survive.
    expect(String((result[1] as any).content[0].content)).not.toContain('[squeezr:')
    expect((result[1] as any).content[0].cache_control).toEqual({ type: 'ephemeral' })
    // AI compression count is 0 here: the only old block is the cached one (skipped),
    // the new block is within keepRecent.
    expect(savings.compressed).toBe(0)
  })
  it('deterministic cleanup IS allowed on the cached prefix (it is byte-stable)', async () => {
    // A block with duplicate lines under cache_control: det dedup may shrink it,
    // but the result is identical every request → cache stays valid.
    const dupText = 'same\n'.repeat(60)  // dedup-able by deterministic pass
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'Bash' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: dupText, cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'tail\n'.repeat(60) }] },
    ]
    // Run twice — the cached block's output must be byte-identical (stable).
    const [r1] = await compressAnthropicMessages(msgs as any, 'key', baseConfig)
    const [r2] = await compressAnthropicMessages(msgs as any, 'key', baseConfig)
    const out1 = String((r1[1] as any).content[0].content)
    const out2 = String((r2[1] as any).content[0].content)
    expect(out1).toBe(out2)  // stable between requests → cache-safe
    expect((r1[1] as any).content[0].cache_control).toEqual({ type: 'ephemeral' })
  })
  it('compresses freely when there is no cache_control marker', async () => {
    const msgs = makeMessages(['x'.repeat(1600), 'y'.repeat(1600)])
    const [, savings] = await compressAnthropicMessages(msgs as any, 'key', baseConfig)
    // No barrier → old block is eligible for AI compression
    expect(savings.compressed).toBe(1)
  })
})

// ── OpenAI format ─────────────────────────────────────────────────────────────

describe('compressOpenAIMessages', () => {
  function makeMessages(toolResults: string[]) {
    return toolResults.flatMap((text, i) => [
      {
        role: 'assistant',
        tool_calls: [{ id: `call_${i}`, function: { name: 'bash' } }],
      },
      {
        role: 'tool',
        tool_call_id: `call_${i}`,
        content: text,
      },
    ])
  }

  it('returns messages unchanged when disabled', async () => {
    const msgs = makeMessages(['output'])
    const [result] = await compressOpenAIMessages(msgs as any, 'key', { ...baseConfig, disabled: true })
    expect(result).toEqual(msgs)
  })

  it('compresses old tool messages', async () => {
    const msgs = makeMessages(['y'.repeat(200), 'w'.repeat(200)])
    const [result, savings] = await compressOpenAIMessages(msgs as any, 'key', baseConfig)
    expect((result[1] as any).content).toContain('[squeezr:')
    expect(savings.compressed).toBe(1)
  })

  it('uses Ollama backend for local keys', async () => {
    const msgs = makeMessages(['z'.repeat(1600), 'v'.repeat(1600)])
    await compressOpenAIMessages(msgs as any, 'ollama-key', { ...baseConfig, isLocalKey: () => true }, true)
    // Local compression uses Ollama's native /api/chat over fetch (not the OpenAI SDK).
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/chat'),
      expect.any(Object),
    )
  })

  it('does not inject expand tool for local requests', async () => {
    const msgs = makeMessages(['short'])
    // isLocal = true means no expand tool injection (handled in server.ts)
    const [result] = await compressOpenAIMessages(msgs as any, 'key', baseConfig, true)
    // Result should not have squeezr tool injected (that's server.ts's job)
    expect(result).toBeDefined()
  })

  it('returns dry-run without modifications', async () => {
    const oldText = 'z'.repeat(200)
    const msgs = makeMessages([oldText, 'v'.repeat(200)])
    const [result, savings] = await compressOpenAIMessages(msgs as any, 'key', { ...baseConfig, dryRun: true })
    expect(savings.dryRun).toBe(true)
    expect((result[1] as any).content).toBe(oldText)
  })
})

// ── Gemini format ─────────────────────────────────────────────────────────────

describe('compressGeminiContents', () => {
  function makeContents(responses: string[]) {
    return responses.flatMap((text, i) => [
      { role: 'model', parts: [{ functionCall: { name: 'bash', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'bash', response: text } }] },
    ])
  }

  it('returns contents unchanged when disabled', async () => {
    const cts = makeContents(['output'])
    const [result] = await compressGeminiContents(cts as any, 'key', { ...baseConfig, disabled: true })
    expect(result).toEqual(cts)
  })

  it('returns unchanged when no function responses', async () => {
    const cts = [{ role: 'user', parts: [{ text: 'hello' }] }]
    const [result] = await compressGeminiContents(cts as any, 'key', baseConfig)
    expect(result).toEqual(cts)
  })

  it('compresses old function responses', async () => {
    const cts = makeContents(['g'.repeat(200), 'h'.repeat(200)])
    const [result, savings] = await compressGeminiContents(cts as any, 'key', baseConfig)
    const response = (result[1] as any).parts[0].functionResponse.response
    expect(JSON.stringify(response)).toContain('[squeezr:')
    expect(savings.compressed).toBe(1)
  })

  it('uses fetch with Gemini API URL', async () => {
    runtimeOverrides.compressionBackend = 'auto'  // use the per-API default (Gemini), not the global `local`
    const cts = makeContents(['g'.repeat(200), 'h'.repeat(200)])
    await compressGeminiContents(cts as any, 'my-google-key', baseConfig)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('generativelanguage.googleapis.com'),
      expect.any(Object),
    )
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('my-google-key'),
      expect.any(Object),
    )
  })

  it('returns dry-run without modifications', async () => {
    const oldText = 'g'.repeat(200)
    const cts = makeContents([oldText, 'h'.repeat(200)])
    const [result, savings] = await compressGeminiContents(cts as any, 'key', { ...baseConfig, dryRun: true })
    expect(savings.dryRun).toBe(true)
    const response = (result[1] as any).parts[0].functionResponse.response
    expect(response).toBe(oldText)
  })
})

// ── skip_tools / only_tools / squeezr:skip ────────────────────────────────────

describe('skip_tools and squeezr:skip', () => {
  // Per-block texts — identical blocks would be collapsed by cross-turn dedup
  function makeMessages(toolName: string, textOld: string, textRecent: string) {
    return [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_0', name: toolName }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_0', content: textOld }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: toolName }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: textRecent }] },
    ]
  }

  it('skips tool when shouldSkipTool returns true', async () => {
    const longText = 'x'.repeat(200)
    const msgs = makeMessages('Read', longText, 'y'.repeat(200))
    const skipConfig = { ...baseConfig, shouldSkipTool: (t: string) => t.toLowerCase() === 'read' }
    const [result, savings] = await compressAnthropicMessages(msgs as any, 'key', skipConfig)
    expect(savings.compressed).toBe(0)
    expect((result[1] as any).content[0].content).toBe(longText)
  })

  it('compresses tool when shouldSkipTool returns false', async () => {
    const msgs = makeMessages('Bash', 'x'.repeat(1600), 'y'.repeat(1600))
    const [, savings] = await compressAnthropicMessages(msgs as any, 'key', baseConfig)
    expect(savings.compressed).toBe(1)
  })

  it('respects squeezr:skip inline marker — does not compress that block', async () => {
    // Unique text per block — identical blocks would be collapsed by cross-turn dedup
    const skipText = 'x'.repeat(1600)
    // 3 tool calls: tool_0 (skip marker), tool_1 (old, compressible), tool_2 (recent, kept)
    const msgs = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_0', name: 'Bash', input: { command: 'git diff HEAD~3  # squeezr:skip' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_0', content: skipText }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'some other command' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'y'.repeat(1600) }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_2', name: 'Bash', input: { command: 'another command' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_2', content: 'z'.repeat(1600) }] },
    ]
    const [result, savings] = await compressAnthropicMessages(msgs as any, 'key', baseConfig)
    // tool_0 has squeezr:skip → not compressed
    expect((result[1] as any).content[0].content).toBe(skipText)
    // tool_1 is old and not skipped → compressed
    expect(savings.compressed).toBe(1)
  })
})

// ── getCache ──────────────────────────────────────────────────────────────────

describe('getCache', () => {
  it('returns a CompressionCache instance', () => {
    const cache = getCache(baseConfig)
    expect(cache).toBeDefined()
    expect(typeof cache.get).toBe('function')
    expect(typeof cache.set).toBe('function')
    expect(typeof cache.stats).toBe('function')
  })

  it('returns the same instance on repeated calls', () => {
    const c1 = getCache(baseConfig)
    const c2 = getCache(baseConfig)
    expect(c1).toBe(c2)
  })
})
