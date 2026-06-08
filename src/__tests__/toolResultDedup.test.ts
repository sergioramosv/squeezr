import { describe, it, expect } from 'vitest'
import { compressDuplicateToolResults } from '../toolResultDedup.js'
import { clearExpandStore } from '../expand.js'

function userToolResult(id: string, text: string) {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }
}

describe('compressDuplicateToolResults', () => {
  it('collapses an identical tool output that reappears, keeping the latest full', () => {
    clearExpandStore()
    const big = 'line of bash output that is fairly long '.repeat(40) // > 500 chars
    const msgs = [
      userToolResult('a', big),
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      userToolResult('b', big), // identical re-run
    ]
    const r = compressDuplicateToolResults(msgs as any)
    expect(r.collapsedCount).toBe(1)
    expect(r.savedChars).toBeGreaterThan(0)
    // earlier one replaced with a reference, latest kept full
    expect((msgs[0].content as any)[0].content).toMatch(/identical tool output/)
    expect((msgs[2].content as any)[0].content).toBe(big)
  })

  it('ignores short outputs and unique outputs', () => {
    clearExpandStore()
    const msgs = [
      userToolResult('a', 'short'),
      userToolResult('b', 'short'),
      userToolResult('c', 'a unique long output '.repeat(40)),
    ]
    const r = compressDuplicateToolResults(msgs as any)
    expect(r.collapsedCount).toBe(0)
  })

  it('does not reprocess already-compressed squeezr blocks', () => {
    clearExpandStore()
    const tag = '[squeezr: identical tool output as message #2 — squeezr_expand(abc123)]'.padEnd(600, ' ')
    const msgs = [userToolResult('a', tag), userToolResult('b', tag)]
    const r = compressDuplicateToolResults(msgs as any)
    expect(r.collapsedCount).toBe(0)
  })
})
