import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Config } from '../config.js'

// Security regression: the main proxy holds the user's API keys and exposes
// state-changing control endpoints, so it MUST default to loopback only and
// never silently bind to all interfaces. The bind host is configurable
// (config.host / SQUEEZR_HOST / `squeezr ip`), but the DEFAULT — with no toml
// or env override — must stay 127.0.0.1. This guards against silently
// reverting that default, or hardcoding a bare literal that bypasses config.host.
describe('main proxy loopback binding', () => {
  const src = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf-8')

  it('binds httpServer.listen to config.host, not a hardcoded literal', () => {
    expect(src).toMatch(/httpServer\.listen\(\s*PORT\s*,\s*config\.host\s*,/)
  })

  it('never hardcodes a bind to all interfaces', () => {
    expect(src).not.toMatch(/httpServer\.listen\(\s*PORT\s*,\s*['"]0\.0\.0\.0['"]/)
    expect(src).not.toMatch(/httpServer\.listen\(\s*PORT\s*,\s*['"]::['"]/)
    // A two-arg listen(PORT, cb) would bind all interfaces by default — forbid it.
    expect(src).not.toMatch(/httpServer\.listen\(\s*PORT\s*,\s*\(/)
  })

  it('Config.host defaults to loopback-only (127.0.0.1) with no override', () => {
    const config = new Config({})
    expect(config.host).toBe('127.0.0.1')
  })
})
