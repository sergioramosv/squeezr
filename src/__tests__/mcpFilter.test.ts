import { describe, it, expect } from 'vitest'
import { filterMcpTools, mcpServerOf } from '../mcpFilter.js'

function tool(name: string, descLen = 100) {
  return { name, description: 'd'.repeat(descLen), input_schema: { type: 'object' } }
}

const TOOLS = [
  tool('Bash'),
  tool('Read'),
  tool('mcp__planning-task-mcp__create_task'),
  tool('mcp__planning-task-mcp__list_tasks'),
  tool('mcp__github-mcp__create_pr'),
  tool('mcp__memory-mcp__get_stats'),
]

const NO_MSGS: never[] = []

describe('mcpServerOf', () => {
  it('extracts server from mcp tool name', () => {
    expect(mcpServerOf('mcp__github-mcp__create_pr')).toBe('github-mcp')
  })
  it('returns null for built-ins', () => {
    expect(mcpServerOf('Bash')).toBe(null)
  })
  it('handles server-only names', () => {
    expect(mcpServerOf('mcp__solo')).toBe('solo')
  })
})

describe('filterMcpTools', () => {
  it('no-op when both lists empty', () => {
    const { tools, result } = filterMcpTools(TOOLS, NO_MSGS, new Set(), new Set())
    expect(tools.length).toBe(6)
    expect(result.removedTools).toBe(0)
  })

  it('blocks listed servers', () => {
    const { tools, result } = filterMcpTools(TOOLS, NO_MSGS, new Set(['planning-task-mcp']), new Set())
    expect(tools.length).toBe(4)
    expect(result.removedTools).toBe(2)
    expect(result.removedServers).toEqual(['planning-task-mcp'])
    expect(result.savedChars).toBeGreaterThan(0)
  })

  it('allow list keeps only listed servers (built-ins always kept)', () => {
    const { tools, result } = filterMcpTools(TOOLS, NO_MSGS, new Set(), new Set(['github-mcp']))
    const names = tools.map(t => (t as { name: string }).name)
    expect(names).toContain('Bash')
    expect(names).toContain('Read')
    expect(names).toContain('mcp__github-mcp__create_pr')
    expect(names).not.toContain('mcp__planning-task-mcp__create_task')
    expect(names).not.toContain('mcp__memory-mcp__get_stats')
    expect(result.removedTools).toBe(3)
  })

  it('allow list takes precedence over block list', () => {
    const { tools } = filterMcpTools(TOOLS, NO_MSGS, new Set(['github-mcp']), new Set(['github-mcp']))
    const names = tools.map(t => (t as { name: string }).name)
    // allow wins: github-mcp survives even though blocked
    expect(names).toContain('mcp__github-mcp__create_pr')
  })

  it('NEVER filters built-in tools', () => {
    const { tools } = filterMcpTools(TOOLS, NO_MSGS, new Set(['planning-task-mcp', 'github-mcp', 'memory-mcp']), new Set())
    const names = tools.map(t => (t as { name: string }).name)
    expect(names).toContain('Bash')
    expect(names).toContain('Read')
  })

  it('NEVER filters a server used in the conversation', () => {
    const msgs = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'mcp__planning-task-mcp__create_task', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]
    const { tools, result } = filterMcpTools(TOOLS, msgs as never, new Set(['planning-task-mcp']), new Set())
    const names = tools.map(t => (t as { name: string }).name)
    // Used server is protected
    expect(names).toContain('mcp__planning-task-mcp__create_task')
    expect(names).toContain('mcp__planning-task-mcp__list_tasks')
    expect(result.keptUsedServers).toEqual(['planning-task-mcp'])
    expect(result.removedTools).toBe(0)
  })

  it('handles empty tools array', () => {
    const { tools, result } = filterMcpTools([], NO_MSGS, new Set(['x']), new Set())
    expect(tools.length).toBe(0)
    expect(result.removedTools).toBe(0)
  })

  it('handles malformed tool entries gracefully', () => {
    const badTools = [null, undefined, 'str', 42, tool('mcp__bad-server__x')]
    const { tools } = filterMcpTools(badTools as unknown[], NO_MSGS, new Set(['bad-server']), new Set())
    expect(tools.length).toBe(4)  // bad entries kept, mcp tool removed
  })
})
