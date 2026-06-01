import { describe, it, expect } from 'vitest'
import { dedupSkillBlocks } from '../skillDedup.js'
describe('skillDedup', () => {
  it('collapses exact duplicate blocks in system prompt', () => {
    const block = '## Skill: foo\n' + 'long description line with content\n'.repeat(8) + 'final line'
    const prompt = `intro\n\n${block}\n\nmiddle content\n\n${block}\n\nmore`
    const r = dedupSkillBlocks(prompt)
    expect(r.dedupCount).toBeGreaterThan(0)
    expect(r.savedChars).toBeGreaterThan(0)
    expect(r.text.length).toBeLessThan(prompt.length)
    expect(r.text).toContain('duplicate of block')
  })
  it('is a no-op on small prompts', () => {
    const r = dedupSkillBlocks('hi')
    expect(r.dedupCount).toBe(0)
    expect(r.text).toBe('hi')
  })
  it('keeps single-occurrence blocks untouched', () => {
    const prompt = '## Section A\nline\nline\nline\nline\n\n## Section B\nline\nline\nline\nline'
    const r = dedupSkillBlocks(prompt)
    expect(r.dedupCount).toBe(0)
    expect(r.text).toBe(prompt)
  })
  it('does not touch blocks below MIN_BLOCK_CHARS', () => {
    const small = 'short\nblock\nhere\nplease'
    const prompt = `${small}\n\nother\n\n${small}`
    const r = dedupSkillBlocks(prompt)
    expect(r.dedupCount).toBe(0)
  })
  it('does not touch blocks below MIN_BLOCK_LINES', () => {
    const oneLineButLong = 'X'.repeat(500)
    const prompt = `${oneLineButLong}\n\nseparator\n\n${oneLineButLong}`
    const r = dedupSkillBlocks(prompt)
    expect(r.dedupCount).toBe(0)
  })
  it('preserves separators between non-duplicate blocks', () => {
    const block1 = 'A\n'.repeat(10)
    const block2 = 'B\n'.repeat(10)
    const prompt = `${block1}\n\n${block2}`
    const r = dedupSkillBlocks(prompt)
    expect(r.text).toBe(prompt)
  })
  it('handles 3+ duplicates collapsing all but first', () => {
    const block = '## Skill\n' + 'description line with content\n'.repeat(8) + 'end-line'
    const between = 'separator block of content\nwith multiple lines\nof content here\nto qualify as block\nwith more text to make it long enough for threshold'
    const prompt = `intro\n\n${block}\n\n${between}\n\n${block}\n\n${between}\n\n${block}\n\nend`
    const r = dedupSkillBlocks(prompt)
    expect(r.dedupCount).toBeGreaterThanOrEqual(2)
  })
  it('byte-exact matching — one char difference = no dedup', () => {
    const block1 = '## Skill foo\n' + 'description\n'.repeat(8) + 'end'
    const block2 = '## Skill bar\n' + 'description\n'.repeat(8) + 'end'  // different first line
    const prompt = `${block1}\n\n${block2}`
    const r = dedupSkillBlocks(prompt)
    expect(r.dedupCount).toBe(0)
  })
})
