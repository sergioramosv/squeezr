/**
 * AI compression rate limiter (v1.60.0)
 *
 * Hard safety net so AI compression can NEVER stampede the user's quota again
 * (the 2026-06-04 incident: 215 Haiku calls in ~10 min). Sliding window — when
 * the window is full, AI compression is skipped (deterministic compression still
 * runs, it's free). Independent of the cache-barrier fix; this is the last line
 * of defence against any future bug that re-enables a burst.
 *
 * Window is process-global (not per-conversation): the user's quota is global.
 */

// Window + ceiling are now configurable ([ai].rate_limit_window_ms / _max_calls);
// defaults preserve the original 5-minute / 20-call safety net.
import { config } from './config.js'

const callTimestamps: number[] = []

/** Returns true if another AI call is allowed right now (and records it). */
export function tryConsumeAiCall(): boolean {
  const now = Date.now()
  // Drop timestamps outside the window
  while (callTimestamps.length > 0 && now - callTimestamps[0] > config.aiRateLimitWindowMs) {
    callTimestamps.shift()
  }
  if (callTimestamps.length >= config.aiRateLimitMaxCalls) return false
  callTimestamps.push(now)
  return true
}

/** How many calls remain in the current window (for logging / dashboard). */
export function aiCallsRemaining(): number {
  const now = Date.now()
  while (callTimestamps.length > 0 && now - callTimestamps[0] > config.aiRateLimitWindowMs) {
    callTimestamps.shift()
  }
  return Math.max(0, config.aiRateLimitMaxCalls - callTimestamps.length)
}

export const _config = { get WINDOW_MS() { return config.aiRateLimitWindowMs }, get MAX_CALLS_PER_WINDOW() { return config.aiRateLimitMaxCalls } }
