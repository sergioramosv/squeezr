import { describe, it, expect, beforeEach } from 'vitest'
import {
  storeOriginal,
  retrieveOriginal,
  expandStoreSize,
  clearExpandStore,
  injectExpandToolAnthropic,
  injectExpandToolOpenAI,
  injectExpandDirectiveAnthropic,
  injectExpandDirectiveOpenAI,
  handleAnthropicExpandCall,
  handleOpenAIExpandCall,
  EXPAND_DIRECTIVE_SENTINEL,
  EXPAND_TOOL_DESCRIPTION,
} from '../expand.js'

describe('expand tool description (forceful)', () => {
  it('is imperative and names squeezr_expand + the no-guess rule', () => {
    expect(EXPAND_TOOL_DESCRIPTION).toMatch(/MUST call squeezr_expand/)
    expect(EXPAND_TOOL_DESCRIPTION).toMatch(/NEVER guess|do not guess|never guess/i)
  })
})

describe('injectExpandToolAnthropic — defers to a client-executable MCP expand tool', () => {
  it('does NOT inject the bare tool when mcp__squeezr__squeezr_expand is present', () => {
    const body: Record<string, unknown> = { tools: [{ name: 'mcp__squeezr__squeezr_expand' }] }
    injectExpandToolAnthropic(body)
    const names = (body.tools as Array<{ name: string }>).map(t => t.name)
    expect(names.filter(n => n.endsWith('squeezr_expand')).length).toBe(1)
    expect(names).not.toContain('squeezr_expand') // bare not added (only the MCP one)
  })
  it('still injects the bare tool when no expand tool is present', () => {
    const body: Record<string, unknown> = { tools: [{ name: 'Read' }] }
    injectExpandToolAnthropic(body)
    expect((body.tools as Array<{ name: string }>).some(t => t.name === 'squeezr_expand')).toBe(true)
  })
})
describe('injectExpandDirectiveAnthropic', () => {
  it('appends a NEW trailing block and never mutates existing cache_control blocks', () => {
    const cached = { type: 'text', text: 'SYSTEM CORE', cache_control: { type: 'ephemeral' } }
    const body: Record<string, unknown> = { system: [cached] }
    const before = JSON.stringify(cached)
    injectExpandDirectiveAnthropic(body)
    const sys = body.system as Array<{ type?: string; text?: string }>
    // The original cached block is byte-for-byte identical (cache stays valid)
    expect(JSON.stringify(sys[0])).toBe(before)
    // A new trailing directive block was added without cache_control
    expect(sys.length).toBe(2)
    expect(sys[1].text).toContain(EXPAND_DIRECTIVE_SENTINEL)
    expect(sys[1]).not.toHaveProperty('cache_control')
  })

  it('is idempotent (does not add the directive twice)', () => {
    const body: Record<string, unknown> = { system: [{ type: 'text', text: 'core' }] }
    injectExpandDirectiveAnthropic(body)
    injectExpandDirectiveAnthropic(body)
    const sys = body.system as unknown[]
    expect(sys.length).toBe(2)
  })

  it('handles string system prompts', () => {
    const body: Record<string, unknown> = { system: 'you are a coding agent' }
    injectExpandDirectiveAnthropic(body)
    expect(body.system as string).toContain(EXPAND_DIRECTIVE_SENTINEL)
    // idempotent on strings too
    const after = body.system
    injectExpandDirectiveAnthropic(body)
    expect(body.system).toBe(after)
  })

  it('creates a system prompt when none exists', () => {
    const body: Record<string, unknown> = {}
    injectExpandDirectiveAnthropic(body)
    expect(body.system as string).toContain(EXPAND_DIRECTIVE_SENTINEL)
  })
})

describe('injectExpandDirectiveOpenAI', () => {
  it('appends to an existing system message, idempotently', () => {
    const body: Record<string, unknown> = { messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }] }
    injectExpandDirectiveOpenAI(body)
    const msgs = body.messages as Array<{ role: string; content: string }>
    expect(msgs[0].content).toContain(EXPAND_DIRECTIVE_SENTINEL)
    injectExpandDirectiveOpenAI(body)
    expect((msgs[0].content.match(new RegExp(EXPAND_DIRECTIVE_SENTINEL.replace(/[[\]/]/g, '\\$&'), 'g')) ?? []).length).toBe(1)
  })

  it('prepends a system message when none exists', () => {
    const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'hi' }] }
    injectExpandDirectiveOpenAI(body)
    const msgs = body.messages as Array<{ role: string; content: string }>
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain(EXPAND_DIRECTIVE_SENTINEL)
  })
})

describe('storeOriginal / retrieveOriginal', () => {
  beforeEach(() => clearExpandStore())

  it('stores and retrieves original content', () => {
    const id = storeOriginal('hello world')
    expect(retrieveOriginal(id)).toBe('hello world')
  })

  it('returns undefined for unknown ID', () => {
    expect(retrieveOriginal('zzzzzz')).toBeUndefined()
  })

  it('returns a 6-char hex ID', () => {
    const id = storeOriginal('test')
    expect(id).toMatch(/^[a-f0-9]{6}$/)
  })

  it('is deterministic — same content always same ID', () => {
    const id1 = storeOriginal('foo bar baz')
    clearExpandStore()
    const id2 = storeOriginal('foo bar baz')
    expect(id1).toBe(id2)
  })

  it('different content produces different IDs', () => {
    const id1 = storeOriginal('content one')
    const id2 = storeOriginal('content two')
    expect(id1).not.toBe(id2)
  })

  it('overwrites store entry if same content stored twice', () => {
    storeOriginal('same')
    storeOriginal('same')
    expect(expandStoreSize()).toBe(1)
  })
})

describe('expandStoreSize / clearExpandStore', () => {
  beforeEach(() => clearExpandStore())

  it('starts at 0', () => {
    expect(expandStoreSize()).toBe(0)
  })

  it('increments on store', () => {
    storeOriginal('a')
    storeOriginal('b')
    expect(expandStoreSize()).toBe(2)
  })

  it('clears to 0', () => {
    storeOriginal('x')
    clearExpandStore()
    expect(expandStoreSize()).toBe(0)
  })
})

// ── injectExpandToolAnthropic ─────────────────────────────────────────────────

describe('injectExpandToolAnthropic', () => {
  it('adds squeezr_expand tool when tools array is empty', () => {
    const body: Record<string, unknown> = { tools: [] }
    injectExpandToolAnthropic(body)
    expect((body.tools as unknown[]).length).toBe(1)
    expect((body.tools as Array<{ name: string }>)[0].name).toBe('squeezr_expand')
  })

  it('creates tools array if missing', () => {
    const body: Record<string, unknown> = {}
    injectExpandToolAnthropic(body)
    expect(Array.isArray(body.tools)).toBe(true)
    expect((body.tools as unknown[]).length).toBe(1)
  })

  it('does not add duplicate if already injected', () => {
    const body: Record<string, unknown> = { tools: [] }
    injectExpandToolAnthropic(body)
    injectExpandToolAnthropic(body)
    expect((body.tools as unknown[]).length).toBe(1)
  })

  it('preserves existing tools', () => {
    const body: Record<string, unknown> = { tools: [{ name: 'read_file' }] }
    injectExpandToolAnthropic(body)
    expect((body.tools as unknown[]).length).toBe(2)
    expect((body.tools as Array<{ name: string }>)[0].name).toBe('read_file')
  })

  it('injected tool has correct input_schema', () => {
    const body: Record<string, unknown> = {}
    injectExpandToolAnthropic(body)
    const tool = (body.tools as Array<{ input_schema: { properties: { id: unknown } } }>)[0]
    expect(tool.input_schema.properties.id).toBeDefined()
  })
})

// ── injectExpandToolOpenAI ────────────────────────────────────────────────────

describe('injectExpandToolOpenAI', () => {
  it('adds squeezr_expand tool in OpenAI format', () => {
    const body: Record<string, unknown> = {}
    injectExpandToolOpenAI(body)
    const tools = body.tools as Array<{ type: string; function: { name: string } }>
    expect(tools[0].type).toBe('function')
    expect(tools[0].function.name).toBe('squeezr_expand')
  })

  it('does not add duplicate', () => {
    const body: Record<string, unknown> = {}
    injectExpandToolOpenAI(body)
    injectExpandToolOpenAI(body)
    expect((body.tools as unknown[]).length).toBe(1)
  })
})

// ── handleAnthropicExpandCall ─────────────────────────────────────────────────

describe('handleAnthropicExpandCall', () => {
  beforeEach(() => clearExpandStore())

  it('returns null when no tool_use in response', () => {
    const resp = { content: [{ type: 'text', text: 'hello' }] }
    expect(handleAnthropicExpandCall(resp)).toBeNull()
  })

  it('returns null for non-squeezr tool calls', () => {
    const resp = { content: [{ type: 'tool_use', id: 'x', name: 'read_file', input: { path: '/foo' } }] }
    expect(handleAnthropicExpandCall(resp)).toBeNull()
  })

  it('returns null when ID not in store', () => {
    const resp = {
      content: [{ type: 'tool_use', id: 'call_1', name: 'squeezr_expand', input: { id: 'aabbcc' } }],
    }
    expect(handleAnthropicExpandCall(resp)).toBeNull()
  })

  it('returns toolUseId and original when ID found', () => {
    const id = storeOriginal('the original content')
    const resp = {
      content: [{ type: 'tool_use', id: 'call_abc', name: 'squeezr_expand', input: { id } }],
    }
    const result = handleAnthropicExpandCall(resp)
    expect(result).not.toBeNull()
    expect(result!.toolUseId).toBe('call_abc')
    expect(result!.original).toBe('the original content')
  })

  it('returns null when response has no content', () => {
    expect(handleAnthropicExpandCall({})).toBeNull()
  })
})

// ── handleOpenAIExpandCall ────────────────────────────────────────────────────

describe('handleOpenAIExpandCall', () => {
  beforeEach(() => clearExpandStore())

  it('returns null when no choices', () => {
    expect(handleOpenAIExpandCall({})).toBeNull()
  })

  it('returns null when no tool_calls', () => {
    const resp = { choices: [{ message: { content: 'hello' } }] }
    expect(handleOpenAIExpandCall(resp)).toBeNull()
  })

  it('returns null for non-squeezr tool calls', () => {
    const resp = {
      choices: [{
        message: {
          tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{}' } }],
        },
      }],
    }
    expect(handleOpenAIExpandCall(resp)).toBeNull()
  })

  it('returns toolCallId and original when ID found', () => {
    const id = storeOriginal('openai original')
    const resp = {
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_xyz',
            function: { name: 'squeezr_expand', arguments: JSON.stringify({ id }) },
          }],
        },
      }],
    }
    const result = handleOpenAIExpandCall(resp)
    expect(result).not.toBeNull()
    expect(result!.toolCallId).toBe('call_xyz')
    expect(result!.original).toBe('openai original')
  })

  it('returns null when ID not in store', () => {
    const resp = {
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_1',
            function: { name: 'squeezr_expand', arguments: JSON.stringify({ id: 'zzzzzz' }) },
          }],
        },
      }],
    }
    expect(handleOpenAIExpandCall(resp)).toBeNull()
  })

  it('handles malformed arguments gracefully', () => {
    const resp = {
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_1',
            function: { name: 'squeezr_expand', arguments: 'NOT JSON{{{' },
          }],
        },
      }],
    }
    expect(handleOpenAIExpandCall(resp)).toBeNull()
  })
})
