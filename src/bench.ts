/**
 * squeezr bench — honest, reproducible compression+accuracy harness.
 *
 * Headroom's headline claim is "same answers, fewer tokens", proven by having an LLM
 * answer questions over compressed data. That needs an API key and costs money, so it
 * can't live in CI. This harness measures the same thing with a zero-cost, deterministic
 * proxy for accuracy: FACT RECALL.
 *
 * For each fixture we declare the CRITICAL FACTS an answer would need (an error code, a
 * filename, a specific value, a count). We compress the fixture through Squeezr's real
 * deterministic pipeline and measure:
 *
 *   - compressionPct — chars removed / original chars.
 *   - inlineRecall    — fraction of critical facts still present VERBATIM in the compressed
 *                       output (i.e. answerable WITHOUT an expand round-trip).
 *
 * Recoverability is 100% by design (every compressed block stores its original in the
 * expand store — see expand.test.ts), so the meaningful, honest metric is how much
 * survives inline. A fixture that trades recall for ratio (huge-log head/tail) shows it
 * here rather than hiding it.
 */

import { preprocessForTool } from './deterministic.js'

export interface Fixture {
  name: string
  tool: string
  content: string
  facts: string[]
}

export interface BenchRow {
  name: string
  originalChars: number
  compressedChars: number
  compressionPct: number
  inlineRecall: number
}

export interface BenchSummary {
  rows: BenchRow[]
  avgCompressionPct: number
  avgInlineRecall: number
}

/** Fraction of `facts` present verbatim in `text`. Empty fact list → 1 (nothing to lose). */
export function factRecall(text: string, facts: string[]): number {
  if (facts.length === 0) return 1
  const present = facts.filter(f => text.includes(f)).length
  return present / facts.length
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function jsonArrayFixture(): string {
  const rows = []
  for (let i = 0; i < 40; i++) {
    rows.push({ id: i, service: `svc-${i}`, status: i === 17 ? 'CrashLoopBackOff' : 'Running', restarts: i === 17 ? 42 : 0, node: 'ip-10-0-1-5' })
  }
  return JSON.stringify(rows)
}

function buildLogFixture(): string {
  const lines: string[] = []
  for (let i = 0; i < 60; i++) lines.push('[webpack] compiling module... ok')
  lines.push('ERROR in ./src/app.ts:128:14')
  lines.push("TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.")
  for (let i = 0; i < 60; i++) lines.push('[webpack] compiling module... ok')
  return lines.join('\n')
}

function grepFixture(): string {
  const lines: string[] = []
  for (let f = 0; f < 30; f++) {
    for (let l = 0; l < 5; l++) lines.push(`src/mod${f}.ts:${l + 1}: const value = computeThing(${l})`)
  }
  lines.push('src/critical.ts:99: throw new FatalError("DISK_FULL")')
  return lines.join('\n')
}

export const FIXTURES: Fixture[] = [
  {
    name: 'json-array (k8s pods)',
    tool: 'Bash',
    content: jsonArrayFixture(),
    // The one anomalous row an answer would need + its schema.
    facts: ['CrashLoopBackOff', '42', 'svc-17', 'ip-10-0-1-5'],
  },
  {
    name: 'build-log (tsc error in noise)',
    tool: 'Bash',
    content: buildLogFixture(),
    facts: ['TS2345', './src/app.ts:128:14'],
  },
  {
    name: 'grep-dump (fatal among matches)',
    tool: 'Grep',
    content: grepFixture(),
    facts: ['DISK_FULL', 'src/critical.ts:99'],
  },
]

// ── Runner ───────────────────────────────────────────────────────────────────

export function runBench(fixtures: Fixture[] = FIXTURES): BenchSummary {
  const rows: BenchRow[] = fixtures.map(f => {
    const compressed = preprocessForTool(f.content, f.tool, 0)
    const originalChars = f.content.length
    const compressedChars = compressed.length
    const compressionPct = originalChars > 0 ? Math.max(0, ((originalChars - compressedChars) / originalChars) * 100) : 0
    return {
      name: f.name,
      originalChars,
      compressedChars,
      compressionPct: Math.round(compressionPct * 10) / 10,
      inlineRecall: factRecall(compressed, f.facts),
    }
  })

  const n = rows.length || 1
  return {
    rows,
    avgCompressionPct: Math.round((rows.reduce((s, r) => s + r.compressionPct, 0) / n) * 10) / 10,
    avgInlineRecall: Math.round((rows.reduce((s, r) => s + r.inlineRecall, 0) / n) * 100) / 100,
  }
}

/** Human-readable table for the CLI. */
export function formatBench(summary: BenchSummary): string {
  const lines: string[] = []
  lines.push('Squeezr compression + fact-recall benchmark')
  lines.push('(recoverability is 100% by design via squeezr_expand; inline recall = answerable without expanding)')
  lines.push('')
  lines.push('fixture                              orig    comp   saved   inline-recall')
  lines.push('─'.repeat(78))
  for (const r of summary.rows) {
    lines.push(
      `${r.name.padEnd(36)} ${String(r.originalChars).padStart(6)} ${String(r.compressedChars).padStart(6)} ${(r.compressionPct + '%').padStart(6)}   ${Math.round(r.inlineRecall * 100) + '%'}`,
    )
  }
  lines.push('─'.repeat(78))
  lines.push(`AVG: ${summary.avgCompressionPct}% compression · ${Math.round(summary.avgInlineRecall * 100)}% inline fact recall · 100% recoverable`)
  return lines.join('\n')
}
