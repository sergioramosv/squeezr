import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import {
  migrateTomlV1toV2, renderV2Toml, migrationPreservesConfig, migrateUserConfigFile,
  CURRENT_SCHEMA_VERSION, type MigrationResult,
} from '../schemaMigration.js'
import { Config, type TomlConfig } from '../config.js'

const V1_SAMPLE: TomlConfig = {
  proxy: { port: 9000 },
  compression: {
    threshold: 1234,
    tool_desc_compress: true,
    stale_turns: false,
    skip_tools: ['Read', 'Bash'],
    ai_compression: true,
    backend: 'haiku',
    assistant_ai_min_chars: 3000,
    disabled: true,
    mcp_block_servers: ['foo'],
  },
  cache: { max_entries: 500 },
}

describe('schema migration v1 → v2', () => {
  it('routes each v1 key into its correct v2 namespace', () => {
    const v2 = migrateTomlV1toV2(V1_SAMPLE)
    expect(v2.schema_version).toBe(CURRENT_SCHEMA_VERSION)
    expect(v2.compression).toBeUndefined()
    // input bucket
    expect(v2.input?.threshold).toBe(1234)
    expect(v2.input?.tool_desc_compress).toBe(true)
    expect(v2.input?.stale_turns).toBe(false)
    expect(v2.input?.skip_tools).toEqual(['Read', 'Bash'])
    expect(v2.input?.mcp_block_servers).toEqual(['foo'])
    // ai bucket
    expect(v2.ai?.ai_compression).toBe(true)
    expect(v2.ai?.backend).toBe('haiku')
    expect(v2.ai?.assistant_ai_min_chars).toBe(3000)
    // safety bucket
    expect(v2.safety?.disabled).toBe(true)
    // untouched tables pass through
    expect(v2.proxy?.port).toBe(9000)
    expect(v2.cache?.max_entries).toBe(500)
  })

  it('is 1:1 lossless: migrated config yields an identical effective Config', () => {
    const v2 = migrateTomlV1toV2(V1_SAMPLE)
    expect(migrationPreservesConfig(V1_SAMPLE, v2)).toBe(true)
    // spot-check a few resolved values match across schemas
    const a = new Config(V1_SAMPLE)
    const b = new Config(v2)
    expect(b.threshold).toBe(a.threshold)
    expect(b.aiCompression).toBe(a.aiCompression)
    expect(b.compressionBackend).toBe(a.compressionBackend)
    expect([...b.skipTools].sort()).toEqual([...a.skipTools].sort())
  })

  it('renders a v2 toml that round-trips to the same effective config', () => {
    const v2 = migrateTomlV1toV2(V1_SAMPLE)
    const text = renderV2Toml(v2)
    expect(text).toContain('schema_version = 2')
    expect(text).toContain('[input]')
    expect(text).toContain('[ai]')
    const reparsed = parse(text) as TomlConfig
    expect(migrationPreservesConfig(V1_SAMPLE, reparsed)).toBe(true)
  })

  it('migrates a user file in place, backing up the original', () => {
    const dir = mkdtempSync(join(tmpdir(), 'squeezr-mig-'))
    const path = join(dir, 'squeezr.toml')
    writeFileSync(path, '[compression]\nthreshold = 1234\ntool_desc_compress = true\nbackend = "haiku"\n')
    try {
      const res = migrateUserConfigFile(path)
      expect(res.migrated).toBe(true)
      expect(existsSync(`${path}.v1.bak`)).toBe(true)
      const migrated = parse(readFileSync(path, 'utf-8')) as TomlConfig
      expect(migrated.schema_version).toBe(2)
      expect(migrated.input?.threshold).toBe(1234)
      expect(migrated.ai?.backend).toBe('haiku')
      // backup still holds the v1 original
      expect(readFileSync(`${path}.v1.bak`, 'utf-8')).toContain('[compression]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is idempotent: a schema_version >= 2 file is left untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'squeezr-mig-'))
    const path = join(dir, 'squeezr.toml')
    const v2text = 'schema_version = 2\n\n[input]\nthreshold = 800\n'
    writeFileSync(path, v2text)
    try {
      const res = migrateUserConfigFile(path)
      expect(res.migrated).toBe(false)
      expect(res.reason).toBe('already-v2')
      expect(readFileSync(path, 'utf-8')).toBe(v2text)
      expect(existsSync(`${path}.v1.bak`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports no-file when the path does not exist', () => {
    const res: MigrationResult = migrateUserConfigFile(join(tmpdir(), 'does-not-exist-squeezr.toml'))
    expect(res).toEqual({ migrated: false, reason: 'no-file' })
  })

  it('preserves an already-partially-migrated file (merges v2 namespaces)', () => {
    const partial: TomlConfig = { input: { threshold: 700 }, compression: { backend: 'gpt-mini' } }
    const v2 = migrateTomlV1toV2(partial)
    expect(v2.input?.threshold).toBe(700)
    expect(v2.ai?.backend).toBe('gpt-mini')
    expect(migrationPreservesConfig(partial, v2)).toBe(true)
  })
})
