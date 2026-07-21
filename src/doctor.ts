/**
 * squeezr doctor — reconciles the state nothing else reconciles, because Squeezr's
 * failure mode is SILENT: if the proxy dies, the env var drifts, or the running code is
 * stale, you keep working — you just quietly stop saving tokens (or worse, route direct).
 *
 * Squeezr's take on headroom's `headroom doctor`. Each check is pass / warn / fail / skip;
 * the process exit code is 0 (all good), 1 (warnings), or 2 (a failure) so it composes in
 * scripts. The check LOGIC is pure and unit-tested; runDoctor() wires the real IO.
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import http from 'node:http'

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'
export interface CheckResult {
  name: string
  status: CheckStatus
  detail: string
}

type Health = {
  identity?: string
  version?: string
  bypassed?: boolean
  port?: number
  compression?: { requests?: number; savings_pct?: number }
} | null

// ── Pure check logic ─────────────────────────────────────────────────────────

export function checkProxy(health: Health): CheckResult {
  if (health && health.identity === 'squeezr') {
    return { name: 'Proxy', status: 'pass', detail: `running v${health.version ?? '?'}${health.port ? ` on :${health.port}` : ''}` }
  }
  return { name: 'Proxy', status: 'fail', detail: 'not reachable — start it with "squeezr start"' }
}

export function checkVersion(installed: string, running: string | null): CheckResult {
  if (!running) return { name: 'Version', status: 'skip', detail: 'proxy not running' }
  if (installed === running) return { name: 'Version', status: 'pass', detail: `installed and running both v${installed}` }
  return { name: 'Version', status: 'warn', detail: `running proxy is STALE (v${running}) vs installed v${installed} — restart: "squeezr update" or "squeezr start"` }
}

export function checkEnv(baseUrl: string | undefined, port: number): CheckResult {
  if (!baseUrl) {
    return { name: 'Routing', status: 'warn', detail: 'ANTHROPIC_BASE_URL is unset — traffic is NOT going through Squeezr (open a new terminal after setup)' }
  }
  const loopback = new RegExp(`^https?://(localhost|127\\.0\\.0\\.1):${port}(/|$)`)
  if (loopback.test(baseUrl)) {
    return { name: 'Routing', status: 'pass', detail: `ANTHROPIC_BASE_URL → ${baseUrl}` }
  }
  return { name: 'Routing', status: 'fail', detail: `ANTHROPIC_BASE_URL points elsewhere (${baseUrl}); expected http://localhost:${port}` }
}

export function checkBypass(bypassed: boolean | undefined): CheckResult {
  if (bypassed === undefined) return { name: 'Bypass', status: 'skip', detail: 'proxy not running' }
  if (bypassed) return { name: 'Bypass', status: 'warn', detail: 'bypass is ON — compression is disabled (squeezr bypass --off to resume)' }
  return { name: 'Bypass', status: 'pass', detail: 'compression active' }
}

export function checkSavings(requests: number | undefined, savingsPct: number | undefined): CheckResult {
  if (requests === undefined) return { name: 'Savings', status: 'skip', detail: 'proxy not running' }
  if (requests === 0) return { name: 'Savings', status: 'skip', detail: 'no traffic yet' }
  if (!savingsPct || savingsPct <= 0) {
    return { name: 'Savings', status: 'warn', detail: `${requests} requests seen but ~0% saved — bypass on? stale build? all content incompressible?` }
  }
  return { name: 'Savings', status: 'pass', detail: `~${Math.round(savingsPct)}% saved over ${requests} requests` }
}

export function computeExitCode(checks: CheckResult[]): number {
  if (checks.some(c => c.status === 'fail')) return 2
  if (checks.some(c => c.status === 'warn')) return 1
  return 0
}

const ICON: Record<CheckStatus, string> = { pass: '[ok]', warn: '[warn]', fail: '[FAIL]', skip: '[skip]' }

export function formatDoctor(checks: CheckResult[], exitCode: number): string {
  const lines = ['Squeezr doctor', '']
  for (const c of checks) lines.push(`  ${ICON[c.status].padEnd(7)} ${c.name.padEnd(9)} ${c.detail}`)
  lines.push('')
  lines.push(exitCode === 0 ? 'All good.' : exitCode === 1 ? 'Warnings — Squeezr works but may not be saving optimally.' : 'Failure — Squeezr is not in the request path. Fix the [FAIL] above.')
  return lines.join('\n')
}

// ── IO orchestrator ──────────────────────────────────────────────────────────

function installedVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    return require(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')).version as string
  } catch { return '?' }
}

function probeHealth(port: number, timeoutMs = 1500): Promise<Health> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/squeezr/health' }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          resolve(json && json.identity === 'squeezr' ? json : null)
        } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
  })
}

export async function runDoctor(): Promise<{ checks: CheckResult[]; exitCode: number; report: string }> {
  const port = process.env.SQUEEZR_PORT ? parseInt(process.env.SQUEEZR_PORT) : 8080
  const health = await probeHealth(port)
  const runningVersion = health?.version ?? null

  const checks: CheckResult[] = [
    checkProxy(health),
    checkVersion(installedVersion(), runningVersion),
    checkEnv(process.env.ANTHROPIC_BASE_URL, health?.port ?? port),
    checkBypass(health?.bypassed),
    checkSavings(health?.compression?.requests, health?.compression?.savings_pct),
  ]
  const exitCode = computeExitCode(checks)
  return { checks, exitCode, report: formatDoctor(checks, exitCode) }
}
