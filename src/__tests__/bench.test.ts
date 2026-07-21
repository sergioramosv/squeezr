import { describe, it, expect } from 'vitest'
import { factRecall, runBench, FIXTURES } from '../bench.js'

describe('factRecall', () => {
  it('returns 1 when every fact is present verbatim', () => {
    expect(factRecall('error E123 in file foo.ts at line 42', ['E123', 'foo.ts', '42'])).toBe(1)
  })
  it('returns the fraction present', () => {
    expect(factRecall('only E123 here', ['E123', 'MISSING'])).toBe(0.5)
  })
  it('returns 1 for an empty fact list (nothing to lose)', () => {
    expect(factRecall('whatever', [])).toBe(1)
  })
})

describe('FIXTURES', () => {
  it('every fixture declares its critical facts', () => {
    expect(FIXTURES.length).toBeGreaterThan(0)
    for (const f of FIXTURES) {
      expect(f.facts.length).toBeGreaterThan(0)
      // sanity: the facts must actually be in the original content
      for (const fact of f.facts) expect(f.content.includes(fact)).toBe(true)
    }
  })
})

describe('runBench', () => {
  it('produces a row per fixture with a valid shape', () => {
    const summary = runBench()
    expect(summary.rows.length).toBe(FIXTURES.length)
    for (const r of summary.rows) {
      expect(r.originalChars).toBeGreaterThan(0)
      expect(r.compressedChars).toBeGreaterThan(0)
      expect(r.compressionPct).toBeGreaterThanOrEqual(0)
      expect(r.inlineRecall).toBeGreaterThanOrEqual(0)
      expect(r.inlineRecall).toBeLessThanOrEqual(1)
    }
  })

  it('achieves real compression on at least one fixture', () => {
    const summary = runBench()
    expect(summary.rows.some(r => r.compressionPct > 10)).toBe(true)
  })

  it('never drops a critical fact from the highly-compressible JSON fixture', () => {
    // The homogeneous JSON array is crushed to a table — all VALUES must stay inline.
    const summary = runBench()
    const json = summary.rows.find(r => r.name.includes('json'))
    expect(json).toBeDefined()
    expect(json!.compressionPct).toBeGreaterThan(10)
    expect(json!.inlineRecall).toBe(1)
  })

  it('reports honest averages', () => {
    const summary = runBench()
    expect(summary.avgCompressionPct).toBeGreaterThan(0)
    expect(summary.avgInlineRecall).toBeGreaterThan(0)
    expect(summary.avgInlineRecall).toBeLessThanOrEqual(1)
  })
})
