/**
 * Schema migration v1 (flat [compression]) → v2 (namespaces) — pillar A / P2.
 *
 * The migration is 1:1 lossless: it maps every explicitly-set v1 key into its v2
 * namespace and writes a fresh, comment-organised toml, backing up the original
 * to squeezr.toml.v1.bak. It is gated by `schema_version` (idempotent) and it
 * VALIDATES its own output loudly — if the migrated file does not reproduce the
 * exact effective Config, it restores the backup and throws (no silent revert).
 *
 * NOT wired to boot yet: it must only run once the toml writers (P3) and the
 * bundled template (P4) are on v2, i.e. at the 2.0 release (P5). Until then this
 * is a tested, self-contained function.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { parse } from 'smol-toml'
import { Config, type TomlConfig } from './config.js'

export const CURRENT_SCHEMA_VERSION = 2

// v1 [compression] keys → the v2 namespace they move to.
const AI_KEYS = new Set([
  'ai_compression', 'backend', 'compress_system_prompt', 'compress_assistant_ai',
  'assistant_ai_min_chars', 'ai_skip_tools', 'anthropic_native_compact',
])
const SAFETY_KEYS = new Set(['disabled'])
// everything else in [compression] is input-side (default bucket)

/**
 * Pure: map a parsed v1 config into the v2 shape. Only keys actually present are
 * carried over — unset keys fall through to code defaults post-migration.
 * Tables that are already v2-clean ([proxy]/[cache]/[adaptive]/[local]/[output])
 * pass through untouched.
 */
export function migrateTomlV1toV2(raw: TomlConfig): TomlConfig {
  const out: TomlConfig = { schema_version: CURRENT_SCHEMA_VERSION }
  if (raw.proxy) out.proxy = { ...raw.proxy }
  if (raw.cache) out.cache = { ...raw.cache }
  if (raw.adaptive) out.adaptive = { ...raw.adaptive }
  if (raw.local) out.local = { ...raw.local }
  if (raw.output) out.output = { ...raw.output }

  // Carry over any v2 namespaces already present (a partially-migrated file).
  const input: Record<string, unknown> = { ...(raw.input ?? {}) }
  const ai: Record<string, unknown> = { ...(raw.ai ?? {}) }
  const safety: Record<string, unknown> = { ...(raw.safety ?? {}) }

  const c = (raw.compression ?? {}) as Record<string, unknown>
  for (const [key, value] of Object.entries(c)) {
    if (value === undefined) continue
    if (AI_KEYS.has(key)) ai[key] = value
    else if (SAFETY_KEYS.has(key)) safety[key] = value
    else input[key] = value
  }

  if (Object.keys(input).length > 0) out.input = input as TomlConfig['input']
  if (Object.keys(ai).length > 0) out.ai = ai as TomlConfig['ai']
  if (Object.keys(safety).length > 0) out.safety = safety as TomlConfig['safety']
  return out
}

/** Format a scalar / string-array value as a toml literal. */
function tomlValue(v: unknown): string {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`
  return JSON.stringify(v)
}

/** Emit a `[table]` block for every set key, or nothing if the table is empty. */
function tomlTable(name: string, comment: string, table: Record<string, unknown> | undefined): string {
  if (!table || Object.keys(table).length === 0) return ''
  const lines = [`[${name}]`, ...(comment ? [`# ${comment}`] : [])]
  for (const [k, v] of Object.entries(table)) {
    if (v !== undefined) lines.push(`${k} = ${tomlValue(v)}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Render a fresh v2 toml from a migrated config. The user file carries only their
 * overrides, organised into namespaces with explanatory comments; the full
 * per-option documentation lives in the bundled squeezr.toml (P4).
 */
export function renderV2Toml(cfg: TomlConfig): string {
  const header = [
    '# Squeezr config — migrated to the v2 schema (schema_version 2).',
    '# Only your overrides are kept here; every option is documented in the',
    '# bundled squeezr.toml. Your previous config was backed up to squeezr.toml.v1.bak.',
    `schema_version = ${CURRENT_SCHEMA_VERSION}`,
    '',
  ].join('\n')
  const blocks = [
    tomlTable('proxy', 'Listener ports.', cfg.proxy as Record<string, unknown>),
    tomlTable('input', 'Compresses what ENTERS the model (tool results, tool descriptions, MCP, stale turns).', cfg.input as Record<string, unknown>),
    tomlTable('ai', 'AI backend + everything billable/behavioural behind the master switch.', cfg.ai as Record<string, unknown>),
    tomlTable('output', 'Output-side token reduction.', cfg.output as Record<string, unknown>),
    tomlTable('safety', 'Bypass, circuit-breaker and compression guards.', cfg.safety as Record<string, unknown>),
    tomlTable('cache', 'LRU compression cache (not the prompt-cache barrier).', cfg.cache as Record<string, unknown>),
    tomlTable('adaptive', 'Pressure-adaptive input thresholds.', cfg.adaptive as Record<string, unknown>),
    tomlTable('local', 'Local (Zest/Ollama) backend infra.', cfg.local as Record<string, unknown>),
  ].filter(Boolean)
  return header + '\n' + blocks.join('\n')
}

// Fields Config derives from the migrated toml — used to prove the migration is
// effect-preserving. Sets are compared as sorted arrays.
function configSnapshot(c: Config): Record<string, unknown> {
  const set = (s: Set<string>) => [...s].sort()
  return {
    port: c.port, mitmPort: c.mitmPort, threshold: c.threshold, keepRecent: c.keepRecent,
    disabled: c.disabled, aiCompression: c.aiCompression, compressSystemPrompt: c.compressSystemPrompt,
    compressConversation: c.compressConversation, compressToolInputs: c.compressToolInputs,
    captureRequests: c.captureRequests, captureLimit: c.captureLimit, staleTurns: c.staleTurns,
    staleTurnThreshold: c.staleTurnThreshold, staleTurnKeepRecent: c.staleTurnKeepRecent,
    toolDescCompress: c.toolDescCompress, toolDescFirstPara: c.toolDescFirstPara,
    toolDescSafeOnly: c.toolDescSafeOnly, toolDescExpand: c.toolDescExpand, toolDescMaxChars: c.toolDescMaxChars,
    mcpBlockServers: set(c.mcpBlockServers), mcpAllowServers: set(c.mcpAllowServers),
    keepRecentAssistant: c.keepRecentAssistant, assistantThreshold: c.assistantThreshold,
    compressAssistantAi: c.compressAssistantAi, assistantAiMinChars: c.assistantAiMinChars,
    anthropicNativeCompact: c.anthropicNativeCompact, compressionBackend: c.compressionBackend,
    skipTools: set(c.skipTools), onlyTools: set(c.onlyTools), aiSkipTools: set(c.aiSkipTools),
    cacheEnabled: c.cacheEnabled, cacheMaxEntries: c.cacheMaxEntries, adaptiveEnabled: c.adaptiveEnabled,
    adaptiveLow: c.adaptiveLow, adaptiveMid: c.adaptiveMid, adaptiveHigh: c.adaptiveHigh, adaptiveCritical: c.adaptiveCritical,
    localEnabled: c.localEnabled, localUpstreamUrl: c.localUpstreamUrl, localCompressionModel: c.localCompressionModel,
    outputShaperEnabled: c.outputShaperEnabled, outputVerbositySteering: c.outputVerbositySteering,
    outputLevel: c.outputLevel, outputEffortRouting: c.outputEffortRouting,
    outputMechanicalThinkingFloor: c.outputMechanicalThinkingFloor,
  }
}

/** True when two parsed tomls yield an identical effective Config. */
export function migrationPreservesConfig(before: TomlConfig, after: TomlConfig): boolean {
  return JSON.stringify(configSnapshot(new Config(before)))
    === JSON.stringify(configSnapshot(new Config(after)))
}

export interface MigrationResult {
  migrated: boolean
  reason?: 'already-v2' | 'no-file'
  backupPath?: string
}

/**
 * Migrate ~/.squeezr/squeezr.toml in place. Idempotent (skips schema_version>=2),
 * backs up to .v1.bak, and validates the result is effect-preserving before
 * committing — on mismatch it restores the backup and throws loudly.
 */
export function migrateUserConfigFile(userPath: string): MigrationResult {
  if (!existsSync(userPath)) return { migrated: false, reason: 'no-file' }
  const rawText = readFileSync(userPath, 'utf-8')
  const before = parse(rawText) as TomlConfig
  if ((before.schema_version ?? 1) >= CURRENT_SCHEMA_VERSION) {
    return { migrated: false, reason: 'already-v2' }
  }

  const after = migrateTomlV1toV2(before)
  const rendered = renderV2Toml(after)

  // Validate BEFORE touching the file: the rendered toml must reproduce the exact
  // effective Config. No silent fallback — a bad migration must fail, not degrade.
  const reparsed = parse(rendered) as TomlConfig
  if (!migrationPreservesConfig(before, reparsed)) {
    throw new Error(
      `[squeezr] schema migration aborted: rendered v2 config does not match the ` +
      `original effective config. Left ${userPath} untouched.`,
    )
  }

  const backupPath = `${userPath}.v1.bak`
  copyFileSync(userPath, backupPath)
  writeFileSync(userPath, rendered, 'utf-8')
  return { migrated: true, backupPath }
}
