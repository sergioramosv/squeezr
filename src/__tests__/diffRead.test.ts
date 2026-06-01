import { describe, it, expect } from 'vitest'
import { compressRepeatedReads } from '../diffRead.js'
describe('diffRead', () => {
  it('collapses two Reads of same path with small diff', () => {
    const fileV1 = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const fileV2 = fileV1.replace('line 5', 'line 5 modified')
    const messages: any[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/foo.py' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: fileV1 }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/foo.py' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: fileV2 }] },
    ]
    const r = compressRepeatedReads(messages)
    expect(r.collapsedCount).toBe(1)
    expect(r.savedChars).toBeGreaterThan(0)
    const firstResult = messages[1].content[0].content as string
    expect(typeof firstResult).toBe('string')
    expect(firstResult).toContain('squeezr_expand')
    expect(messages[3].content[0].content).toBe(fileV2)
  })
  it('does NOT touch single Read', () => {
    const content = 'X'.repeat(2000)
    const messages: any[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/single.py' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
    ]
    const r = compressRepeatedReads(messages)
    expect(r.collapsedCount).toBe(0)
    expect(messages[1].content[0].content).toBe(content)
  })
  it('preserves tool_use ids and structure', () => {
    const fileV1 = 'a\n'.repeat(300)
    const fileV2 = fileV1 + 'extra\n'
    const messages: any[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tA', name: 'Read', input: { file_path: '/y.py' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tA', content: fileV1 }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tB', name: 'Read', input: { file_path: '/y.py' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tB', content: fileV2 }] },
    ]
    compressRepeatedReads(messages)
    expect(messages[0].content[0].id).toBe('tA')
    expect(messages[0].content[0].name).toBe('Read')
    expect(messages[2].content[0].id).toBe('tB')
    expect(messages[1].content[0].tool_use_id).toBe('tA')
    expect(messages[3].content[0].tool_use_id).toBe('tB')
  })
  it('skips reads with identical content', () => {
    const same = 'identical\n'.repeat(100)
    const messages: any[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x.py' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: same }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/x.py' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: same }] },
    ]
    const r = compressRepeatedReads(messages)
    expect(r.collapsedCount).toBe(0)
  })
  it('ignores reads of different file paths', () => {
    const text = 'L\n'.repeat(300)
    const messages: any[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.py' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/b.py' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: text }] },
    ]
    const r = compressRepeatedReads(messages)
    expect(r.collapsedCount).toBe(0)
  })
  it('falls back to reference placeholder when diff would be too big', () => {
    const fileV1 = Array.from({ length: 100 }, (_, i) => `line ${i} original`).join('\n')
    const fileV2 = Array.from({ length: 100 }, (_, i) => `line ${i} totally different`).join('\n')
    const messages: any[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/z.py' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: fileV1 }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/z.py' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: fileV2 }] },
    ]
    const r = compressRepeatedReads(messages)
    expect(r.collapsedCount).toBe(1)
    const placeholder = messages[1].content[0].content as string
    expect(placeholder).toContain('squeezr_expand')
  })
})
