import { describe, it, expect } from 'vitest'
import {
  canonicalSignature,
  extractToolCalls,
  detectLoops,
  renderCorrections,
  writeMarkerBlock,
  LEARN_START,
  LEARN_END,
} from '../learn.js'

// ── canonicalSignature ───────────────────────────────────────────────────────

describe('canonicalSignature', () => {
  it('strips pipe-head/tail pagination so variants collapse', () => {
    const a = canonicalSignature('Bash', { command: 'grep foo src | head -50' })
    const b = canonicalSignature('Bash', { command: 'grep foo src | head -100' })
    expect(a).toBe(b)
  })

  it('collapses LIMIT/OFFSET and bare integers to N', () => {
    const a = canonicalSignature('Bash', { command: 'psql -c "select * from t LIMIT 20 OFFSET 0"' })
    const b = canonicalSignature('Bash', { command: 'psql -c "select * from t LIMIT 50 OFFSET 40"' })
    expect(a).toBe(b)
  })

  it('distinguishes genuinely different commands', () => {
    const a = canonicalSignature('Bash', { command: 'ls -la' })
    const b = canonicalSignature('Bash', { command: 'cat file.txt' })
    expect(a).not.toBe(b)
  })

  it('uses tool name + input for non-Bash tools', () => {
    const a = canonicalSignature('Grep', { pattern: 'foo', path: 'src' })
    const b = canonicalSignature('Read', { file_path: 'src' })
    expect(a).not.toBe(b)
    expect(a.startsWith('grep')).toBe(true)
  })
})

// ── extractToolCalls ─────────────────────────────────────────────────────────

describe('extractToolCalls', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'FAIL', is_error: true }] } }),
  ]

  it('pairs tool_use with its tool_result (name, error flag, output size)', () => {
    const calls = extractToolCalls(lines)
    expect(calls.length).toBe(1)
    expect(calls[0].tool).toBe('Bash')
    expect(calls[0].isError).toBe(true)
    expect(calls[0].outputBytes).toBe('FAIL'.length)
  })

  it('tolerates malformed / non-JSON lines', () => {
    const calls = extractToolCalls([...lines, 'not json', ''])
    expect(calls.length).toBe(1)
  })

  it('handles array-form tool_result content', () => {
    const l = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: 'a' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'hello' }] }] } }),
    ]
    const calls = extractToolCalls(l)
    expect(calls[0].outputBytes).toBeGreaterThan(0)
    expect(calls[0].isError).toBe(false)
  })
})

// ── detectLoops ──────────────────────────────────────────────────────────────

function call(tool: string, command: string, isError: boolean, outputBytes = 100) {
  return { tool, signature: canonicalSignature(tool, { command }), raw: command, isError, outputBytes }
}

describe('detectLoops', () => {
  it('flags an error loop when the same signature fails >=3 times', () => {
    const calls = [
      call('Bash', 'npm run build', true, 500),
      call('Bash', 'npm run build', true, 500),
      call('Bash', 'npm run build', true, 500),
    ]
    const loops = detectLoops(calls)
    const err = loops.find(l => l.kind === 'error')
    expect(err).toBeDefined()
    expect(err!.count).toBe(3)
    expect(err!.wastedBytes).toBe(1500)
  })

  it('does not flag fewer than the minimum occurrences', () => {
    const calls = [call('Bash', 'npm run build', true), call('Bash', 'npm run build', true)]
    expect(detectLoops(calls).length).toBe(0)
  })

  it('flags a refetch loop: same signature, different raw variants, all succeeding', () => {
    const calls = [
      call('Bash', 'grep foo src | head -50', false, 2000),
      call('Bash', 'grep foo src | head -100', false, 4000),
      call('Bash', 'grep foo src | head -200', false, 8000),
    ]
    const loops = detectLoops(calls)
    const refetch = loops.find(l => l.kind === 'refetch')
    expect(refetch).toBeDefined()
    expect(refetch!.count).toBe(3)
    // wasted = redundant follow-ups (all but the first)
    expect(refetch!.wastedBytes).toBe(12000)
  })

  it('does not flag a refetch when the raw command is identical every time (that is caching, not a loop)', () => {
    const calls = [
      call('Bash', 'ls', false),
      call('Bash', 'ls', false),
      call('Bash', 'ls', false),
    ]
    expect(detectLoops(calls).find(l => l.kind === 'refetch')).toBeUndefined()
  })

  it('classifies a signature with errors as an error loop, not a refetch (even with raw variants)', () => {
    // Same canonical signature (pagination stripped) + distinct raw + all errored:
    // errors win → error loop, never also reported as a refetch.
    const calls = [
      call('Bash', 'grep foo | head -50', true),
      call('Bash', 'grep foo | head -100', true),
      call('Bash', 'grep foo | head -200', true),
    ]
    const loops = detectLoops(calls)
    expect(loops.some(l => l.kind === 'error')).toBe(true)
    expect(loops.some(l => l.kind === 'refetch')).toBe(false)
  })

  it('ranks loops by wasted bytes descending', () => {
    const calls = [
      call('Bash', 'small | head -1', false, 100),
      call('Bash', 'small | head -2', false, 100),
      call('Bash', 'small | head -3', false, 100),
      call('Bash', 'big', true, 9000),
      call('Bash', 'big', true, 9000),
      call('Bash', 'big', true, 9000),
    ]
    const loops = detectLoops(calls)
    expect(loops[0].wastedBytes).toBeGreaterThanOrEqual(loops[loops.length - 1].wastedBytes)
  })
})

// ── renderCorrections ────────────────────────────────────────────────────────

describe('renderCorrections', () => {
  it('produces a bullet per loop mentioning the signature', () => {
    const loops = detectLoops([
      call('Bash', 'npm run build', true, 500),
      call('Bash', 'npm run build', true, 500),
      call('Bash', 'npm run build', true, 500),
    ])
    const text = renderCorrections(loops)
    expect(text.includes('npm run build')).toBe(true)
    expect(text.split('\n').some(l => l.trim().startsWith('-'))).toBe(true)
  })

  it('returns empty string for no loops', () => {
    expect(renderCorrections([])).toBe('')
  })
})

// ── writeMarkerBlock ─────────────────────────────────────────────────────────

describe('writeMarkerBlock', () => {
  it('appends a marked block to fresh content', () => {
    const out = writeMarkerBlock('# Project\n\nsome notes\n', 'rule one')
    expect(out.includes(LEARN_START)).toBe(true)
    expect(out.includes(LEARN_END)).toBe(true)
    expect(out.includes('rule one')).toBe(true)
    expect(out.startsWith('# Project')).toBe(true)
  })

  it('replaces an existing block instead of stacking (idempotent shape)', () => {
    const first = writeMarkerBlock('base\n', 'rule one')
    const second = writeMarkerBlock(first, 'rule two')
    expect((second.match(new RegExp(LEARN_START, 'g')) ?? []).length).toBe(1)
    expect(second.includes('rule two')).toBe(true)
    expect(second.includes('rule one')).toBe(false)
  })

  it('re-applying the SAME block yields byte-identical content', () => {
    const first = writeMarkerBlock('base\n', 'rule one')
    const second = writeMarkerBlock(first, 'rule one')
    expect(second).toBe(first)
  })
})
