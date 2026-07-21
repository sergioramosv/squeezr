/**
 * squeezr learn — offline mining of Claude Code sessions for wasteful LOOPS, writing
 * corrections to CLAUDE.local.md. Squeezr's take on headroom's `headroom learn`.
 *
 * The highest-value, cheapest signal is loop detection (no LLM needed):
 *   - error loops   — the same command fails and is retried ≥3× (the agent is stuck).
 *   - refetch loops — the agent re-runs pagination VARIANTS of a command (`| head -50`
 *     → `head -100` → `head -200`) because the output kept getting truncated. These
 *     SUCCEED, so failure-only analysis misses them, yet each re-fetch re-bills the
 *     whole (bigger) output. Canonicalising away the pagination fragment collapses the
 *     variants to one signature so the loop becomes visible.
 *
 * Wasted bytes are a MEASURED lower bound from real tool-output sizes, not a guess.
 *
 * The pure functions here (canonicalSignature / extractToolCalls / detectLoops /
 * renderCorrections / writeMarkerBlock) are unit-tested; runLearn() is the thin
 * filesystem orchestrator the CLI calls.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ToolCall {
  tool: string
  signature: string
  raw: string
  isError: boolean
  outputBytes: number
}

export type LoopKind = 'error' | 'refetch'

export interface Loop {
  kind: LoopKind
  signature: string
  count: number
  wastedBytes: number
  sampleRaw: string
  tool: string
}

export const MIN_OCCURRENCES = 3

// ── Canonical signature ──────────────────────────────────────────────────────

// Fragments that vary between re-fetches of "the same" query but don't change intent.
const PAGINATION_PATTERNS: RegExp[] = [
  /\|\s*head\s+-?n?\s*\d+/gi,      // | head -50 / | head -n 50
  /\|\s*tail\s+-?n?\s*\d+/gi,      // | tail -50
  /\bhead\s+-n\s*\d+/gi,
  /\btail\s+-n\s*\d+/gi,
  /\b-n\s+\d+/gi,                  // -n 50
  /\blimit\s+\d+/gi,               // LIMIT 50
  /\boffset\s+\d+/gi,              // OFFSET 40
  /--limit[=\s]+\d+/gi,
  /--offset[=\s]+\d+/gi,
  /[?&](?:per_page|page|limit|offset)=\d+/gi,
]

function inputToString(tool: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (typeof obj.command === 'string') return obj.command
    // Deterministic: sort keys so the signature is stable.
    const keys = Object.keys(obj).sort()
    return keys.map(k => `${k}=${typeof obj[k] === 'object' ? JSON.stringify(obj[k]) : String(obj[k])}`).join(' ')
  }
  return String(input ?? '')
}

/** Stable, pagination-stripped signature. Same intent → same signature. */
export function canonicalSignature(tool: string, input: unknown): string {
  let s = `${tool.toLowerCase()} ${inputToString(tool, input)}`
  for (const re of PAGINATION_PATTERNS) s = s.replace(re, ' ')
  s = s.replace(/\b\d+\b/g, 'N')      // collapse remaining bare integers
  s = s.replace(/\s+/g, ' ').trim().toLowerCase()
  return s
}

// ── Parse Claude Code JSONL ──────────────────────────────────────────────────

function contentBytes(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) return JSON.stringify(content).length
  if (content && typeof content === 'object') return JSON.stringify(content).length
  return 0
}

/**
 * Extract normalized tool calls from Claude Code session JSONL lines. Tolerant of
 * malformed lines and both string/array tool_result content shapes.
 */
export function extractToolCalls(lines: string[]): ToolCall[] {
  const uses = new Map<string, { tool: string; raw: string; signature: string }>()
  const results = new Map<string, { isError: boolean; outputBytes: number }>()
  const order: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: unknown
    try { obj = JSON.parse(trimmed) } catch { continue }
    const msg = (obj as { message?: { content?: unknown } })?.message
    const content = msg?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const raw = inputToString(block.name, block.input)
        uses.set(block.id, { tool: block.name, raw, signature: canonicalSignature(block.name, block.input) })
        order.push(block.id)
      } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        results.set(block.tool_use_id, {
          isError: !!block.is_error,
          outputBytes: contentBytes(block.content),
        })
      }
    }
  }

  const calls: ToolCall[] = []
  for (const id of order) {
    const u = uses.get(id)
    if (!u) continue
    const r = results.get(id)
    calls.push({ tool: u.tool, signature: u.signature, raw: u.raw, isError: r?.isError ?? false, outputBytes: r?.outputBytes ?? 0 })
  }
  return calls
}

// ── Loop detection ───────────────────────────────────────────────────────────

export function detectLoops(calls: ToolCall[], minOccurrences = MIN_OCCURRENCES): Loop[] {
  const groups = new Map<string, ToolCall[]>()
  for (const c of calls) {
    const arr = groups.get(c.signature) ?? []
    arr.push(c)
    groups.set(c.signature, arr)
  }

  const loops: Loop[] = []
  for (const [signature, arr] of groups) {
    if (arr.length < minOccurrences) continue
    const errors = arr.filter(c => c.isError)

    if (errors.length >= minOccurrences) {
      // Error loop: measured waste = every failed repetition's output.
      loops.push({
        kind: 'error',
        signature,
        count: errors.length,
        wastedBytes: errors.reduce((s, c) => s + c.outputBytes, 0),
        sampleRaw: errors[0].raw,
        tool: errors[0].tool,
      })
      continue
    }

    // Refetch loop: same signature, ≥2 distinct raw variants (pagination churn).
    const distinctRaw = new Set(arr.map(c => c.raw))
    if (distinctRaw.size >= 2) {
      const sorted = [...arr].sort((a, b) => a.outputBytes - b.outputBytes)
      // Redundant = all but the single legitimate fetch (the smallest).
      const wastedBytes = sorted.slice(1).reduce((s, c) => s + c.outputBytes, 0)
      loops.push({
        kind: 'refetch',
        signature,
        count: arr.length,
        wastedBytes,
        sampleRaw: arr[0].raw,
        tool: arr[0].tool,
      })
    }
  }

  return loops.sort((a, b) => b.wastedBytes - a.wastedBytes)
}

// ── Corrections + marker writer ──────────────────────────────────────────────

export const LEARN_START = '<!-- squeezr:learn:start -->'
export const LEARN_END = '<!-- squeezr:learn:end -->'

function approxTokens(bytes: number): number {
  return Math.round(bytes / 4)
}

export function renderCorrections(loops: Loop[]): string {
  if (loops.length === 0) return ''
  const lines: string[] = []
  for (const l of loops) {
    const tok = approxTokens(l.wastedBytes)
    if (l.kind === 'error') {
      lines.push(`- \`${l.sampleRaw}\` failed and was retried ${l.count}× (~${tok} tokens wasted). Fix the root cause before retrying, or don't re-run the identical failing command.`)
    } else {
      lines.push(`- \`${l.sampleRaw}\` was re-fetched with growing pagination ${l.count}× (~${tok} tokens wasted). Ask for the full/needed range in ONE call instead of re-running with a bigger limit.`)
    }
  }
  return lines.join('\n')
}

/**
 * Insert/replace the squeezr-managed block in a CLAUDE.local.md-style file. Idempotent:
 * re-applying the same rules yields byte-identical content; a new set replaces the old.
 */
export function writeMarkerBlock(existing: string, rulesBody: string): string {
  const block = `${LEARN_START}\n## Squeezr learned rules (auto-generated — avoid these token-wasting loops)\n${rulesBody}\n${LEARN_END}`
  const re = new RegExp(`${LEARN_START}[\\s\\S]*?${LEARN_END}`)
  if (re.test(existing)) {
    return existing.replace(re, block)
  }
  const sep = existing.length === 0 || existing.endsWith('\n') ? '\n' : '\n\n'
  return `${existing}${sep}${block}\n`
}

// ── Orchestrator (filesystem — thin) ─────────────────────────────────────────

export interface LearnOptions {
  apply?: boolean
  projectsDir?: string   // default ~/.claude/projects
  targetFile?: string    // default <cwd>/CLAUDE.local.md
  maxSessions?: number    // most-recent N session files to scan (default 20)
}

export interface LearnResult {
  sessionsScanned: number
  loops: Loop[]
  report: string
  applied: boolean
  targetFile: string
}

function newestJsonl(dir: string, limit: number): string[] {
  const found: Array<{ path: string; mtime: number }> = []
  const walk = (d: string) => {
    let entries: string[] = []
    try { entries = readdirSync(d) } catch { return }
    for (const name of entries) {
      const p = join(d, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p)
      else if (name.endsWith('.jsonl')) found.push({ path: p, mtime: st.mtimeMs })
    }
  }
  walk(dir)
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map(f => f.path)
}

export function runLearn(opts: LearnOptions = {}): LearnResult {
  const projectsDir = opts.projectsDir ?? join(homedir(), '.claude', 'projects')
  const targetFile = opts.targetFile ?? join(process.cwd(), 'CLAUDE.local.md')
  const limit = opts.maxSessions ?? 20

  const files = existsSync(projectsDir) ? newestJsonl(projectsDir, limit) : []
  const allCalls: ToolCall[] = []
  for (const f of files) {
    try { allCalls.push(...extractToolCalls(readFileSync(f, 'utf-8').split('\n'))) } catch { /* skip */ }
  }

  const loops = detectLoops(allCalls)
  const totalTokens = approxTokens(loops.reduce((s, l) => s + l.wastedBytes, 0))
  const header = files.length === 0
    ? `No Claude Code sessions found under ${projectsDir}.`
    : `Scanned ${files.length} session(s), ${allCalls.length} tool call(s). Found ${loops.length} loop(s), ~${totalTokens} tokens wasted.`
  const report = loops.length ? `${header}\n\n${renderCorrections(loops)}` : header

  let applied = false
  if (opts.apply && loops.length > 0) {
    const existing = existsSync(targetFile) ? readFileSync(targetFile, 'utf-8') : ''
    writeFileSync(targetFile, writeMarkerBlock(existing, renderCorrections(loops)), 'utf-8')
    applied = true
  }

  return { sessionsScanned: files.length, loops, report, applied, targetFile }
}
