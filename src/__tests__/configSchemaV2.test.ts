import { describe, it, expect } from 'vitest'
import { Config, type TomlConfig } from '../config.js'

// P1 (pillar A): the Config resolver must read v2 namespaces first, fall back to
// the v1 flat [compression] schema, then to hardcoded defaults. A v1-only file
// keeps working unchanged; a v2 file wins; both together → v2 wins.
describe('config schema v2 dual-parse', () => {
  it('reads the v1 flat [compression] schema (back-compat)', () => {
    const c = new Config({ compression: { threshold: 1234, tool_desc_compress: true, ai_compression: true } })
    expect(c.threshold).toBe(1234)
    expect(c.toolDescCompress).toBe(true)
    expect(c.aiCompression).toBe(true)
  })

  it('reads the v2 [input]/[ai] namespaces', () => {
    const c = new Config({
      schema_version: 2,
      input: { threshold: 4321, tool_desc_compress: true },
      ai: { ai_compression: true, backend: 'haiku' },
    })
    expect(c.threshold).toBe(4321)
    expect(c.toolDescCompress).toBe(true)
    expect(c.aiCompression).toBe(true)
    expect(c.compressionBackend).toBe('haiku')
  })

  it('prefers v2 over v1 when both are present', () => {
    const c = new Config({
      input: { threshold: 999 },
      compression: { threshold: 111 },
    })
    expect(c.threshold).toBe(999)
  })

  it('falls back to defaults when neither schema sets a flag', () => {
    const c = new Config({})
    expect(c.threshold).toBe(800)
    expect(c.keepRecent).toBe(3)
    expect(c.aiCompression).toBe(false)
    expect(c.toolDescCompress).toBe(false)
  })

  it('resolves list flags from v2 then v1', () => {
    const v2 = new Config({ input: { skip_tools: ['Read', 'Bash'] }, ai: { ai_skip_tools: ['grep'] } })
    expect(v2.skipTools.has('read')).toBe(true)
    expect(v2.skipTools.has('bash')).toBe(true)
    expect(v2.aiSkipTools.has('grep')).toBe(true)
    const v1 = new Config({ compression: { skip_tools: ['Edit'] } })
    expect(v1.skipTools.has('edit')).toBe(true)
  })

  it('maps [safety].disabled (v2) equivalently to [compression].disabled (v1)', () => {
    // P1 is a pure refactor: v2 must resolve identically to v1 for the same value.
    // (Note: the toml `disabled` flag has a pre-existing env-gate quirk — only
    // SQUEEZR_DISABLED=1/true actually flips it — preserved here unchanged.)
    for (const val of [true, false]) {
      expect(new Config({ safety: { disabled: val } }).disabled)
        .toBe(new Config({ compression: { disabled: val } }).disabled)
    }
    expect(new Config({}).disabled).toBe(false)
  })

  it('exposes the previously-hardcoded [ai]/[safety] constants with correct defaults', () => {
    const d = new Config({})
    expect(d.aiMinChars).toBe(1500)
    expect(d.aiRateLimitWindowMs).toBe(300_000)
    expect(d.aiRateLimitMaxCalls).toBe(20)
    expect(d.circuitBreakerFailures).toBe(3)
    expect(d.circuitBreakerResetMs).toBe(60_000)
    expect(d.circuitBreakerTimeoutMs).toBe(5_000)
    expect(d.guardMinRatio).toBeCloseTo(0.15)
    expect(d.guardSoftTolerance).toBeCloseTo(0.10)
    expect(d.maxDeflate).toBeCloseTo(0.55)
  })

  it('overrides the exposed constants from the toml', () => {
    const c = new Config({
      ai: { min_chars: 2500, rate_limit_max_calls: 40 },
      safety: { circuit_breaker_failures: 5, guard_min_ratio: 0.25 },
    })
    expect(c.aiMinChars).toBe(2500)
    expect(c.aiRateLimitMaxCalls).toBe(40)
    expect(c.circuitBreakerFailures).toBe(5)
    expect(c.guardMinRatio).toBeCloseTo(0.25)
  })

  it('keeps compress_system_prompt gated behind the ai master switch', () => {
    expect(new Config({ ai: { compress_system_prompt: true, ai_compression: false } }).compressSystemPrompt).toBe(false)
    expect(new Config({ ai: { compress_system_prompt: true, ai_compression: true } }).compressSystemPrompt).toBe(true)
  })
})
