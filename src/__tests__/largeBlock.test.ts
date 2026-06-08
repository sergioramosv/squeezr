import { describe, it, expect, vi } from 'vitest'

// compressor.ts imports the AI SDKs at module load; stub them so the import is cheap.
vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn().mockImplementation(function () { return {} }) }))
vi.mock('openai', () => ({ default: vi.fn().mockImplementation(function () { return {} }) }))

import { splitOnLines } from '../compressor.js'

describe('splitOnLines (large-block chunking — no data loss)', () => {
  it('returns the text as a single chunk when it fits', () => {
    const text = 'line a\nline b\nline c'
    expect(splitOnLines(text, 1000)).toEqual([text])
  })

  it('covers the ENTIRE input including the tail sentinel when chunked', () => {
    // Build a >13k block of numbered lines with a unique tail sentinel.
    const lines: string[] = []
    for (let i = 0; i < 2000; i++) lines.push(`line ${i}: some tool output content here`)
    lines.push('TAIL_SENTINEL_UNIQUE_98765 at src/edge/case.ts')
    const text = lines.join('\n')
    expect(text.length).toBeGreaterThan(13000)

    const chunks = splitOnLines(text, 13000)
    expect(chunks.length).toBeGreaterThan(1)

    // Every chunk is within budget.
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(13000)

    // The tail sentinel must survive somewhere — the old slice(0,4000) dropped it.
    expect(chunks.some(c => c.includes('TAIL_SENTINEL_UNIQUE_98765'))).toBe(true)

    // Rejoining reconstructs the original exactly (no bytes lost at boundaries).
    expect(chunks.join('\n')).toBe(text)
  })

  it('hard-splits a single line longer than maxChars without losing content', () => {
    const huge = 'x'.repeat(5000)
    const chunks = splitOnLines(huge, 1000)
    expect(chunks.length).toBe(5)
    expect(chunks.join('')).toBe(huge)
  })
})
