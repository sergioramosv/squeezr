import { describe, it, expect } from 'vitest'
import {
  detectVolatile,
  analyzeSystemPrompt,
  formatVolatileWarning,
  _resetWarnedForTest,
  warnIfVolatile,
} from '../cacheAligner.js'

describe('detectVolatile', () => {
  it('detects a UUID', () => {
    const f = detectVolatile('session 550e8400-e29b-41d4-a716-446655440000 started')
    expect(f.find(x => x.kind === 'uuid')?.count).toBe(1)
  })
  it('detects ISO timestamps', () => {
    const f = detectVolatile('at 2026-07-21T10:00:00Z and 2026-07-21T11:00:00Z')
    expect(f.find(x => x.kind === 'timestamp')?.count).toBe(2)
  })
  it('detects a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const f = detectVolatile(`token=${jwt}`)
    expect(f.find(x => x.kind === 'jwt')?.count).toBe(1)
  })
  it('detects long hex hashes', () => {
    const sha = 'a'.repeat(64)
    const f = detectVolatile(`commit ${sha}`)
    expect(f.find(x => x.kind === 'hash')?.count).toBe(1)
  })
  it('returns nothing for clean stable text', () => {
    expect(detectVolatile('You are a helpful coding assistant. Follow the rules.')).toEqual([])
  })
  it('does not double-count a JWT as a hash', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const f = detectVolatile(jwt)
    expect(f.find(x => x.kind === 'hash')).toBeUndefined()
    expect(f.find(x => x.kind === 'jwt')?.count).toBe(1)
  })
})

describe('analyzeSystemPrompt', () => {
  it('handles a string system prompt', () => {
    const r = analyzeSystemPrompt('build id 550e8400-e29b-41d4-a716-446655440000')
    expect(r.hasVolatile).toBe(true)
    expect(r.findings.length).toBeGreaterThan(0)
  })
  it('aggregates across an array of text blocks', () => {
    const sys = [
      { type: 'text', text: 'stable preamble' },
      { type: 'text', text: 'ts 2026-07-21T10:00:00Z' },
    ]
    const r = analyzeSystemPrompt(sys)
    expect(r.findings.find(f => f.kind === 'timestamp')?.count).toBe(1)
  })
  it('reports clean when there is nothing volatile', () => {
    const r = analyzeSystemPrompt('You are Claude, a coding assistant.')
    expect(r.hasVolatile).toBe(false)
    expect(r.findings).toEqual([])
  })
  it('ignores non-text blocks and undefined', () => {
    expect(analyzeSystemPrompt(undefined).hasVolatile).toBe(false)
    const sys = [{ type: 'image', source: {} }, { type: 'text', text: 'clean' }]
    expect(analyzeSystemPrompt(sys).hasVolatile).toBe(false)
  })
})

describe('formatVolatileWarning', () => {
  it('mentions each detected kind', () => {
    const msg = formatVolatileWarning([{ kind: 'uuid', count: 2 }, { kind: 'timestamp', count: 1 }])
    expect(msg.includes('uuid')).toBe(true)
    expect(msg.includes('timestamp')).toBe(true)
  })
})

describe('warnIfVolatile', () => {
  it('warns once per distinct finding signature (no per-request spam)', () => {
    _resetWarnedForTest()
    const sys = 'id 550e8400-e29b-41d4-a716-446655440000'
    expect(warnIfVolatile(sys)).toBe(true)   // first time → warns
    expect(warnIfVolatile(sys)).toBe(false)  // same signature → suppressed
  })
  it('does not warn on clean prompts', () => {
    _resetWarnedForTest()
    expect(warnIfVolatile('perfectly stable system prompt')).toBe(false)
  })
})
