import { describe, it, expect } from 'vitest'
import { preprocessForTool } from '../deterministic.js'
import { storeSegments, storeOriginal, retrieveOriginal } from '../expand.js'

const idsIn = (s: string) => [...s.matchAll(/squeezr_expand\("([^"]+)"\)/g)].map(m => m[1])

describe('storeSegments', () => {
  it('parent returns the whole; sub-ids return their part', () => {
    const orig = 'AAA\nBBB\nCCC'
    const { id, subIds } = storeSegments(orig, ['AAA', 'BBB'])
    expect(retrieveOriginal(id)).toBe(orig)
    expect(retrieveOriginal(subIds[0])).toBe('AAA')
    expect(retrieveOriginal(subIds[1])).toBe('BBB')
    expect(subIds[0]).toMatch(/~0$/)
    expect(subIds[1]).toMatch(/~1$/)
  })

  it('parent id is deterministic and equals storeOriginal(original)', () => {
    const orig = 'some original content for the determinism check'
    const { id } = storeSegments(orig, ['some'])
    expect(id).toBe(storeOriginal(orig))
  })
})

describe('code structure → per-symbol expand (read)', () => {
  it('big code file keeps signatures and recovers a single function body', () => {
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `    const v${i} = ${i}`).join('\n')
    const code = [
      "import { Foo } from './foo'",
      'export class AuthService {',
      '  async login(req, res) {',
      filler(180),
      '  }',
      '  async refresh(token) {',
      filler(180),
      '  }',
      '  async logout(id) {',
      filler(180),
      '  }',
      '}',
    ].join('\n')
    expect(code.split('\n').length).toBeGreaterThan(500)

    const out = preprocessForTool(code, 'read')
    expect(out).toContain('async login')
    expect(out).toContain('async refresh')
    const ids = idsIn(out)
    expect(ids.length).toBeGreaterThan(1)

    // A per-symbol id recovers a contiguous slice that includes that function.
    const bodies = ids.map(retrieveOriginal).filter(Boolean) as string[]
    expect(bodies.some(b => b.includes('async refresh') && b.includes('v17'))).toBe(true)

    // The whole-file id (no "~") recovers the exact original.
    const whole = ids.find(i => !i.includes('~'))
    expect(whole).toBeTruthy()
    expect(retrieveOriginal(whole!)).toBe(code)
  })
})

describe('big non-code file → recover middle by range (read)', () => {
  it('head/tail keeps ends and makes the omitted middle recoverable in chunks', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `req ${i + 1} GET /api 200`)
    const text = lines.join('\n')
    const out = preprocessForTool(text, 'read')
    expect(out).toContain('req 1 GET')        // head kept
    expect(out).toContain('req 400 GET')      // tail kept
    expect(out).toContain('lines omitted')
    expect(out).toMatch(/lines \d+-\d+ → squeezr_expand/)
    const ids = idsIn(out)
    expect(ids.length).toBeGreaterThan(0)
    const bodies = ids.map(retrieveOriginal).filter(Boolean) as string[]
    // a middle request (around line 200) is recoverable
    expect(bodies.some(b => b.includes('req 200 GET'))).toBe(true)
  })
})

describe('git diff → per-file expand (bash)', () => {
  it('multi-file diff offers a full-diff expand per file', () => {
    const diff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      'index 1a..2b 100644',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -1,3 +1,4 @@ login()',
      '+  const token = sign(user)',
      'diff --git a/src/user.ts b/src/user.ts',
      'index 3c..4d 100644',
      '--- a/src/user.ts',
      '+++ b/src/user.ts',
      '@@ -2,2 +2,2 @@ find()',
      '-  return null',
      '+  return user',
    ].join('\n')
    const out = preprocessForTool(diff, 'bash')
    expect(out).toContain('Full diff per file')
    expect(out).toContain('src/auth.ts')
    expect(out).toContain('src/user.ts')
    const ids = idsIn(out)
    const bodies = ids.map(retrieveOriginal).filter(Boolean) as string[]
    expect(bodies.some(b => b.includes('b/src/user.ts') && b.includes('return user'))).toBe(true)
  })
})
