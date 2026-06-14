import { describe, it, expect } from 'vitest'
import { preprocess } from '../deterministic.js'

describe('deduplicateLines is code-aware (never corrupts editable content)', () => {
  it('does NOT collapse repeated markup lines (<div> / </div>)', () => {
    const html = ['<div>', '</div>', '<div>', '</div>', '<div>', '</div>'].join('\n')
    const out = preprocess(html)
    expect(out).not.toContain('repeated')
    expect((out.match(/<\/div>/g) || []).length).toBe(3)
    expect((out.match(/<div>/g) || []).length).toBe(3)
  })

  it('does NOT collapse repeated code closers (})', () => {
    const code = ['if (a) {', '  doX()', '}', 'if (b) {', '  doY()', '}', 'if (c) {', '  doZ()', '}'].join('\n')
    const out = preprocess(code)
    expect((out.match(/^}$/gm) || []).length).toBe(3)
    expect(out).not.toContain('repeated')
  })

  it('STILL collapses repeated log-like prose lines', () => {
    const log = Array.from({ length: 6 }, () => 'processing the next item now').join('\n')
    const out = preprocess(log)
    expect(out).toContain('repeated')
    expect((out.match(/processing the next item now/g) || []).length).toBe(1)
  })
})
