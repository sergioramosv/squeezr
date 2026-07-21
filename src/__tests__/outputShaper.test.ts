import { describe, it, expect } from 'vitest'
import {
  classifyTurn,
  steeringText,
  applyVerbositySteering,
  routeEffort,
  shapeRequest,
  STEERING_START,
  STEERING_END,
  type OutputShaperSettings,
} from '../outputShaper.js'

// ── Helpers ────────────────────────────────────────────────────────────────

type Block = { type: string; text?: string; [k: string]: unknown }

const DEFAULTS: OutputShaperSettings = {
  enabled: true,
  verbositySteering: true,
  level: 2,
  effortRouting: true,
  mechanicalThinkingFloor: 1024,
}

function userText(t: string) {
  return { role: 'user', content: [{ type: 'text', text: t }] }
}
function toolResult(id: string, content = 'ok', isError = false) {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
  }
}
function assistantToolUse(id: string) {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] }
}

// ── classifyTurn ─────────────────────────────────────────────────────────────

describe('classifyTurn', () => {
  it('a clean tool_result as the last message → mechanical', () => {
    const msgs = [userText('do a thing'), assistantToolUse('t1'), toolResult('t1', 'file contents')]
    expect(classifyTurn(msgs)).toBe('mechanical')
  })

  it('a tool_result with is_error → error', () => {
    const msgs = [userText('do a thing'), assistantToolUse('t1'), toolResult('t1', 'boom', true)]
    expect(classifyTurn(msgs)).toBe('error')
  })

  it('a fresh user text message → new-ask', () => {
    const msgs = [userText('first'), assistantToolUse('t1'), toolResult('t1'), userText('now do this')]
    expect(classifyTurn(msgs)).toBe('new-ask')
  })

  it('string user content → new-ask', () => {
    const msgs = [{ role: 'user', content: 'hello there' }]
    expect(classifyTurn(msgs)).toBe('new-ask')
  })

  it('tool_result string content field on error flag detected → error', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'err', is_error: true }] },
    ]
    expect(classifyTurn(msgs)).toBe('error')
  })

  it('empty messages → unknown', () => {
    expect(classifyTurn([])).toBe('unknown')
  })

  it('last message is assistant → unknown', () => {
    const msgs = [userText('hi'), assistantToolUse('t1')]
    expect(classifyTurn(msgs)).toBe('unknown')
  })
})

// ── steeringText ─────────────────────────────────────────────────────────────

describe('steeringText', () => {
  it('is byte-stable for the same level', () => {
    expect(steeringText(2)).toBe(steeringText(2))
  })

  it('higher levels are more aggressive (longer or different)', () => {
    expect(steeringText(1)).not.toBe(steeringText(4))
  })

  it('is wrapped in the sentinel markers', () => {
    const t = steeringText(2)
    expect(t.startsWith(STEERING_START)).toBe(true)
    expect(t.trimEnd().endsWith(STEERING_END)).toBe(true)
  })
})

// ── applyVerbositySteering ───────────────────────────────────────────────────

describe('applyVerbositySteering', () => {
  it('appends a text block to an array system prompt', () => {
    const body: Record<string, unknown> = {
      system: [{ type: 'text', text: 'You are Claude.', cache_control: { type: 'ephemeral' } }],
    }
    const changed = applyVerbositySteering(body, 2)
    expect(changed).toBe(true)
    const sys = body.system as Block[]
    expect(sys.length).toBe(2)
    expect(sys[1].text!.includes(STEERING_START)).toBe(true)
  })

  it('never mutates the existing cache_control block', () => {
    const body: Record<string, unknown> = {
      system: [{ type: 'text', text: 'You are Claude.', cache_control: { type: 'ephemeral' } }],
    }
    applyVerbositySteering(body, 2)
    const sys = body.system as Block[]
    expect(sys[0].text).toBe('You are Claude.')
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('appends to a string system prompt', () => {
    const body: Record<string, unknown> = { system: 'You are Claude.' }
    applyVerbositySteering(body, 2)
    expect((body.system as string).startsWith('You are Claude.')).toBe(true)
    expect((body.system as string).includes(STEERING_START)).toBe(true)
  })

  it('is idempotent — applying twice yields byte-identical system (cache-safe)', () => {
    const body: Record<string, unknown> = {
      system: [{ type: 'text', text: 'You are Claude.', cache_control: { type: 'ephemeral' } }],
    }
    applyVerbositySteering(body, 2)
    const afterFirst = JSON.stringify(body.system)
    applyVerbositySteering(body, 2)
    const afterSecond = JSON.stringify(body.system)
    expect(afterSecond).toBe(afterFirst)
  })

  it('re-steering at a new level replaces the old block (no stacking)', () => {
    const body: Record<string, unknown> = {
      system: [{ type: 'text', text: 'You are Claude.' }],
    }
    applyVerbositySteering(body, 2)
    applyVerbositySteering(body, 4)
    const sys = body.system as Block[]
    const steeringBlocks = sys.filter(b => (b.text ?? '').includes(STEERING_START))
    expect(steeringBlocks.length).toBe(1)
    expect(steeringBlocks[0].text).toBe(steeringText(4))
  })
})

// ── routeEffort ──────────────────────────────────────────────────────────────

describe('routeEffort', () => {
  it('lowers an existing thinking.budget_tokens to the floor', () => {
    const body: Record<string, unknown> = { thinking: { type: 'enabled', budget_tokens: 16000 } }
    const lowered = routeEffort(body, 1024)
    expect(lowered).toBe(true)
    expect((body.thinking as { budget_tokens: number }).budget_tokens).toBe(1024)
  })

  it('never toggles thinking.type', () => {
    const body: Record<string, unknown> = { thinking: { type: 'enabled', budget_tokens: 16000 } }
    routeEffort(body, 1024)
    expect((body.thinking as { type: string }).type).toBe('enabled')
  })

  it('does not raise a budget already below the floor', () => {
    const body: Record<string, unknown> = { thinking: { type: 'enabled', budget_tokens: 512 } }
    const lowered = routeEffort(body, 1024)
    expect(lowered).toBe(false)
    expect((body.thinking as { budget_tokens: number }).budget_tokens).toBe(512)
  })

  it('lowers an explicit output_config.effort but never injects one', () => {
    const withEffort: Record<string, unknown> = { output_config: { effort: 'xhigh' } }
    expect(routeEffort(withEffort, 1024)).toBe(true)
    expect((withEffort.output_config as { effort: string }).effort).toBe('low')

    const withoutEffort: Record<string, unknown> = {}
    expect(routeEffort(withoutEffort, 1024)).toBe(false)
    expect(withoutEffort.output_config).toBeUndefined()
  })

  it('does nothing when no effort levers are present', () => {
    const body: Record<string, unknown> = {}
    expect(routeEffort(body, 1024)).toBe(false)
    expect(body.thinking).toBeUndefined()
  })
})

// ── shapeRequest (orchestration) ─────────────────────────────────────────────

describe('shapeRequest', () => {
  it('no-op when disabled — body untouched', () => {
    const body: Record<string, unknown> = {
      system: [{ type: 'text', text: 'You are Claude.' }],
      thinking: { type: 'enabled', budget_tokens: 16000 },
      messages: [toolResult('t1')],
    }
    const before = JSON.stringify(body)
    const r = shapeRequest(body, { ...DEFAULTS, enabled: false })
    expect(r.steered).toBe(false)
    expect(r.effortLowered).toBe(false)
    expect(JSON.stringify(body)).toBe(before)
  })

  it('mechanical turn: both steers and lowers effort', () => {
    const body: Record<string, unknown> = {
      system: [{ type: 'text', text: 'You are Claude.' }],
      thinking: { type: 'enabled', budget_tokens: 16000 },
      messages: [userText('go'), assistantToolUse('t1'), toolResult('t1', 'contents')],
    }
    const r = shapeRequest(body, DEFAULTS)
    expect(r.turn).toBe('mechanical')
    expect(r.steered).toBe(true)
    expect(r.effortLowered).toBe(true)
    expect((body.thinking as { budget_tokens: number }).budget_tokens).toBe(1024)
  })

  it('new-ask turn: steers but keeps full effort', () => {
    const body: Record<string, unknown> = {
      system: [{ type: 'text', text: 'You are Claude.' }],
      thinking: { type: 'enabled', budget_tokens: 16000 },
      messages: [toolResult('t1'), userText('new question')],
    }
    const r = shapeRequest(body, DEFAULTS)
    expect(r.turn).toBe('new-ask')
    expect(r.steered).toBe(true)
    expect(r.effortLowered).toBe(false)
    expect((body.thinking as { budget_tokens: number }).budget_tokens).toBe(16000)
  })

  it('error turn: keeps full effort', () => {
    const body: Record<string, unknown> = {
      system: [{ type: 'text', text: 'You are Claude.' }],
      thinking: { type: 'enabled', budget_tokens: 16000 },
      messages: [assistantToolUse('t1'), toolResult('t1', 'boom', true)],
    }
    const r = shapeRequest(body, DEFAULTS)
    expect(r.turn).toBe('error')
    expect(r.effortLowered).toBe(false)
  })

  it('effort routing disabled: never lowers even on mechanical turns', () => {
    const body: Record<string, unknown> = {
      thinking: { type: 'enabled', budget_tokens: 16000 },
      messages: [toolResult('t1')],
    }
    const r = shapeRequest(body, { ...DEFAULTS, effortRouting: false })
    expect(r.effortLowered).toBe(false)
    expect((body.thinking as { budget_tokens: number }).budget_tokens).toBe(16000)
  })

  it('verbosity steering disabled: never touches the system prompt', () => {
    const body: Record<string, unknown> = {
      system: [{ type: 'text', text: 'You are Claude.' }],
      messages: [toolResult('t1')],
    }
    const r = shapeRequest(body, { ...DEFAULTS, verbositySteering: false })
    expect(r.steered).toBe(false)
    expect((body.system as Block[]).length).toBe(1)
  })
})
