/**
 * Quality governor — auto-backoff based on the expand rate.
 *
 * The expand rate (how often the model calls the `expand` tool to recover a
 * compressed block's original) is THE signal that compression dropped something
 * the model actually needed. When it climbs above a healthy threshold, we make AI
 * compression LESS aggressive by raising the minimum block size (effectiveAiMinChars),
 * so fewer/borderline blocks are touched. When it recovers, we step back down.
 *
 * This only ever trades ratio for safety — it can never increase information loss.
 */
import { runtimeOverrides, DEFAULT_AI_MIN_CHARS } from './config.js'

// Backoff ladder for aiMinChars (chars). Index 0 = most aggressive (the default);
// each rung is strictly higher so backing off actually reduces AI attempts.
const LADDER = [DEFAULT_AI_MIN_CHARS, 2500, 4000, 6000]
let level = 0

// Health thresholds on the expand rate (% of compressions that got expanded).
const RED = 8     // >= 8% over enough samples → back off one step
const GREEN = 3   // < 3% → recover one step
const MIN_SAMPLES = 30
// Cooldown so we don't oscillate. Measured in "AI attempts" = guardSamples
// (accepted + rejected), which advances even when every result is rejected — unlike
// `compressions`, which only counts accepted ones and would stall an all-reject case.
const COOLDOWN_ATTEMPTS = 20
let lastMoveAtAttempts = 0

export type QualityHealth = 'green' | 'amber' | 'red' | 'unknown'

export function expandHealth(ratePct: number, compressions: number): QualityHealth {
  if (compressions < MIN_SAMPLES) return 'unknown'
  if (ratePct >= RED) return 'red'
  if (ratePct >= GREEN) return 'amber'
  return 'green'
}

// Guard reject rate is the IMMEDIATE quality signal (expand rate is rare/slow): a
// high reject rate means the current floor is letting through blocks that compress
// badly. Back off when it's high; it also gates recovery.
const REJECT_RED = 40   // >= 40% rejects → too aggressive, back off
const REJECT_OK = 20    // < 20% rejects → safe to recover
const GUARD_MIN_SAMPLES = 8

/**
 * Evaluate expand rate + guard reject rate and adjust effectiveAiMinChars.
 * Call periodically (e.g. from buildStatsPayload). Returns health + active aiMinChars.
 */
export function governQuality(
  ratePct: number,
  compressions: number,
  rejectRatePct = 0,
  guardSamples = 0,
): { health: QualityHealth; aiMinChars: number; level: number } {
  const expandBad = expandHealth(ratePct, compressions) === 'red'
  const rejectBad = guardSamples >= GUARD_MIN_SAMPLES && rejectRatePct >= REJECT_RED
  const rejectOk = guardSamples < GUARD_MIN_SAMPLES || rejectRatePct < REJECT_OK
  // Combined health for the dashboard: worst of the two signals.
  let health: QualityHealth = expandHealth(ratePct, compressions)
  if (rejectBad) health = 'red'
  else if (guardSamples >= GUARD_MIN_SAMPLES && rejectRatePct >= REJECT_OK && health === 'green') health = 'amber'
  const sinceLastMove = guardSamples - lastMoveAtAttempts

  if ((expandBad || rejectBad) && level < LADDER.length - 1 && sinceLastMove >= COOLDOWN_ATTEMPTS) {
    level++
    runtimeOverrides.aiMinChars = LADDER[level]
    lastMoveAtAttempts = guardSamples
    console.log(`[squeezr/quality] backing off → aiMinChars=${LADDER[level]} (expand ${ratePct}%, guard reject ${rejectRatePct}%)`)
  } else if (!expandBad && rejectOk && expandHealth(ratePct, compressions) !== 'red' && level > 0 && sinceLastMove >= COOLDOWN_ATTEMPTS) {
    level--
    runtimeOverrides.aiMinChars = level === 0 ? undefined : LADDER[level]
    lastMoveAtAttempts = guardSamples
    console.log(`[squeezr/quality] recovering → aiMinChars=${level === 0 ? DEFAULT_AI_MIN_CHARS : LADDER[level]} (expand ${ratePct}%, guard reject ${rejectRatePct}%)`)
  }

  return { health, aiMinChars: runtimeOverrides.aiMinChars ?? DEFAULT_AI_MIN_CHARS, level }
}
