import { describe, it, expect } from 'vitest'
import {
  checkProxy,
  checkVersion,
  checkEnv,
  checkBypass,
  computeExitCode,
  formatDoctor,
} from '../doctor.js'

describe('checkProxy', () => {
  it('passes when health is present', () => {
    expect(checkProxy({ identity: 'squeezr', version: '1.89.0' }).status).toBe('pass')
  })
  it('fails when the proxy is unreachable', () => {
    expect(checkProxy(null).status).toBe('fail')
  })
})

describe('checkVersion', () => {
  it('passes when installed matches running', () => {
    expect(checkVersion('1.89.0', '1.89.0').status).toBe('pass')
  })
  it('warns on a stale running proxy', () => {
    const r = checkVersion('1.89.0', '1.88.0')
    expect(r.status).toBe('warn')
    expect(r.detail.includes('1.88.0')).toBe(true)
  })
  it('skips when the running version is unknown (proxy down)', () => {
    expect(checkVersion('1.89.0', null).status).toBe('skip')
  })
})

describe('checkEnv', () => {
  it('passes when ANTHROPIC_BASE_URL points at the local proxy', () => {
    expect(checkEnv('http://localhost:8080', 8080).status).toBe('pass')
    expect(checkEnv('http://127.0.0.1:8080', 8080).status).toBe('pass')
  })
  it('warns when unset (traffic not routed through squeezr)', () => {
    expect(checkEnv(undefined, 8080).status).toBe('warn')
    expect(checkEnv('', 8080).status).toBe('warn')
  })
  it('fails when it points somewhere else', () => {
    expect(checkEnv('https://api.anthropic.com', 8080).status).toBe('fail')
    expect(checkEnv('http://localhost:9999', 8080).status).toBe('fail')
  })
})

describe('checkBypass', () => {
  it('warns when bypass is on (compression disabled)', () => {
    expect(checkBypass(true).status).toBe('warn')
  })
  it('passes when bypass is off', () => {
    expect(checkBypass(false).status).toBe('pass')
  })
  it('skips when unknown', () => {
    expect(checkBypass(undefined).status).toBe('skip')
  })
})

describe('computeExitCode', () => {
  it('0 when all pass/skip', () => {
    expect(computeExitCode([{ name: 'a', status: 'pass', detail: '' }, { name: 'b', status: 'skip', detail: '' }])).toBe(0)
  })
  it('1 when there is a warning but no failure', () => {
    expect(computeExitCode([{ name: 'a', status: 'pass', detail: '' }, { name: 'b', status: 'warn', detail: '' }])).toBe(1)
  })
  it('2 when there is any failure', () => {
    expect(computeExitCode([{ name: 'a', status: 'warn', detail: '' }, { name: 'b', status: 'fail', detail: '' }])).toBe(2)
  })
})

describe('formatDoctor', () => {
  it('renders every check line and a summary', () => {
    const out = formatDoctor([
      { name: 'Proxy', status: 'pass', detail: 'running v1.89.0' },
      { name: 'Env', status: 'warn', detail: 'not set' },
    ], 1)
    expect(out.includes('Proxy')).toBe(true)
    expect(out.includes('Env')).toBe(true)
    expect(out.toLowerCase().includes('warn')).toBe(true)
  })
})
