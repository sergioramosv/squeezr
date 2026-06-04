import { describe, it, expect } from 'vitest'
import { tryConsumeAiCall, aiCallsRemaining, _config } from '../aiRateLimit.js'
describe('aiRateLimit', () => {
  it('allows up to MAX_CALLS_PER_WINDOW calls then blocks', () => {
    // Fresh module state — consume the whole window
    let allowed = 0
    for (let i = 0; i < _config.MAX_CALLS_PER_WINDOW + 10; i++) {
      if (tryConsumeAiCall()) allowed++
    }
    expect(allowed).toBe(_config.MAX_CALLS_PER_WINDOW)
  })
  it('reports 0 remaining once exhausted', () => {
    // Window already exhausted by the previous test (same module instance)
    expect(aiCallsRemaining()).toBe(0)
  })
  it('blocks further calls after exhaustion', () => {
    expect(tryConsumeAiCall()).toBe(false)
  })
})
