import { describe, it, expect } from 'vitest'
import { crushText, normalizeLineKey } from '../textCrusher.js'

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
})
