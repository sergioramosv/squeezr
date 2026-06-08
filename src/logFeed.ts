// ── Live log feed ────────────────────────────────────────────────────────────
// Tees console.log into an in-memory ring buffer so the dashboard can show the
// *real* compression log lines (e.g. "[squeezr/det] Deterministic: -32,323 chars
// (~9235 tokens) across 54 block(s)") in real time. Not persisted — session only.

export interface LogLine { id: number; ts: number; text: string }

const MAX_LINES = 200
const buffer: LogLine[] = []
let seq = 0
let installed = false

// Only savings/compression lines are interesting for the feed. They all start
// with "[squeezr" and report a "-N chars" delta. This excludes config/boot noise
// like "[squeezr] Using user config" or "[squeezr] Mode → normal".
// Also keep CRITICAL quality events (governor backing off on a high expand rate =
// real info loss) so they surface in the Live Log — but NOT benign recoveries.
const KEEP = /^\[squeezr[^\]]*\].*-[\d.,]+\s*chars/
const KEEP_CRITICAL = /^\[squeezr\/quality\] backing off/

export function recordLogLine(text: string): void {
  const clean = text.replace(/\s+$/, '')
  if (!KEEP.test(clean) && !KEEP_CRITICAL.test(clean)) return
  buffer.push({ id: ++seq, ts: Date.now(), text: clean })
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES)
}

/** Recent compression log lines, oldest → newest. */
export function recentLogLines(): LogLine[] {
  return buffer
}

/** Monkey-patch console.log so every savings line is mirrored into the feed. */
export function installLogCapture(): void {
  if (installed) return
  installed = true
  const orig = console.log.bind(console)
  console.log = (...args: unknown[]) => {
    orig(...args)
    try {
      if (args.length && typeof args[0] === 'string') recordLogLine(args.join(' '))
    } catch { /* never let logging break the request path */ }
  }
}
