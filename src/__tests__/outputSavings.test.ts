import { describe, it, expect } from 'vitest'
import { wordNgrams, echoRatio, extractAssistantTextFromSse } from '../outputSavings.js'

describe('wordNgrams', () => {
  it('builds word n-grams', () => {
    expect(wordNgrams('a b c d', 3).has('a b c')).toBe(true)
    expect(wordNgrams('a b c d', 3).has('b c d')).toBe(true)
  })
  it('empty for text shorter than n', () => {
    expect(wordNgrams('a b', 3).size).toBe(0)
  })
})

describe('echoRatio', () => {
  it('~1 when the output only restates context', () => {
    const context = 'the authentication middleware refreshes the token on every request cycle'
    const output = 'the authentication middleware refreshes the token on every request cycle'
    expect(echoRatio(output, context)).toBeGreaterThan(0.9)
  })

  it('~0 when the output is entirely novel', () => {
    const context = 'the authentication middleware refreshes the token'
    const output = 'completely different sentence about unrelated banana harvest logistics today'
    expect(echoRatio(output, context)).toBeLessThan(0.1)
  })

  it('is 0 for empty output', () => {
    expect(echoRatio('', 'some context here at all')).toBe(0)
  })

  it('is between 0 and 1 for partial restating', () => {
    const context = 'shared preamble tokens appear here in the context block'
    const output = 'shared preamble tokens appear here plus a brand new original tail clause'
    const r = echoRatio(output, context)
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThan(1)
  })

  it('is deterministic', () => {
    expect(echoRatio('a b c d e', 'a b c d e f')).toBe(echoRatio('a b c d e', 'a b c d e f'))
  })
})

describe('extractAssistantTextFromSse', () => {
  it('concatenates text_delta events, unescaping', () => {
    const sse = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world\\n"}}',
    ].join('\n')
    expect(extractAssistantTextFromSse(sse)).toBe('Hello world\n')
  })

  it('returns empty string when there are no text deltas', () => {
    expect(extractAssistantTextFromSse('data: {"type":"message_start"}')).toBe('')
  })
})
