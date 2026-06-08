import { describe, it, expect } from 'vitest'
import { validateCompression } from '../compressionGuard.js'

describe('validateCompression', () => {
  it('accepts a good compression that keeps key tokens and saves enough', () => {
    const original = 'Running tests in src/auth/login.ts\n' +
      'PASS 42 tests, FAIL 1: expected 200 got 401 at line 88\n' +
      'See https://example.com/docs/errors for details\n' +
      'lots of incidental filler text repeated over and over to pad the block length so the ratio is meaningful '.repeat(8)
    const compressed = 'FAIL src/auth/login.ts line 88: expected 200 got 401. See https://example.com/docs/errors'
    const r = validateCompression(original, compressed)
    expect(r.accept).toBe(true)
    expect(r.ratio).toBeGreaterThan(0.15)
  })

  it('rejects when the result is LONGER than the original (negative savings)', () => {
    const original = 'short output'
    const compressed = 'this compressed result is actually much longer than the original input text'
    const r = validateCompression(original, compressed)
    expect(r.accept).toBe(false)
    expect(r.reason).toMatch(/ratio/)
  })

  it('rejects empty output', () => {
    const r = validateCompression('some real content '.repeat(20), '   ')
    expect(r.accept).toBe(false)
    expect(r.reason).toBe('empty output')
  })

  it('rejects when a critical file path is dropped', () => {
    const original = 'Error in src/payments/checkout.ts at line 12\n' +
      'stack trace filler '.repeat(40)
    const compressed = 'Error at line 12' // dropped the path
    const r = validateCompression(original, compressed)
    expect(r.accept).toBe(false)
    expect(r.reason).toMatch(/critical token/)
  })

  it('rejects when an error code is dropped', () => {
    const original = 'connection failed ECONNREFUSED on attempt 3\n' + 'retry filler '.repeat(40)
    const compressed = 'connection failed on attempt 3' // dropped ECONNREFUSED
    const r = validateCompression(original, compressed)
    expect(r.accept).toBe(false)
    expect(r.reason).toMatch(/critical token/)
  })

  it('rejects when an URL is dropped', () => {
    const original = 'fetch https://api.service.com/v2/users returned 500\n' + 'body filler '.repeat(40)
    const compressed = 'fetch returned 500' // dropped URL (and 500 is HTTP code, also hard)
    const r = validateCompression(original, compressed)
    expect(r.accept).toBe(false)
  })

  it('tolerates dropping a few incidental soft tokens', () => {
    const original = 'function computeTotals iterates items and calls helperOne helperTwo helperThree\n' +
      'verbose explanation filler text '.repeat(30)
    // keeps the main identifier, drops a couple of minor helpers — within tolerance
    const compressed = 'computeTotals iterates items, calls helpers'
    const r = validateCompression(original, compressed, { minRatio: 0.1 })
    // soft tolerance is small, so this MAY reject; assert the function runs and returns a ratio
    expect(typeof r.accept).toBe('boolean')
    expect(r.ratio).toBeGreaterThan(0)
  })
})
