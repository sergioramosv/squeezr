import { describe, it, expect } from 'vitest'
import { app } from '../server.js'

// Security regression: control endpoints (/squeezr/*) must not be usable from a
// cross-origin browser context. A malicious page open in the user's browser must
// not be able to change state or read control responses on http://localhost:<port>.
// We hit *non-existent* control paths so the guard runs but no real handler fires
// (403 = guard blocked; 404 = guard allowed and routing missed) — no side effects.
describe('control-endpoint CSRF/CORS guard', () => {
  it('rejects a cross-origin mutation to a control endpoint with 403', async () => {
    const res = await app.request('/squeezr/__guard_probe__', {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('rejects a file:// (null) origin mutation to a control endpoint', async () => {
    const res = await app.request('/squeezr/__guard_probe__', {
      method: 'POST',
      headers: { origin: 'null' },
    })
    expect(res.status).toBe(403)
  })

  it('allows a mutation with no Origin (curl / MCP / native over loopback)', async () => {
    const res = await app.request('/squeezr/__guard_probe__', { method: 'POST' })
    expect(res.status).toBe(404) // guard passed; route simply does not exist
  })

  it('allows a mutation from a loopback browser origin', async () => {
    const res = await app.request('/squeezr/__guard_probe__', {
      method: 'POST',
      headers: { origin: 'http://localhost:8899' },
    })
    expect(res.status).toBe(404) // guard passed; route simply does not exist
  })

  it('does not guard the proxy endpoints (Cursor needs cross-origin)', async () => {
    const res = await app.request('/v1/__proxy_probe__', {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
    })
    expect(res.status).not.toBe(403)
  })

  it('never reflects a wildcard ACAO on control endpoints', async () => {
    const res = await app.request('/squeezr/health', {
      headers: { origin: 'http://evil.example' },
    })
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  it('reflects the loopback origin (not wildcard) on control endpoints', async () => {
    const res = await app.request('/squeezr/health', {
      headers: { origin: 'http://127.0.0.1:1234' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:1234')
    expect(res.headers.get('vary')).toBe('Origin')
  })

  it('keeps wildcard ACAO on proxy endpoints for browser tooling', async () => {
    const res = await app.request('/v1/__proxy_probe__', {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})
