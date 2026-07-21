import { describe, it, expect } from 'vitest'
import { findObjectArraySpans, crushEmbeddedJson, TABLE_MARKER_RE } from '../contentRouter.js'
import { retrieveOriginal } from '../expand.js'

function bigArray(prefix = '', suffix = ''): string {
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: i, name: `svc-${i}`, status: 'ok', region: 'us-east-1' }))
  return `${prefix}${JSON.stringify(rows)}${suffix}`
}

describe('findObjectArraySpans', () => {
  it('finds a whole-text array of objects', () => {
    const t = JSON.stringify([{ a: 1 }, { a: 2 }])
    const spans = findObjectArraySpans(t)
    expect(spans.length).toBe(1)
    expect(t.slice(spans[0].start, spans[0].end)).toBe(t)
  })

  it('finds an array embedded between prose', () => {
    const t = bigArray('Here are the pods:\n', '\nDone.')
    const spans = findObjectArraySpans(t)
    expect(spans.length).toBe(1)
    const sub = t.slice(spans[0].start, spans[0].end)
    expect(sub.startsWith('[{')).toBe(true)
    expect(sub.endsWith('}]')).toBe(true)
  })

  it('handles brackets inside string values without breaking', () => {
    const t = 'x ' + JSON.stringify([{ note: 'has ] and } inside' }, { note: 'more [ [ {' }]) + ' y'
    const spans = findObjectArraySpans(t)
    expect(spans.length).toBe(1)
    expect(() => JSON.parse(t.slice(spans[0].start, spans[0].end))).not.toThrow()
  })

  it('finds two separate embedded arrays', () => {
    const t = `first ${JSON.stringify([{ a: 1 }, { a: 2 }])} middle ${JSON.stringify([{ b: 3 }, { b: 4 }])} end`
    expect(findObjectArraySpans(t).length).toBe(2)
  })

  it('ignores arrays of scalars (not object arrays)', () => {
    expect(findObjectArraySpans('[1, 2, 3, 4, 5]').length).toBe(0)
  })
})

describe('crushEmbeddedJson', () => {
  it('crushes an array embedded in prose, preserving the surrounding text', () => {
    const t = bigArray('POD STATUS REPORT\n', '\n(end of report)')
    const res = crushEmbeddedJson(t)
    expect(res.savedChars).toBeGreaterThan(0)
    expect(res.text.startsWith('POD STATUS REPORT')).toBe(true)
    expect(res.text.includes('(end of report)')).toBe(true)
    expect(TABLE_MARKER_RE.test(res.text)).toBe(true)
  })

  it('keeps the embedded original recoverable via expand', () => {
    const t = bigArray('label: ', '')
    const res = crushEmbeddedJson(t)
    const m = res.text.match(TABLE_MARKER_RE)
    expect(m).not.toBeNull()
    const original = retrieveOriginal(m![1])
    expect(original).not.toBeUndefined()
    expect(() => JSON.parse(original!)).not.toThrow()
  })

  it('crushes the whole-text case too (parity with jsonCrush)', () => {
    const res = crushEmbeddedJson(bigArray())
    expect(res.savedChars).toBeGreaterThan(0)
    expect(TABLE_MARKER_RE.test(res.text)).toBe(true)
  })

  it('leaves text with no crushable arrays unchanged', () => {
    const t = 'just a normal log line\nwith no json at all'
    const res = crushEmbeddedJson(t)
    expect(res.savedChars).toBe(0)
    expect(res.text).toBe(t)
  })

  it('leaves a small (non-crushable) embedded array untouched, surroundings intact', () => {
    const t = 'before [{"a":1},{"a":2}] after'
    const res = crushEmbeddedJson(t)
    expect(res.text).toBe(t)
    expect(res.savedChars).toBe(0)
  })

  it('is deterministic', () => {
    const t = bigArray('p ', ' s')
    expect(crushEmbeddedJson(t).text).toBe(crushEmbeddedJson(t).text)
  })
})
