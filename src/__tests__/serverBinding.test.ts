import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Security regression: the main proxy holds the user's API keys and exposes
// state-changing control endpoints, so it MUST bind to loopback only and never
// be reachable from the LAN. This guards against silently reverting that fix.
describe('main proxy loopback binding', () => {
  const src = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf-8')

  it('binds httpServer.listen to 127.0.0.1', () => {
    expect(src).toMatch(/httpServer\.listen\(\s*PORT\s*,\s*['"]127\.0\.0\.1['"]/)
  })

  it('never binds the main proxy to all interfaces', () => {
    expect(src).not.toMatch(/httpServer\.listen\(\s*PORT\s*,\s*['"]0\.0\.0\.0['"]/)
    expect(src).not.toMatch(/httpServer\.listen\(\s*PORT\s*,\s*['"]::['"]/)
    // A two-arg listen(PORT, cb) would bind all interfaces by default — forbid it.
    expect(src).not.toMatch(/httpServer\.listen\(\s*PORT\s*,\s*\(/)
  })
})
