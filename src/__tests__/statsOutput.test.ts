import { describe, it, expect } from 'vitest'
import { Stats } from '../stats.js'

// recordEcho / recordShaping only mutate in-memory counters (persistence happens on the
// main record() path), so these tests never touch ~/.squeezr. We assert relative deltas
// so a pre-existing stats.json baseline doesn't matter.
describe('Stats output metrics', () => {
  it('recordEcho updates sample count and average echo', () => {
    const s = new Stats()
    const before = s.summary().output
    s.recordEcho(0.2)
    s.recordEcho(0.4)
    const after = s.summary().output
    expect(after.echo_samples).toBe(before.echo_samples + 2)
    expect(after.avg_echo_pct).toBeGreaterThanOrEqual(0)
    expect(after.avg_echo_pct).toBeLessThanOrEqual(100)
  })

  it('recordShaping counts only the true flags', () => {
    const s = new Stats()
    const before = s.summary().output
    s.recordShaping(true, false)   // steered only
    s.recordShaping(true, true)    // steered + effort
    s.recordShaping(false, false)  // neither
    const after = s.summary().output
    expect(after.steered).toBe(before.steered + 2)
    expect(after.effort_lowered).toBe(before.effort_lowered + 1)
  })

  it('avg echo reflects the mean of the samples added', () => {
    const s = new Stats()
    // add a large batch so any baseline is diluted toward our known mean
    for (let i = 0; i < 200; i++) s.recordEcho(0.3)
    expect(Math.abs(s.summary().output.avg_echo_pct - 30)).toBeLessThan(10)
  })

  it('recordBypassed counts separately and never touches processed/saved totals', () => {
    const s = new Stats()
    const before = s.summary()
    s.recordBypassed()
    s.recordBypassed()
    const after = s.summary()
    expect(after.bypassed_requests).toBe(before.bypassed_requests + 2)
    // bypassed traffic must NOT inflate processed or saved
    expect(after.total_original_chars).toBe(before.total_original_chars)
    expect(after.total_saved_chars).toBe(before.total_saved_chars)
    expect(after.requests).toBe(before.requests)
  })
})
