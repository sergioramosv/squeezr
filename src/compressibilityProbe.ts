/**
 * Compressibility probe.
 *
 * AI compression (Zest/Haiku) only beats the quality guard's min-ratio when the
 * block actually contains removable redundancy (duplicate lines, boilerplate,
 * filler). On DENSE output — file-path lists, error dumps, test results where
 * every line is essential — the model correctly returns it ~unchanged, the
 * saving falls below the 15% floor, and the guard rejects it. The AI call was
 * already made (wasted compute/latency) and the dashboard shows "calls · 0 saved".
 *
 * This probe predicts incompressibility CHEAPLY (a single sync deflate) BEFORE
 * the AI call, so dense blocks skip AI entirely and stay in their deterministic
 * form. It is biased towards KEEPING: it only skips blocks that are clearly
 * already dense, so it never sacrifices a saving the model could have made.
 *
 * Calibrated against real Zest output:
 *   deflate 0.17 → Zest saved 56% (kept)      deflate 0.63 → Zest saved  5% (skip)
 *   deflate 0.45 → prose, borderline (kept)   deflate 0.76 → Zest saved  0% (skip)
 */
import zlib from 'node:zlib'

// Skip AI when the deflate ratio (compressed/original) is at or above this — the
// block is already information-dense and AI is very unlikely to beat the guard.
// Env-overridable for tuning without a rebuild.
const DEFAULT_MAX_DEFLATE = Number(process.env.SQUEEZR_MAX_DEFLATE) || 0.55
// Below this size the deflate ratio is noisy (header overhead skews small inputs)
// and a wasted call is cheap anyway — let AI try. In practice AI candidates are
// always >= aiThreshold (>=1000 chars), so this is just a safety floor.
const MIN_SIZE = 200

/** deflate(compressed)/original. 1.0 = incompressible, →0 = highly redundant. */
export function deflateRatio(text: string): number {
  if (!text) return 1
  const buf = Buffer.from(text, 'utf8')
  if (buf.length === 0) return 1
  return zlib.deflateRawSync(buf, { level: 6 }).length / buf.length
}

/**
 * True when the block is already so dense that AI compression is very unlikely
 * to clear the guard's min-ratio — so we skip the (would-be wasted) AI call.
 * Pure + synchronous → trivially unit-testable.
 */
export function looksIncompressible(text: string, maxDeflate = DEFAULT_MAX_DEFLATE): boolean {
  if (!text || text.length < MIN_SIZE) return false
  return deflateRatio(text) >= maxDeflate
}
