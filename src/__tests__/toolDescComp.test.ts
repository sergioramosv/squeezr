import { describe, it, expect } from 'vitest'
import { compressToolDescriptions } from '../toolDescComp.js'

const LONG_DESC = 'Execute bash commands in a sandbox environment.\n\nUsage notes:\n- Always quote paths.\n- Never use interactive commands.\n- Timeout is 30 seconds.\n\nCommon patterns:\n  git status\n  npm test\n\nReturns stdout and stderr combined.'
const SHORT_DESC = 'Short description.'

describe('compressToolDescriptions', () => {
  it('no-op when tools array is empty', () => {
    const r = compressToolDescriptions([], 0, false, false, false)
    expect(r.savedChars).toBe(0)
    expect(r.totalTools).toBe(0)
  })

  it('no-op when description is shorter than MIN_DESC_LEN', () => {
    const tools = [{ name: 'Bash', description: SHORT_DESC, input_schema: { type: 'object' } }]
    const r = compressToolDescriptions(tools, 0, false, false, false)
    expect(r.savedChars).toBe(0)
    expect(r.compressedTools).toBe(0)
  })

  it('normalizes whitespace in long descriptions', () => {
    const tools = [{ name: 'Bash', description: LONG_DESC + '\n\n\n\n extra   ', input_schema: {} }]
    const before = (tools[0] as { description: string }).description.length
    const r = compressToolDescriptions(tools, 0, false, false, false)
    const after = (tools[0] as { description: string }).description.length
    expect(after).toBeLessThan(before)
    expect(r.savedChars).toBeGreaterThan(0)
    expect(r.compressedTools).toBe(1)
  })

  it('truncates to maxChars when set', () => {
    const tools = [{ name: 'Read', description: LONG_DESC, input_schema: {} }]
    compressToolDescriptions(tools, 80, false, false, false)
    const desc = (tools[0] as { description: string }).description
    expect(desc.length).toBeLessThanOrEqual(81)
    expect(desc.endsWith('…')).toBe(true)
  })

  it('no truncation when maxChars is 0', () => {
    const tools = [{ name: 'Read', description: LONG_DESC, input_schema: {} }]
    compressToolDescriptions(tools, 0, false, false, false)
    const desc = (tools[0] as { description: string }).description
    expect(desc.endsWith('…')).toBe(false)
    expect(desc.length).toBeGreaterThan(80)
  })

  it('NEVER touches input_schema', () => {
    const schema = { type: 'object', properties: { command: { type: 'string', description: 'A long command description that should not be touched at all ever.' } } }
    const schemaStr = JSON.stringify(schema)
    const tools = [{ name: 'Bash', description: LONG_DESC, input_schema: schema }]
    compressToolDescriptions(tools, 50, false, false, false)
    expect(JSON.stringify((tools[0] as { input_schema: unknown }).input_schema)).toBe(schemaStr)
  })

  it('NEVER touches tool name', () => {
    const tools = [{ name: 'Bash', description: LONG_DESC, input_schema: {} }]
    compressToolDescriptions(tools, 50, false, false, false)
    expect((tools[0] as { name: string }).name).toBe('Bash')
  })

  it('skips non-object entries gracefully', () => {
    const tools = [null, undefined, 'string', 42, { name: 'Bash', description: LONG_DESC }]
    expect(() => compressToolDescriptions(tools as unknown[], 0, false, false, false)).not.toThrow()
  })

  it('skips tools without a description field', () => {
    const tools = [{ name: 'Bash', input_schema: {} }]
    const r = compressToolDescriptions(tools, 0, false, false, false)
    expect(r.savedChars).toBe(0)
  })

  it('does not produce a longer result', () => {
    const tools = [{ name: 'Bash', description: LONG_DESC, input_schema: {} }]
    const before = LONG_DESC.length
    compressToolDescriptions(tools, 0, false, false, false)
    const after = (tools[0] as { description: string }).description.length
    expect(after).toBeLessThanOrEqual(before)
  })

  it('compresses multiple tools independently', () => {
    const tools = [
      { name: 'Bash', description: LONG_DESC + '\n\n\n', input_schema: {} },
      { name: 'Read', description: LONG_DESC + '\n\n\n\n extra  ', input_schema: {} },
      { name: 'Tiny', description: SHORT_DESC, input_schema: {} },
    ]
    const r = compressToolDescriptions(tools, 0, false, false, false)
    expect(r.compressedTools).toBe(2)
    expect(r.totalTools).toBe(3)
    expect(r.savedChars).toBeGreaterThan(0)
  })

  it('handles non-array input gracefully', () => {
    const r = compressToolDescriptions('not an array' as unknown as unknown[], 0, false, false, false)
    expect(r.savedChars).toBe(0)
  })

  it('first-para mode truncates at first blank line', () => {
    // Need desc > 500 chars with a blank line after first para
    const bigDesc = LONG_DESC + '\n\n' + LONG_DESC + '\n\n' + LONG_DESC  // ~700 chars, has blank lines
    const tools = [{ name: 'Bash', description: bigDesc, input_schema: {} }]
    compressToolDescriptions(tools, 0, true, false, false)
    const desc = (tools[0] as { description: string }).description
    expect(desc).toContain('Execute bash commands')
    expect(desc.endsWith('…')).toBe(true)
    expect(desc.length).toBeLessThan(LONG_DESC.length)
  })

  it('first-para mode no-op when description <= MIN_FIRST_PARA_LEN', () => {
    // LONG_DESC is ~230 chars — below the 500-char threshold for first-para
    const tools = [{ name: 'Bash', description: LONG_DESC, input_schema: {} }]
    const before = (tools[0] as { description: string }).description.length
    compressToolDescriptions(tools, 0, true, false, false)
    const after = (tools[0] as { description: string }).description.length
    // Only whitespace normalization applies (no truncation since < 500 chars)
    expect(after).toBeLessThanOrEqual(before)
  })

it('first-para mode works on very long descriptions (>500 chars)', () => {
    const bigDesc = LONG_DESC.repeat(3)  // ~690 chars, above 500 threshold
    const tools = [{ name: 'Workflow', description: bigDesc, input_schema: {} }]
    compressToolDescriptions(tools, 0, true, false, false)
    const desc = (tools[0] as { description: string }).description
    expect(desc.length).toBeLessThan(bigDesc.length)
    expect(desc.endsWith('…')).toBe(true)
  })

  it('safe-only mode skips non-whitelist tools', () => {
    const bigDesc = LONG_DESC.repeat(3)
    const tools = [
      { name: 'Workflow', description: bigDesc, input_schema: {} },   // NOT in whitelist
      { name: 'Bash', description: bigDesc, input_schema: {} },       // IN whitelist
    ]
    compressToolDescriptions(tools, 0, true, true, false)
    const workflow = (tools[0] as { description: string }).description
    const bash = (tools[1] as { description: string }).description
    expect(workflow).toBe(bigDesc)       // untouched
    expect(bash.length).toBeLessThan(bigDesc.length)  // compressed
  })
it('safe-only mode=false compresses all tools', () => {
    const tools = [{ name: 'Workflow', description: LONG_DESC.repeat(3), input_schema: {} }]
    compressToolDescriptions(tools, 0, true, false, false)
    expect((tools[0] as { description: string }).description.length).toBeLessThan(LONG_DESC.repeat(3).length)
  })

  it('expand mode embeds squeezr_expand hint in truncated description', () => {
    const bigDesc = LONG_DESC.repeat(3)
    const tools = [{ name: 'Workflow', description: bigDesc, input_schema: {} }]
    compressToolDescriptions(tools, 0, true, false, true)
    const desc = (tools[0] as { description: string }).description
    expect(desc).toContain("squeezr_expand(")
    expect(desc.length).toBeLessThan(bigDesc.length)
  })

  it('expand mode works on all tools regardless of whitelist', () => {
    const bigDesc = LONG_DESC.repeat(3)
    const tools = [
      { name: 'Workflow', description: bigDesc, input_schema: {} },
      { name: 'mcp__custom__tool', description: bigDesc, input_schema: {} },
    ]
    compressToolDescriptions(tools, 0, true, true, true)  // safeOnly=true but expand=true overrides
    const workflow = (tools[0] as { description: string }).description
    const mcp = (tools[1] as { description: string }).description
    expect(workflow).toContain('squeezr_expand(')
    expect(mcp).toContain('squeezr_expand(')
  })

  it('expand mode: same content same ID (deterministic for prefix cache)', () => {
    const bigDesc = LONG_DESC.repeat(3)
    const tools1 = [{ name: 'Bash', description: bigDesc, input_schema: {} }]
    const tools2 = [{ name: 'Bash', description: bigDesc, input_schema: {} }]
    compressToolDescriptions(tools1, 0, true, false, true)
    compressToolDescriptions(tools2, 0, true, false, true)
    // Same content → same expand ID → stable for Anthropic prefix cache
    expect((tools1[0] as { description: string }).description)
      .toBe((tools2[0] as { description: string }).description)
  })
})
