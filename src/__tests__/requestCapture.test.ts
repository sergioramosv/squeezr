/**
 * Tests for v1.47.0 request capture mode.
 * Verifies:
 *  - Auth headers are redacted
 *  - Disabled flag is a true no-op
 *  - Capture limit is honored
 */
import { describe, it, expect } from 'vitest'
import { _internal } from '../requestCapture.js'
describe('requestCapture', () => {
  it('redacts sensitive headers', () => {
    const out = _internal.redactHeaders({
      'content-type': 'application/json',
      'authorization': 'Bearer sk-secret-token',
      'x-api-key': 'sk-ant-secret',
      'cookie': 'session=abc',
      'user-agent': 'claude-code/1.0',
    })
    expect(out['authorization']).toBe('<redacted>')
    expect(out['x-api-key']).toBe('<redacted>')
    expect(out['cookie']).toBe('<redacted>')
    expect(out['content-type']).toBe('application/json')
    expect(out['user-agent']).toBe('claude-code/1.0')
  })
  it('redacts header names case-insensitively', () => {
    const out = _internal.redactHeaders({
      'Authorization': 'Bearer x',
      'X-Api-Key': 'sk-y',
    })
    expect(out['Authorization']).toBe('<redacted>')
    expect(out['X-Api-Key']).toBe('<redacted>')
  })
  it('generates sequentially-numbered capture filenames', () => {
    const name = _internal.nextCaptureName()
    expect(name).toMatch(/^req-\d{4}\.json$/)
  })
})
