import { describe, it, expect } from 'vitest'
import { crushJsonArrays, TABLE_MARKER_RE } from '../jsonCrush.js'
import { retrieveOriginal } from '../expand.js'

function makeRows(n: number) {
  const rows = []
  for (let i = 0; i < n; i++) {
    rows.push({ id: i, name: `service-${i}`, status: i % 2 === 0 ? 'running' : 'stopped', region: 'us-east-1' })
  }
  return JSON.stringify(rows)
}

describe('crushJsonArrays', () => {
  it('crushes a uniform array of >=5 objects and saves chars', () => {
    const input = makeRows(20)
    const { text, savedChars } = crushJsonArrays(input)
    expect(savedChars).toBeGreaterThan(0)
    expect(text.length).toBeLessThan(input.length)
    expect(TABLE_MARKER_RE.test(text)).toBe(true)
  })

  it('embeds a recoverable squeezr_expand id that returns the ORIGINAL json', () => {
    const input = makeRows(20)
    const { text } = crushJsonArrays(input)
    const m = text.match(TABLE_MARKER_RE)
    expect(m).not.toBeNull()
    const id = m![1]
    expect(retrieveOriginal(id)).toBe(input)
  })

  it('keeps every value present in the table body (lossless representation)', () => {
    const input = makeRows(6)
    const { text } = crushJsonArrays(input)
    expect(text.includes('service-0')).toBe(true)
    expect(text.includes('service-5')).toBe(true)
    expect(text.includes('running')).toBe(true)
    expect(text.includes('stopped')).toBe(true)
  })

  it('lists the column names once in the header, not per row', () => {
    const input = makeRows(10)
    const { text } = crushJsonArrays(input)
    // "region" appears once as a column header, never repeated as a JSON key
    expect((text.match(/"region"/g) ?? []).length).toBe(0)
    expect(text.includes('region')).toBe(true)
  })

  it('does NOT crush arrays below the minimum item count', () => {
    const input = JSON.stringify([{ a: 1 }, { a: 2 }])
    const { text, savedChars } = crushJsonArrays(input)
    expect(savedChars).toBe(0)
    expect(text).toBe(input)
  })

  it('does NOT crush a single JSON object', () => {
    const input = JSON.stringify({ id: 1, name: 'x', status: 'ok', region: 'eu' })
    const { text, savedChars } = crushJsonArrays(input)
    expect(savedChars).toBe(0)
    expect(text).toBe(input)
  })

  it('does NOT crush an array of scalars (no keys to factor out)', () => {
    const input = JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8])
    const { text, savedChars } = crushJsonArrays(input)
    expect(savedChars).toBe(0)
    expect(text).toBe(input)
  })

  it('leaves non-JSON text unchanged', () => {
    const input = 'this is just a log line\nand another one'
    const { text, savedChars } = crushJsonArrays(input)
    expect(savedChars).toBe(0)
    expect(text).toBe(input)
  })

  it('does NOT crush when the columnar form would not save enough', () => {
    // few rows, tiny keys → little repeated-key overhead → not worth it
    const input = JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }])
    const { text, savedChars } = crushJsonArrays(input)
    expect(savedChars).toBe(0)
    expect(text).toBe(input)
  })

  it('handles heterogeneous objects (missing keys) and stays recoverable', () => {
    const arr = [
      { id: 1, name: 'a', status: 'ok', extra: 'z' },
      { id: 2, name: 'b', status: 'ok' },
      { id: 3, name: 'c', status: 'fail', region: 'eu' },
      { id: 4, name: 'd', status: 'ok' },
      { id: 5, name: 'e', status: 'ok' },
      { id: 6, name: 'f', status: 'ok' },
    ]
    const input = JSON.stringify(arr)
    const { text } = crushJsonArrays(input)
    const m = text.match(TABLE_MARKER_RE)
    expect(m).not.toBeNull()
    expect(retrieveOriginal(m![1])).toBe(input)
  })

  it('renders nested objects inline as compact JSON', () => {
    const arr = Array.from({ length: 6 }, (_, i) => ({
      id: i,
      meta: { region: 'us', tier: 'gold' },
      name: `n${i}`,
    }))
    const input = JSON.stringify(arr)
    const { text } = crushJsonArrays(input)
    expect(text.includes('{"region":"us","tier":"gold"}')).toBe(true)
  })

  it('is deterministic — same input yields byte-identical output (cache-safe)', () => {
    const input = makeRows(15)
    const a = crushJsonArrays(input).text
    const b = crushJsonArrays(input).text
    expect(a).toBe(b)
  })

  it('crushes a pretty-printed (indented) JSON array too', () => {
    const input = JSON.stringify(
      Array.from({ length: 8 }, (_, i) => ({ id: i, name: `x${i}`, status: 'ok', region: 'us' })),
      null,
      2,
    )
    const { text, savedChars } = crushJsonArrays(input)
    expect(savedChars).toBeGreaterThan(0)
    expect(TABLE_MARKER_RE.test(text)).toBe(true)
  })
})
