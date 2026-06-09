import { describe, it, expect } from 'vitest'
import { looksStructured } from '../structuredGuard.js'

describe('looksStructured', () => {
  it('detects a JSON array', () => {
    expect(looksStructured('[{"a":1},{"a":2}]')).toBe(true)
  })

  it('detects a JSON object', () => {
    expect(looksStructured('{"id":"x","date":"2026-06-09","count":5}')).toBe(true)
  })

  it('detects JSONL (one object per line)', () => {
    const jsonl = [
      '{"id":1,"date":"2026-01-01"}',
      '{"id":2,"date":""}',
      '{"id":3,"date":"2026-01-03"}',
      '{"id":4,"date":"2026-01-04"}',
    ].join('\n')
    expect(looksStructured(jsonl)).toBe(true)
  })

  it('detects a record/dict dump with many key:value lines', () => {
    const dump = [
      'id: 178895',
      'date: 2026-06-09',
      'read: false',
      'type: info',
      'title: Hello',
      'message: world',
      'userId: abc',
    ].join('\n')
    expect(looksStructured(dump)).toBe(true)
  })

  it('detects pretty-printed quoted-key dumps', () => {
    const dump = [
      '"id": "178895",',
      '"date": "",',
      '"read": false,',
      '"type": "info",',
      '"title": "Hello",',
      '"message": "world",',
    ].join('\n')
    expect(looksStructured(dump)).toBe(true)
  })

  it('detects tab-separated tabular output', () => {
    const table = [
      'id\tdate\tread',
      '1\t2026-01-01\tfalse',
      '2\t\ttrue',
      '3\t2026-01-03\tfalse',
      '4\t2026-01-04\ttrue',
    ].join('\n')
    expect(looksStructured(table)).toBe(true)
  })

  it('does NOT flag prose', () => {
    const prose =
      'The script processed 178,895 notifications and found that most of them ' +
      'had a non-empty date field. This is a normal paragraph of text that the ' +
      'AI compressor can safely summarise without losing any important meaning.'
    expect(looksStructured(prose)).toBe(false)
  })

  it('does NOT flag prose with a couple of incidental "foo: bar" lines', () => {
    const prose = [
      'Here is what I found while reviewing the logs.',
      'Summary: the build passed and tests are green.',
      'Next step: deploy to staging and verify behaviour.',
      'Everything looks good and ready to ship now.',
    ].join('\n')
    expect(looksStructured(prose)).toBe(false)
  })

  it('handles empty / tiny input safely', () => {
    expect(looksStructured('')).toBe(false)
    expect(looksStructured('{')).toBe(false)
    expect(looksStructured('ok')).toBe(false)
  })
})
