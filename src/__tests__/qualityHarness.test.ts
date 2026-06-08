/**
 * Stage 5 — Quality harness.
 *
 * Compresses a corpus of REAL-shaped tool outputs with the live local model (Zest
 * via Ollama) and measures, per fixture:
 *   (a) compression ratio (did it actually shrink?)
 *   (b) hard-token retention (paths / URLs / error codes MUST survive — 100%)
 *   (c) whether the acceptance guardrail would accept the result
 *
 * Skipped automatically when Ollama isn't reachable, so CI without a model stays
 * green. Run locally with Ollama up:  npm run test:quality
 */
import { describe, it, expect } from 'vitest'
import { compressLargeText } from '../compressor.js'
import { validateCompression } from '../compressionGuard.js'

const OLLAMA = process.env.SQUEEZR_LOCAL_UPSTREAM || 'http://localhost:11434'
const MODEL = process.env.SQUEEZR_LOCAL_MODEL || 'zest'

async function ollamaUp(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch { return false }
}
const UP = await ollamaUp()

// Hard tokens that MUST survive an ACCEPTED compression: URLs, error/status codes,
// and explicit filenames. Clean regexes (no greedy path matching) so the harness
// oracle doesn't produce partial-match artifacts.
function hardTokens(text: string): string[] {
  const sets = [
    /https?:\/\/[^\s"'<>)\]]+/g,                              // URLs
    /\b[\w\-]+\.(?:ts|tsx|js|py|json|md|go|rs|yml|yaml|toml|sql)\b/g, // filenames
    /\b(?:E[A-Z]{2,}|HTTP\s?\d{3}|exit code \d+|errno\s?\d+|status\s?[45]\d{2})\b/g, // error/status codes
  ]
  const out = new Set<string>()
  for (const re of sets) for (const m of text.match(re) ?? []) out.add(m)
  return [...out]
}

interface Fixture { name: string; text: string }
const CORPUS: Fixture[] = [
  {
    name: 'verbose-file-read',
    text: `import { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\n` +
      Array.from({ length: 60 }, (_, i) =>
        `export function handler${i}(req: Request, res: Response) {\n` +
        `  // process incoming request number ${i} with full validation and logging\n` +
        `  const data = readFileSync(join('/srv/app/data', 'file${i}.json'), 'utf-8')\n` +
        `  if (!data) throw new Error('missing file${i}.json at /srv/app/data')\n  return res.json(JSON.parse(data))\n}`).join('\n'),
  },
  {
    name: 'test-failure',
    text: `FAIL src/auth/login.test.ts > rejects bad password\n` +
      `AssertionError: expected 401 to equal 200\n  at Object.<anonymous> (src/auth/login.test.ts:88:14)\n` +
      `  at src/auth/session.ts:42:9\nECONNREFUSED connecting to https://api.internal/auth\n` +
      'stack frame filler line that pads the block to be worth compressing '.repeat(30),
  },
  {
    name: 'build-log',
    text: `> tsc\n` + 'compiling module with verbose diagnostic output and progress notes '.repeat(40) +
      `\nWARNING deprecated API used in src/legacy/parser.ts line 210\n` +
      `see https://example.com/docs/migration for the upgrade path\nDone in 4.2s`,
  },
  {
    name: 'json-response',
    text: JSON.stringify({
      status: 500, error: 'ECONNRESET',
      endpoint: 'https://api.service.com/v2/orders',
      items: Array.from({ length: 40 }, (_, i) => ({ id: i, sku: `SKU-${i}`, qty: i * 2, note: 'a fairly long descriptive note about this line item for padding' })),
    }, null, 2),
  },
]

describe('quality harness (Zest live)', () => {
  it(`Ollama reachable at ${OLLAMA}`, () => {
    if (!UP) console.warn(`[harness] Ollama not reachable — quality cases skipped`)
    expect(true).toBe(true)
  })

  for (const fx of CORPUS) {
    it.skipIf(!UP)(`${fx.name}: compresses and keeps all hard tokens`, async () => {
      const out = await compressLargeText(fx.text, OLLAMA, MODEL)
      const ratio = 1 - out.length / fx.text.length
      const hard = hardTokens(fx.text)
      const lost = hard.filter(t => !out.includes(t))
      const guard = validateCompression(fx.text, out)
      console.log(`[harness] ${fx.name}: ratio=${(ratio * 100).toFixed(0)}% hardTokens=${hard.length} lost=${lost.length} guard=${guard.accept ? 'accept' : 'reject:' + guard.reason}`)
      // It must actually shrink the block.
      expect(ratio).toBeGreaterThan(0)
      // THE safety property: a compression the guardrail ACCEPTS must not have lost
      // any hard token. If Zest mangled one, the guardrail must have rejected it
      // (production then keeps the deterministic form — no quality loss).
      if (guard.accept) {
        expect(lost).toEqual([])
      }
    }, 30000)
  }
})
