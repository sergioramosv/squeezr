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

// Backoff ladder for aiMinChars (chars). Index 0 = most aggressive (default).
const LADDER = [DEFAULT_AI_MIN_CHARS, 1500, 2500, 4000]
let level = 0

// Health thresholds on the expand rate (% of compressions that got expanded).
const RED = 8     // >= 8% over enough samples → back off one step
const GREEN = 3   // < 3% → recover one step
const MIN_SAMPLES = 30
// Cooldown so we don't oscillate: require this many compressions between moves.
const COOLDOWN_COMPRESSIONS = 50
let lastMoveAtCompressions = 0

export type QualityHealth = 'green' | 'amber' | 'red' | 'unknown'

export function expandHealth(ratePct: number, compressions: number): QualityHealth {
  if (compressions < MIN_SAMPLES) return 'unknown'
  if (ratePct >= RED) return 'red'
  if (ratePct >= GREEN) return 'amber'
  return 'green'
}

/**
 * Evaluate the current expand rate and adjust effectiveAiMinChars if warranted.
 * Call periodically (e.g. from buildStatsPayload). Returns the current health +
 * the active aiMinChars so the dashboard can show it.
 */
export function governQuality(ratePct: number, compressions: number): { health: QualityHealth; aiMinChars: number; level: number } {
  const health = expandHealth(ratePct, compressions)
  const sinceLastMove = compressions - lastMoveAtCompressions

  if (health === 'red' && level < LADDER.length - 1 && sinceLastMove >= COOLDOWN_COMPRESSIONS) {
    level++
    runtimeOverrides.aiMinChars = LADDER[level]
    lastMoveAtCompressions = compressions
    console.log(`[squeezr/quality] expand rate ${ratePct}% high → backing off: aiMinChars=${LADDER[level]} (less aggressive)`)
  } else if (health === 'green' && level > 0 && sinceLastMove >= COOLDOWN_COMPRESSIONS) {
    level--
    runtimeOverrides.aiMinChars = level === 0 ? undefined : LADDER[level]
    lastMoveAtCompressions = compressions
    console.log(`[squeezr/quality] expand rate ${ratePct}% healthy → recovering: aiMinChars=${LADDER[level]}`)
  }

  return { health, aiMinChars: runtimeOverrides.aiMinChars ?? DEFAULT_AI_MIN_CHARS, level }
}
