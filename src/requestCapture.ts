/**
 * Request capture mode (v1.47.0).
 *
 * Writes anonymized real request bodies to `~/.squeezr/captures/req-NNNN.json`
 * for offline analysis. The captured payloads become the test corpus for
 * future features that need to know the actual shape of Claude Code /
 * Claude Desktop / Codex traffic.
 *
 * Opt-in via `compression.capture_requests = true` in `~/.squeezr/squeezr.toml`.
 * Default OFF — no behavior change otherwise.
 *
 * Safety:
 *  - Auth headers (`authorization`, `x-api-key`, `cookie`) are NEVER written.
 *  - Capture stops after `capture_limit` files (default 20) to bound disk use.
 *  - Failure to write a capture must NEVER block the user's request — wrapped
 *    in try/catch with silent logging.
 */
import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
const CAPTURE_DIR = join(homedir(), '.squeezr', 'captures')
const REDACTED = '<redacted>'
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
])
function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : v
  }
  return out
}
function countExistingCaptures(): number {
  try {
    if (!existsSync(CAPTURE_DIR)) return 0
    return readdirSync(CAPTURE_DIR).filter(f => f.startsWith('req-') && f.endsWith('.json')).length
  } catch {
    return 0
  }
}
function nextCaptureName(): string {
  const n = countExistingCaptures() + 1
  return `req-${String(n).padStart(4, '0')}.json`
}
export interface CaptureContext {
  client: string         // detectAnthropicClient output, e.g. 'claude_code'
  model: string          // body.model
  method: string         // 'POST'
  path: string           // '/v1/messages'
  headers: Record<string, string>  // request headers, will be redacted
}
export function captureRequest(
  body: unknown,
  ctx: CaptureContext,
  opts: { enabled: boolean; limit: number },
): void {
  if (!opts.enabled) return
  try {
    if (countExistingCaptures() >= opts.limit) return
    if (!existsSync(CAPTURE_DIR)) mkdirSync(CAPTURE_DIR, { recursive: true })
    const filename = nextCaptureName()
    const payload = {
      timestamp: new Date().toISOString(),
      client: ctx.client,
      model: ctx.model,
      method: ctx.method,
      path: ctx.path,
      headers: redactHeaders(ctx.headers),
      body,
    }
    writeFileSync(join(CAPTURE_DIR, filename), JSON.stringify(payload, null, 2))
    console.log(`[squeezr/capture] Saved ${filename} (${countExistingCaptures()}/${opts.limit})`)
  } catch (err) {
    // Capture must never block the user — log + swallow
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[squeezr/capture-fail] ${msg}`)
  }
}
// Internal export for testing
export const _internal = { redactHeaders, countExistingCaptures, nextCaptureName, CAPTURE_DIR }
