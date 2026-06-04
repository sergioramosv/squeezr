/**
 * MCP tool filtering per-server (v1.57.0)
 *
 * Removes tool definitions belonging to MCP servers the user has explicitly
 * blocked (or not explicitly allowed) from the tools[] array before forwarding.
 *
 * Capture data (req-0002.json): planning-task-mcp alone = 87 tools · ~18,500
 * tokens per request — sent even when the session never touches it.
 *
 * Config (both default empty = no filtering):
 *   mcp_block_servers = ["planning-task-mcp"]   # drop these servers' tools
 *   mcp_allow_servers = ["github-mcp"]          # if set, ONLY these survive (block ignored)
 *
 * Safety constraints (hard rules):
 *  - ONLY tools named `mcp__<server>__*` are ever filtered. Built-ins untouched.
 *  - If a server's tool was USED in this conversation (a tool_use block in
 *    messages references it), that server is NEVER filtered — the model may
 *    need to call it again, and dangling history confuses providers.
 *  - Default OFF: both lists empty = passthrough.
 */

type ToolDef = { name?: unknown; [k: string]: unknown }
type AMsg = { role: string; content: string | Array<{ type?: string; name?: string }> }

/** Extract the MCP server name from a tool name, or null for built-ins. */
export function mcpServerOf(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null
  const rest = toolName.slice(5)
  const sep = rest.indexOf('__')
  return sep === -1 ? rest : rest.slice(0, sep)
}

/** Collect MCP servers that have been used (tool_use) anywhere in the conversation. */
function usedServers(messages: AMsg[]): Set<string> {
  const used = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block.type !== 'tool_use' || typeof block.name !== 'string') continue
      const server = mcpServerOf(block.name)
      if (server) used.add(server)
    }
  }
  return used
}

export interface McpFilterResult {
  removedTools: number
  savedChars: number
  removedServers: string[]
  keptUsedServers: string[]  // servers protected because the conversation used them
}

/**
 * Filter MCP tools in-place (returns a NEW array — assign it back to body.tools).
 */
export function filterMcpTools(
  tools: unknown[],
  messages: AMsg[],
  blockServers: Set<string>,
  allowServers: Set<string>,
): { tools: unknown[]; result: McpFilterResult } {
  const empty: McpFilterResult = { removedTools: 0, savedChars: 0, removedServers: [], keptUsedServers: [] }
  if (!Array.isArray(tools) || tools.length === 0) return { tools, result: empty }
  if (blockServers.size === 0 && allowServers.size === 0) return { tools, result: empty }

  const used = usedServers(messages)
  const removedServers = new Set<string>()
  const keptUsed = new Set<string>()
  let savedChars = 0

  const kept = tools.filter((tool) => {
    if (!tool || typeof tool !== 'object') return true
    const name = String((tool as ToolDef).name ?? '')
    const server = mcpServerOf(name)
    if (!server) return true  // built-in — never filtered

    // Decide if this server should be dropped per config
    const dropByConfig = allowServers.size > 0
      ? !allowServers.has(server)
      : blockServers.has(server)
    if (!dropByConfig) return true

    // Protection: server was used in this conversation — keep it
    if (used.has(server)) {
      keptUsed.add(server)
      return true
    }

    removedServers.add(server)
    savedChars += JSON.stringify(tool).length
    return false
  })

  return {
    tools: kept,
    result: {
      removedTools: tools.length - kept.length,
      savedChars,
      removedServers: [...removedServers],
      keptUsedServers: [...keptUsed],
    },
  }
}
