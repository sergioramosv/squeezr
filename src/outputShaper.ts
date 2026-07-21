/**
 * Output-side token reduction.
 *
 * Everything else in Squeezr compresses what goes INTO the model. This module is
 * the first lever on what comes OUT of it. The proxy never generates output
 * tokens, so both levers work by RESHAPING THE REQUEST:
 *
 *  1. Verbosity steering — a byte-stable instruction block appended to the TAIL
 *     of the system prompt (after any cache_control breakpoint, so the cached
 *     prefix is never touched → Anthropic prompt cache still hits). Same append
 *     pattern already proven safe by injectExpandDirectiveAnthropic().
 *
 *  2. Effort routing — agentic loops are mostly mechanical continuations (the
 *     last message is a clean tool_result: a file read, a passing test). Thinking
 *     bills as OUTPUT tokens (≈5× input on Opus). On mechanical turns we LOWER an
 *     explicitly-present thinking budget / effort; on errors or new user asks we
 *     leave it alone.
 *
 * Safety rules (each prevents a concrete failure mode):
 *  - Never INJECT an effort lever the client didn't send (models without effort
 *    support 400 on it). Only lowering an existing value is always valid.
 *  - Never toggle thinking.type (disabling thinking while history carries thinking
 *    blocks 400s on some models AND busts the messages cache tier).
 *  - Steering text is byte-stable per level and applied idempotently, so repeated
 *    requests keep an identical trailing block.
 *
 * Turn classification is purely STRUCTURAL (block types + is_error flags) — no
 * content regexes, no keyword matching.
 */

export type TurnKind = 'mechanical' | 'new-ask' | 'error' | 'unknown'
export type VerbosityLevel = 1 | 2 | 3 | 4

export interface OutputShaperSettings {
  enabled: boolean
  verbositySteering: boolean
  level: VerbosityLevel
  effortRouting: boolean
  /** Floor to clamp an existing thinking.budget_tokens to on mechanical turns. */
  mechanicalThinkingFloor: number
}

export interface ShapeResult {
  steered: boolean
  effortLowered: boolean
  turn: TurnKind
}

export const STEERING_START = '<squeezr_output_shaping>'
export const STEERING_END = '</squeezr_output_shaping>'

// ── Turn classification ──────────────────────────────────────────────────────

type Block = { type?: string; is_error?: boolean; text?: string; [k: string]: unknown }
type Message = { role?: string; content?: unknown }

function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : []
}

/**
 * Classify the latest turn structurally.
 *   error       — the last user message carries a tool_result with is_error
 *   new-ask     — the last user message carries real typed text (string, or a text block)
 *   mechanical  — the last user message is only tool_result(s), none errored
 *   unknown     — no messages, or the last message isn't a user turn
 */
export function classifyTurn(messages: unknown[]): TurnKind {
  if (!Array.isArray(messages) || messages.length === 0) return 'unknown'
  const last = messages[messages.length - 1] as Message
  if (!last || last.role !== 'user') return 'unknown'

  if (typeof last.content === 'string') {
    return last.content.trim().length > 0 ? 'new-ask' : 'unknown'
  }

  const blocks = blocksOf(last.content)
  if (blocks.length === 0) return 'unknown'

  const hasErrorResult = blocks.some(b => b.type === 'tool_result' && !!b.is_error)
  if (hasErrorResult) return 'error'

  const hasRealText = blocks.some(b => b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0)
  if (hasRealText) return 'new-ask'

  const hasToolResult = blocks.some(b => b.type === 'tool_result')
  if (hasToolResult) return 'mechanical'

  return 'unknown'
}

// ── Verbosity steering ───────────────────────────────────────────────────────

// Cumulative levels. Each string is a fixed literal → byte-stable per level,
// which is what keeps the appended trailing block identical across requests.
const LEVEL_RULES: Record<VerbosityLevel, string[]> = {
  1: [
    'Skip preamble and postamble. Open with the substance, not with "Great" / "Sure" / "Let me".',
  ],
  2: [
    'Skip preamble and postamble. Open with the substance, not with "Great" / "Sure" / "Let me".',
    'Do not restate code, file contents, or tool output already visible in this conversation — reference it by path:line instead of reprinting it.',
    'After a tool call succeeds, do not narrate what it did unless it changes the plan.',
  ],
  3: [
    'Skip preamble and postamble. Open with the substance, not with "Great" / "Sure" / "Let me".',
    'Do not restate code, file contents, or tool output already visible in this conversation — reference it by path:line instead of reprinting it.',
    'After a tool call succeeds, do not narrate what it did unless it changes the plan.',
    'Give conclusions, not step-by-step narration of routine work. Prefer the smallest edit over a full rewrite.',
  ],
  4: [
    'Answer in the minimum number of tokens. Fragments over full sentences. No rationale unless explicitly asked. No restated context.',
  ],
}

/** Byte-stable steering block for a level, wrapped in the sentinel markers. */
export function steeringText(level: VerbosityLevel): string {
  const rules = LEVEL_RULES[level] ?? LEVEL_RULES[2]
  const body = rules.map(r => `- ${r}`).join('\n')
  return `${STEERING_START}\nBe terse. Output tokens are expensive.\n${body}\n${STEERING_END}`
}

function stripSteeringString(s: string): string {
  const re = new RegExp(`\\n*${STEERING_START}[\\s\\S]*?${STEERING_END}`, 'g')
  return s.replace(re, '')
}

/**
 * Append the steering block to the TAIL of the system prompt. Idempotent: any
 * previous steering block is removed first, so re-applying the same level yields
 * a byte-identical result and re-applying a new level replaces (never stacks).
 * Returns true if a steering block is present after the call.
 */
export function applyVerbositySteering(body: Record<string, unknown>, level: VerbosityLevel): boolean {
  const block = steeringText(level)
  const sys = body.system

  if (typeof sys === 'string') {
    body.system = `${stripSteeringString(sys)}\n\n${block}`
    return true
  }

  if (Array.isArray(sys)) {
    const arr = (sys as Block[]).filter(b => !(typeof b.text === 'string' && b.text.includes(STEERING_START)))
    arr.push({ type: 'text', text: block })
    body.system = arr
    return true
  }

  // No system prompt at all (rare): create one carrying only the steering block.
  body.system = block
  return true
}

// ── Effort routing ───────────────────────────────────────────────────────────

const EFFORT_RANK: Record<string, number> = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4 }
const MECHANICAL_EFFORT = 'low'

/**
 * Lower an explicitly-present output lever. Never injects one. Two lever shapes:
 *   - Anthropic legacy: thinking.budget_tokens  → clamp down to `floor`
 *   - Newer: output_config.effort               → lower to MECHANICAL_EFFORT
 * Returns true if it actually lowered something.
 */
export function routeEffort(body: Record<string, unknown>, floor: number): boolean {
  let lowered = false

  const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined
  if (thinking && typeof thinking.budget_tokens === 'number' && thinking.budget_tokens > floor) {
    thinking.budget_tokens = floor
    lowered = true
  }

  const oc = body.output_config as { effort?: string } | undefined
  if (oc && typeof oc.effort === 'string') {
    const cur = EFFORT_RANK[oc.effort.toLowerCase()]
    const target = EFFORT_RANK[MECHANICAL_EFFORT]
    if (cur !== undefined && cur > target) {
      oc.effort = MECHANICAL_EFFORT
      lowered = true
    }
  }

  return lowered
}

// ── Orchestration ────────────────────────────────────────────────────────────

export function shapeRequest(body: Record<string, unknown>, settings: OutputShaperSettings): ShapeResult {
  if (!settings.enabled) return { steered: false, effortLowered: false, turn: 'unknown' }

  const turn = classifyTurn((body.messages as unknown[]) ?? [])

  const steered = settings.verbositySteering ? applyVerbositySteering(body, settings.level) : false
  const effortLowered =
    settings.effortRouting && turn === 'mechanical' ? routeEffort(body, settings.mechanicalThinkingFloor) : false

  return { steered, effortLowered, turn }
}
