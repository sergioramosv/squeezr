import { describe, it, expect } from 'vitest'
import { looksIncompressible, deflateRatio } from '../compressibilityProbe.js'
// Calibrated against real Zest output (see compressibilityProbe.ts):
//   verbose log w/ repeated lines → deflate ~0.17 → Zest saved 56% → KEEP
//   dense error/path list        → deflate ~0.76 → Zest saved  0% → SKIP
//   test output (mixed)          → deflate ~0.63 → Zest saved  5% → SKIP
const VERBOSE = (
  'npm warn deprecated foo@1.0.0: use bar\n' +
  'npm warn deprecated foo@1.0.0: use bar\n' +
  'npm warn deprecated baz@2.0.0: no longer maintained\n' +
  'added 1242 packages, and audited 1243 packages in 14s\n' +
  '201 packages are looking for funding\n' +
  '  run `npm fund` for details\n' +
  'found 0 vulnerabilities\n' +
  'gardening node_modules ... done\n' +
  'gardening node_modules ... done\n' +
  'gardening node_modules ... done'
).repeat(3)
const DENSE_PATHS = (
  'src/compressor.ts:268 error TS2322: Type string is not assignable\n' +
  'src/dashboard.ts:1027 warning unused var aiSavedTok\n' +
  'src/server.ts:956 note: see https://docs.foo.com/E1234 for details\n' +
  'src/stats.ts:361 error ENOENT no such file\n' +
  'src/cache.ts:42 error TS2304: cannot find name foo\n' +
  'src/expand.ts:88 warning deprecated symbol bar used here\n' +
  'src/index.ts:12 error TS1005: semicolon expected near token'
)
describe('looksIncompressible', () => {
  it('keeps redundant/verbose blocks (AI will compress them well)', () => {
    expect(looksIncompressible(VERBOSE)).toBe(false)
  })
  it('skips dense path/error dumps (AI would be rejected — wasted call)', () => {
    expect(looksIncompressible(DENSE_PATHS)).toBe(true)
  })
  it('does not probe tiny blocks (deflate ratio is noisy there)', () => {
    expect(looksIncompressible('error: ENOENT')).toBe(false)
  })
  it('respects a custom maxDeflate threshold', () => {
    // VERBOSE deflates to ~0.17; a 0.1 threshold flips it to "incompressible".
    expect(looksIncompressible(VERBOSE, 0.1)).toBe(true)
  })
  it('deflateRatio is in (0,1] and lower for redundant text', () => {
    const rVerbose = deflateRatio(VERBOSE)
    const rDense = deflateRatio(DENSE_PATHS)
    expect(rVerbose).toBeGreaterThan(0)
    expect(rVerbose).toBeLessThan(rDense)
    expect(rDense).toBeLessThanOrEqual(1)
  })
})
