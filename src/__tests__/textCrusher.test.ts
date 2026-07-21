import { describe, it, expect } from 'vitest'
import { crushText, normalizeLineKey, wordShingles, jaccard } from '../textCrusher.js'

describe('normalizeLineKey', () => {
  it('collapses numbers, hex and timestamps so near-duplicates share a key', () => {
    const a = normalizeLineKey('2026-07-21T10:00:01Z downloaded chunk 12 (0x1a2b)')
    const b = normalizeLineKey('2026-07-21T11:22:33Z downloaded chunk 998 (0xff00)')
    expect(a).toBe(b)
  })
  it('keeps genuinely different lines distinct', () => {
    expect(normalizeLineKey('connecting to db')).not.toBe(normalizeLineKey('closing db handle'))
  })
})

describe('crushText', () => {
  function repetitiveLog(n: number): string {
    const lines: string[] = []
    for (let i = 0; i < n; i++) lines.push(`[worker] processed record ${i} in ${i * 2}ms`)
    return lines.join('\n')
  }

  it('returns short input unchanged', () => {
    const input = 'line a\nline b\nline c'
    expect(crushText(input, { maxLines: 60 }).text).toBe(input)
  })

  it('collapses near-duplicate lines that differ only in numbers', () => {
    const input = repetitiveLog(200)
    const res = crushText(input)
    expect(res.dropped).toBeGreaterThan(0)
    expect(res.text.length).toBeLessThan(input.length)
    expect(res.text.split('\n').length).toBeLessThan(200)
  })

  it('always keeps lines carrying error/failure signal', () => {
    const lines: string[] = []
    for (let i = 0; i < 150; i++) lines.push(`[worker] processed record ${i} ok`)
    lines.splice(75, 0, 'ERROR: database connection refused at db.example.com:5432')
    const input = lines.join('\n')
    const res = crushText(input)
    expect(res.text.includes('ERROR: database connection refused at db.example.com:5432')).toBe(true)
  })

  it('keeps head and tail anchor lines', () => {
    const lines = ['FIRST LINE MARKER']
    for (let i = 0; i < 150; i++) lines.push(`noise line ${i} value ${i}`)
    lines.push('LAST LINE MARKER')
    const input = lines.join('\n')
    const res = crushText(input, { headKeep: 3, tailKeep: 3 })
    expect(res.text.includes('FIRST LINE MARKER')).toBe(true)
    expect(res.text.includes('LAST LINE MARKER')).toBe(true)
  })

  it('respects the maxLines budget (plus the omitted-summary line)', () => {
    const res = crushText(repetitiveLog(500), { maxLines: 40 })
    // kept content lines should not wildly exceed the budget
    expect(res.text.split('\n').length).toBeLessThanOrEqual(45)
  })

  it('preserves the original order of kept lines', () => {
    const lines = ['alpha unique', ...Array.from({ length: 100 }, (_, i) => `dup ${i}`), 'omega unique']
    const res = crushText(lines.join('\n'), { headKeep: 2, tailKeep: 2 })
    const idxA = res.text.indexOf('alpha unique')
    const idxO = res.text.indexOf('omega unique')
    expect(idxA).toBeGreaterThanOrEqual(0)
    expect(idxO).toBeGreaterThan(idxA)
  })

  it('is deterministic', () => {
    const input = repetitiveLog(300)
    expect(crushText(input).text).toBe(crushText(input).text)
  })

  it('emits an omitted-count marker when it drops lines', () => {
    const res = crushText(repetitiveLog(300))
    expect(/\[\d+ lines omitted/.test(res.text)).toBe(true)
  })

  it('with a query, keeps task-relevant lines that a blind pass would drop', () => {
    // 120 noise lines + one line mentioning the task keyword, positioned in the middle
    // (not an anchor) so only relevance can save it.
    const lines: string[] = []
    for (let i = 0; i < 60; i++) lines.push(`background chore ${i} finished`)
    lines.push('updated the authentication middleware token refresh logic')
    for (let i = 0; i < 60; i++) lines.push(`background chore ${i + 60} finished`)
    const input = lines.join('\n')

    const withQuery = crushText(input, { maxLines: 20, headKeep: 3, tailKeep: 3, query: 'authentication middleware token' })
    expect(withQuery.text.includes('authentication middleware token refresh')).toBe(true)
  })

  it('stays deterministic for a fixed query', () => {
    const input = repetitiveLog(300)
    const a = crushText(input, { query: 'record ms' }).text
    const b = crushText(input, { query: 'record ms' }).text
    expect(a).toBe(b)
  })

  it('collapses REWORDED near-duplicate lines (not just number-varied)', () => {
    // Two wordings of the same idea, no numbers, no signal keywords → exact-key dedup
    // would keep both; shingle near-dup should collapse them.
    const a = 'the worker finished processing the batch quickly and moved on'
    const b = 'the worker completed processing the batch quickly and moved on'
    // Unique anchor lines at head/tail (no "worker") so the variants live in the MIDDLE,
    // where the budget-fill + shingle collapse applies.
    const lines = ['ALPHA HEADER ONE', 'ALPHA HEADER TWO', 'ALPHA HEADER THREE']
    for (let i = 0; i < 100; i++) lines.push(i % 2 === 0 ? a : b)
    lines.push('OMEGA FOOTER ONE', 'OMEGA FOOTER TWO', 'OMEGA FOOTER THREE')
    const res = crushText(lines.join('\n'), { maxLines: 30, headKeep: 3, tailKeep: 3 })
    const distinct = new Set(res.text.split('\n').filter(l => l.includes('worker')))
    // both wordings collapse to (at most) one representative
    expect(distinct.size).toBeLessThanOrEqual(1)
  })

  it('does NOT collapse genuinely different lines', () => {
    const lines = ['UNIQUE HEADER']
    for (let i = 0; i < 30; i++) {
      lines.push('alpha subsystem initialised the primary cache layer')
      lines.push('gamma module rejected the inbound websocket handshake')
    }
    lines.push('UNIQUE FOOTER')
    const res = crushText(lines.join('\n'), { maxLines: 40, headKeep: 2, tailKeep: 2 })
    expect(res.text.includes('alpha subsystem')).toBe(true)
    expect(res.text.includes('gamma module')).toBe(true)
  })
})

describe('wordShingles / jaccard', () => {
  it('reworded lines share most shingles (high jaccard)', () => {
    const a = wordShingles('the worker finished processing the batch quickly')
    const b = wordShingles('the worker completed processing the batch quickly')
    expect(jaccard(a, b)).toBeGreaterThan(0.4)
  })
  it('unrelated lines share few shingles (low jaccard)', () => {
    const a = wordShingles('database connection pool exhausted')
    const b = wordShingles('the cat sat on the warm mat')
    expect(jaccard(a, b)).toBeLessThan(0.1)
  })
  it('identical lines have jaccard 1', () => {
    const a = wordShingles('exactly the same words here now')
    expect(jaccard(a, a)).toBe(1)
  })
})
