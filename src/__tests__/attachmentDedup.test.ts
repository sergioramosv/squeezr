/**
 * Tests for v1.49.0 attachment/artifact dedup.
 */
import { describe, it, expect } from 'vitest'
import { dedupAttachments } from '../attachmentDedup.js'
describe('attachmentDedup', () => {
  it('dedupes large repeated text blocks', () => {
    const big = 'X'.repeat(800)
    const messages: any[] = [
      { role: 'user', content: [{ type: 'text', text: big }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: big }] },
      { role: 'assistant', content: [{ type: 'text', text: 'live answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'live ask' }] },
    ]
    const r = dedupAttachments(messages)
    expect(r.dedupCount).toBeGreaterThanOrEqual(1)
    expect(r.savedChars).toBeGreaterThan(0)
  })
  it('never touches the last user message (live ask)', () => {
    const big = 'Y'.repeat(800)
    const messages: any[] = [
      { role: 'user', content: [{ type: 'text', text: big }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: big }] },  // LAST user — should be preserved
    ]
    dedupAttachments(messages)
    expect(messages[2].content[0].text).toBe(big)
  })
  it('never touches the last assistant message (live answer)', () => {
    const big = 'Z'.repeat(800)
    const messages: any[] = [
      { role: 'assistant', content: [{ type: 'text', text: big }] },
      { role: 'user', content: [{ type: 'text', text: 'x' }] },
      { role: 'assistant', content: [{ type: 'text', text: big }] },  // LAST assistant — preserved
      { role: 'user', content: [{ type: 'text', text: 'follow up' }] },
    ]
    dedupAttachments(messages)
    expect(messages[2].content[0].text).toBe(big)
  })
  it('does not replace blocks below MIN_BLOCK_CHARS threshold', () => {
    const small = 'hi'
    const messages: any[] = [
      { role: 'user', content: [{ type: 'text', text: small }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ack' }] },
      { role: 'user', content: [{ type: 'text', text: small }] },
      { role: 'user', content: [{ type: 'text', text: 'live' }] },
    ]
    const r = dedupAttachments(messages)
    expect(r.dedupCount).toBe(0)
  })
  it('never touches tool_use or tool_result blocks', () => {
    const big = 'W'.repeat(800)
    const messages: any[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: big }] },
      { role: 'user', content: [{ type: 'text', text: 'live ask' }] },
    ]
    dedupAttachments(messages)
    expect(messages[1].content[0].type).toBe('tool_result')
    expect(messages[3].content[0].type).toBe('tool_result')
    expect(messages[1].content[0].content).toBe(big)
  })
  it('keeps single-occurrence text blocks untouched', () => {
    const messages: any[] = [
      { role: 'user', content: [{ type: 'text', text: 'A'.repeat(800) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'B'.repeat(800) }] },
      { role: 'user', content: [{ type: 'text', text: 'live' }] },
    ]
    const r = dedupAttachments(messages)
    expect(r.dedupCount).toBe(0)
    expect(messages[0].content[0].text).toBe('A'.repeat(800))
    expect(messages[1].content[0].text).toBe('B'.repeat(800))
  })
  it('produces non-empty placeholder text (never empty content)', () => {
    const big = 'D'.repeat(800)
    const messages: any[] = [
      { role: 'user', content: [{ type: 'text', text: big }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: big }] },
      { role: 'user', content: [{ type: 'text', text: 'live' }] },
    ]
    dedupAttachments(messages)
    expect(typeof messages[0].content[0].text).toBe('string')
    expect((messages[0].content[0].text as string).length).toBeGreaterThan(20)
  })
})
