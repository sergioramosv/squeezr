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

const WINDOW_MS = 5 * 60 * 1000   // 5 minutes — matches Claude Code's 5h window cadence
const MAX_CALLS_PER_WINDOW = 20   // generous for normal use, hard ceiling against bursts

const callTimestamps: number[] = []

/** Returns true if another AI call is allowed right now (and records it). */
export function tryConsumeAiCall(): boolean {
  const now = Date.now()
  // Drop timestamps outside the window
  while (callTimestamps.length > 0 && now - callTimestamps[0] > WINDOW_MS) {
    callTimestamps.shift()
  }
  if (callTimestamps.length >= MAX_CALLS_PER_WINDOW) return false
  callTimestamps.push(now)
  return true
}

/** How many calls remain in the current window (for logging / dashboard). */
export function aiCallsRemaining(): number {
  const now = Date.now()
  while (callTimestamps.length > 0 && now - callTimestamps[0] > WINDOW_MS) {
    callTimestamps.shift()
  }
  return Math.max(0, MAX_CALLS_PER_WINDOW - callTimestamps.length)
}

export const _config = { WINDOW_MS, MAX_CALLS_PER_WINDOW }
