/**
 * CacheAligner (detector-only) — Squeezr's take on headroom's CacheAligner.
 *
 * Anthropic bills the cached prefix at 0.1x, but ONLY if the prefix arrives byte-for-byte
 * identical between requests. If the CLIENT's own system prompt embeds volatile content
 * (a per-session UUID, a live timestamp, a build hash, a JWT) INSIDE the cached region,
 * that prefix changes every request and the cache never hits — re-billing the whole
 * context at full price. That is exactly the failure that once burned a 5h plan.
 *
 * Squeezr already monitors cache hit-health %; this tells you the likely CAUSE. It is a
 * pure DETECTOR: it never mutates the prompt (mutating the cache hot zone is itself a
 * cache-buster). It just surfaces "your prefix is unstable because of X".
 *
 * Detection is structural (shape-based regex over known volatile token forms), not
 * semantic. Order matters: JWTs are matched before hashes so a JWT segment isn't
 * miscounted as a hex hash.
 */

export type VolatileKind = 'uuid' | 'timestamp' | 'jwt' | 'hash'

export interface VolatileFinding {
  kind: VolatileKind
  count: number
}

const PATTERNS: Array<{ kind: VolatileKind; re: RegExp }> = [
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g },
  { kind: 'uuid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { kind: 'timestamp', re: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g },
  { kind: 'hash', re: /\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b/gi },
]

/** Structural scan for volatile tokens. Matched kinds are masked out before later
 *  patterns run, so a JWT is never also counted as a hash. */
export function detectVolatile(text: string): VolatileFinding[] {
  let scan = text
  const findings: VolatileFinding[] = []
  for (const { kind, re } of PATTERNS) {
    const matches = scan.match(re)
    if (matches && matches.length > 0) {
      findings.push({ kind, count: matches.length })
      scan = scan.replace(re, ' ') // mask so subsequent, looser patterns don't re-match
    }
  }
  return findings
}

export interface SystemAnalysis {
  hasVolatile: boolean
  findings: VolatileFinding[]
}

function systemToText(system: unknown): string {
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return (system as Array<{ type?: string; text?: string }>)
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
      .join('\n')
  }
  return ''
}

export function analyzeSystemPrompt(system: unknown): SystemAnalysis {
  const findings = detectVolatile(systemToText(system))
  return { hasVolatile: findings.length > 0, findings }
}

export function formatVolatileWarning(findings: VolatileFinding[]): string {
  const parts = findings.map(f => `${f.count}× ${f.kind}`).join(', ')
  return `[squeezr/cache-aligner] system prompt contains volatile content (${parts}) — if it sits inside the cached prefix it will bust Anthropic's prompt cache every request. Squeezr never mutates the prefix; consider moving volatile tokens after the cache_control breakpoint.`
}

// ── Throttled warning (no per-request spam) ──────────────────────────────────

const warned = new Set<string>()

/** Warn at most once per distinct finding signature. Returns true iff it warned now. */
export function warnIfVolatile(system: unknown): boolean {
  const { hasVolatile, findings } = analyzeSystemPrompt(system)
  if (!hasVolatile) return false
  const sig = findings.map(f => `${f.kind}:${f.count}`).sort().join('|')
  if (warned.has(sig)) return false
  warned.add(sig)
  console.log(formatVolatileWarning(findings))
  return true
}

export function _resetWarnedForTest(): void {
  warned.clear()
}
