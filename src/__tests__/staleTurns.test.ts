import { describe, it, expect } from 'vitest'
import { collapseStaleTurns } from '../staleTurns.js'

type Block = { type: string; text?: string; [k: string]: unknown }

function makeConversation(
  turns: number,
  assistantContent: string | Block[] = 'A short assistant reply.',
): Array<{ role: string; content: unknown }> {
  const msgs: Array<{ role: string; content: unknown }> = []
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: 'user', content: `User turn ${i + 1} asking something important.` })
    msgs.push({ role: 'assistant', content: assistantContent })
  }
  return msgs
}

const LONG_TEXT = 'This is a long assistant response. '.repeat(20)

describe('collapseStaleTurns', () => {
  it('no-op when turns <= threshold', () => {
    const msgs = makeConversation(10, LONG_TEXT)
    const result = collapseStaleTurns(msgs as never, 10, 5)
    expect(result.savedChars).toBe(0)
    expect(result.collapsedBlocks).toBe(0)
  })

  it('triggers when turns > threshold', () => {
    const msgs = makeConversation(11, LONG_TEXT)
    const result = collapseStaleTurns(msgs as never, 10, 5)
    expect(result.savedChars).toBeGreaterThan(0)
    expect(result.collapsedBlocks).toBeGreaterThan(0)
  })

  it('never touches user messages', () => {
    const msgs = makeConversation(11, LONG_TEXT)
    const usersBefore = msgs.filter(m => m.role === 'user').map(m => m.content as string)
    collapseStaleTurns(msgs as never, 10, 5)
    const usersAfter = msgs.filter(m => m.role === 'user').map(m => m.content as string)
    expect(usersAfter).toEqual(usersBefore)
  })

  it('never touches tool_use blocks inside assistant messages', () => {
    const msgs = makeConversation(11)
    ;(msgs[1] as { content: Block[] }).content = [
      { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls -la' } },
      { type: 'text', text: LONG_TEXT },
    ]
    collapseStaleTurns(msgs as never, 10, 5)
    const toolBlock = (msgs[1].content as Block[])[0]
    expect(toolBlock.type).toBe('tool_use')
    expect((toolBlock as unknown as { id: string }).id).toBe('tu_1')
  })

  it('never touches tool_result blocks inside user messages', () => {
    const msgs = makeConversation(11, LONG_TEXT)
    ;(msgs[0] as { content: Block[] }).content = [
      { type: 'tool_result', tool_use_id: 'tu_1', content: LONG_TEXT },
    ]
    collapseStaleTurns(msgs as never, 10, 5)
    const tr = (msgs[0].content as Block[])[0]
    expect(tr.type).toBe('tool_result')
    expect((tr as unknown as { tool_use_id: string }).tool_use_id).toBe('tu_1')
  })

  it('keeps last keepRecent turns untouched', () => {
    const msgs = makeConversation(12, LONG_TEXT)
    collapseStaleTurns(msgs as never, 10, 5)
    const assistantMsgs = msgs.filter(m => m.role === 'assistant')
    for (let i = assistantMsgs.length - 5; i < assistantMsgs.length; i++) {
      expect(assistantMsgs[i].content).toBe(LONG_TEXT)
    }
  })

  it('compresses stale assistant string content', () => {
    const msgs = makeConversation(11, LONG_TEXT)
    collapseStaleTurns(msgs as never, 10, 5)
    const staleAssistant = msgs.filter(m => m.role === 'assistant')[0]
    const compressed = staleAssistant.content as string
    expect(compressed.startsWith('[squeezr:')).toBe(true)
    expect(compressed.length).toBeLessThan(LONG_TEXT.length)
  })

  it('compresses stale assistant text blocks in array content', () => {
    const msgs = makeConversation(11)
    for (let i = 1; i < msgs.length; i += 2) {
      ;(msgs[i] as { content: Block[] }).content = [{ type: 'text', text: LONG_TEXT }]
    }
    collapseStaleTurns(msgs as never, 10, 5)
    const staleAssistant = msgs.filter(m => m.role === 'assistant')[0]
    const firstBlock = (staleAssistant.content as Block[])[0]
    expect((firstBlock.text as string).startsWith('[squeezr:')).toBe(true)
  })

  it('skips blocks below MIN_BLOCK_LEN (250 chars)', () => {
    const msgs = makeConversation(11, 'Short reply.')
    const result = collapseStaleTurns(msgs as never, 10, 5)
    expect(result.collapsedBlocks).toBe(0)
    expect(result.savedChars).toBe(0)
  })

  it('reports staleCount correctly', () => {
    const msgs = makeConversation(15, LONG_TEXT)
    const result = collapseStaleTurns(msgs as never, 10, 5)
    expect(result.staleCount).toBe(10)
  })

  it('condenses to a generic placeholder WITHOUT leaking turn content', () => {
    // Keyword extraction was intentionally removed: inlining user content (paths,
    // errors) into the placeholder triggered Anthropic Usage Policy false positives.
    // The condensed block must NOT echo the original content back.
    const textWithPath = 'I modified the file src/components/Button.tsx to fix the bug. '.repeat(6)
    const msgs = makeConversation(11, textWithPath)
    collapseStaleTurns(msgs as never, 10, 5)
    const staleAssistant = msgs.filter(m => m.role === 'assistant')[0]
    const condensed = staleAssistant.content as string
    expect(condensed.startsWith('[squeezr:')).toBe(true)
    expect(condensed).not.toContain('Button.tsx')
  })

  it('handles empty messages array gracefully', () => {
    const result = collapseStaleTurns([], 10, 5)
    expect(result.savedChars).toBe(0)
    expect(result.collapsedBlocks).toBe(0)
  })

  it('non-text blocks in assistant arrays are preserved', () => {
    const msgs = makeConversation(11)
    ;(msgs[1] as { content: Block[] }).content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      { type: 'text', text: LONG_TEXT },
    ]
    collapseStaleTurns(msgs as never, 10, 5)
    const imgBlock = (msgs[1].content as Block[])[0]
    expect(imgBlock.type).toBe('image')
  })
})
