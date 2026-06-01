/**
 * Tests for v1.48.0 image dedup hash-based.
 */
import { describe, it, expect } from 'vitest'
import { dedupImagesAnthropic } from '../imageDedup.js'
describe('imageDedup', () => {
  it('replaces duplicate base64 images with text placeholders', () => {
    const img = { type: 'image' as const, source: { type: 'base64', data: 'abc'.repeat(500), media_type: 'image/png' } }
    const messages: any[] = [
      { role: 'user', content: [{ ...img }, { type: 'text', text: 'first ask' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: [{ ...img }, { type: 'text', text: 'follow-up' }] },
    ]
    const r = dedupImagesAnthropic(messages)
    expect(r.dedupCount).toBe(1)
    expect(messages[0].content[0].type).toBe('text')          // first image got replaced
    expect(messages[0].content[0].text).toContain('squeezr_expand')
    expect(messages[2].content[0].type).toBe('image')         // last image stays
    expect(r.savedChars).toBeGreaterThan(0)
  })
  it('keeps single occurrences untouched', () => {
    const messages: any[] = [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'xyz' } }] },
    ]
    const r = dedupImagesAnthropic(messages)
    expect(r.dedupCount).toBe(0)
    expect(messages[0].content[0].type).toBe('image')
  })
  it('ignores non-image content blocks entirely', () => {
    const messages: any[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'tool_result', tool_use_id: 't1', content: 'output' }] },
    ]
    const r = dedupImagesAnthropic(messages)
    expect(r.dedupCount).toBe(0)
    expect(messages[0].content[0].text).toBe('hello')
    expect(messages[0].content[1].type).toBe('tool_result')
  })
  it('treats different base64 data as distinct images', () => {
    const messages: any[] = [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'aaa'.repeat(500) } }] },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'bbb'.repeat(500) } }] },
    ]
    const r = dedupImagesAnthropic(messages)
    expect(r.dedupCount).toBe(0)
  })
  it('dedupes URL-source images by URL', () => {
    const messages: any[] = [
      { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } }] },
      { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } }] },
    ]
    const r = dedupImagesAnthropic(messages)
    expect(r.dedupCount).toBe(1)
    expect(messages[0].content[0].type).toBe('text')
    expect(messages[1].content[0].type).toBe('image')
  })
  it('handles 3+ occurrences keeping only the last', () => {
    const img = { type: 'image' as const, source: { type: 'base64', data: 'same'.repeat(500) } }
    const messages: any[] = [
      { role: 'user', content: [{ ...img }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ ...img }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [{ ...img }] },
    ]
    const r = dedupImagesAnthropic(messages)
    expect(r.dedupCount).toBe(2)
    expect(messages[0].content[0].type).toBe('text')
    expect(messages[2].content[0].type).toBe('text')
    expect(messages[4].content[0].type).toBe('image')
  })
  it('does not touch string-content messages', () => {
    const messages: any[] = [
      { role: 'user', content: 'plain text message' },
      { role: 'user', content: 'another plain text' },
    ]
    const r = dedupImagesAnthropic(messages)
    expect(r.dedupCount).toBe(0)
    expect(messages[0].content).toBe('plain text message')
  })
})
