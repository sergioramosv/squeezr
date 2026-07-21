import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { setUserConfigValue, setUserConfigValues } from '../tomlWriter.js'

// P3 (pillar A): the structured writer must target the correct namespace and,
// critically, must NOT resurrect the v1 [compression] table on a migrated (v2)
// file — that was the silent un-migration risk of the old regex writers.
describe('structured toml writer', () => {
  const withTmp = (fn: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'squeezr-writer-'))
    try { fn(join(dir, 'squeezr.toml')) } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('creates the file and table when missing', () => {
    withTmp((path) => {
      setUserConfigValues('proxy', { port: 9100, mitm_port: 9101 }, path)
      const doc = parse(readFileSync(path, 'utf-8')) as any
      expect(doc.proxy.port).toBe(9100)
      expect(doc.proxy.mitm_port).toBe(9101)
    })
  })

  it('updates a key without clobbering other tables', () => {
    withTmp((path) => {
      writeFileSync(path, 'schema_version = 2\n\n[input]\nthreshold = 800\n\n[ai]\nbackend = "local"\n')
      setUserConfigValue('ai', 'backend', 'haiku', path)
      const doc = parse(readFileSync(path, 'utf-8')) as any
      expect(doc.ai.backend).toBe('haiku')
      expect(doc.input.threshold).toBe(800)      // untouched
      expect(doc.schema_version).toBe(2)          // preserved
    })
  })

  it('writes backend into [ai], never resurrecting [compression]', () => {
    withTmp((path) => {
      writeFileSync(path, 'schema_version = 2\n\n[ai]\nbackend = "local"\n')
      setUserConfigValue('ai', 'backend', 'gpt-mini', path)
      const text = readFileSync(path, 'utf-8')
      expect(text).not.toContain('[compression]')
      expect((parse(text) as any).ai.backend).toBe('gpt-mini')
    })
  })

  it('round-trips: write → read → write preserves prior keys', () => {
    withTmp((path) => {
      setUserConfigValues('proxy', { port: 9100, mitm_port: 9101 }, path)
      setUserConfigValue('ai', 'backend', 'haiku', path)
      const doc = parse(readFileSync(path, 'utf-8')) as any
      expect(doc.proxy.port).toBe(9100)
      expect(doc.proxy.mitm_port).toBe(9101)
      expect(doc.ai.backend).toBe('haiku')
    })
  })
})
