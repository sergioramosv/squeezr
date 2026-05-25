import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { parse } from 'smol-toml'

const __dirname = dirname(fileURLToPath(import.meta.url))
// User-overridable config lives in ~/.squeezr/squeezr.toml so that an
// `npm install -g squeezr-ai@latest` (which wipes the package directory)
// does NOT erase the user's port and customisation choices. The bundled
// squeezr.toml inside the package now serves as factory defaults only.
export const USER_CONFIG_DIR = join(homedir(), '.squeezr')
export const USER_CONFIG_PATH = join(USER_CONFIG_DIR, 'squeezr.toml')

interface TomlConfig {
  proxy?: { port?: number; mitm_port?: number }
  compression?: {
    threshold?: number
    keep_recent?: number
    disabled?: boolean
    compress_system_prompt?: boolean
    compress_conversation?: boolean
    keep_recent_assistant?: number
    assistant_threshold?: number
    anthropic_native_compact?: boolean  // anthropic-beta: compact-2026-01-12
    backend?: string  // 'auto' | 'local' | 'haiku' | 'gpt-mini' | 'gemini-flash'
    skip_tools?: string[]
    only_tools?: string[]
    ai_skip_tools?: string[]
  }
  cache?: { enabled?: boolean; max_entries?: number }
  adaptive?: {
    enabled?: boolean
    low_threshold?: number
    mid_threshold?: number
    high_threshold?: number
    critical_threshold?: number
  }
  local?: {
    enabled?: boolean
    upstream_url?: string
    compression_model?: string
    dummy_keys?: string[]
  }
}

function loadTomlFile(path: string): TomlConfig {
  if (!existsSync(path)) return {}
  try {
    return parse(readFileSync(path, 'utf-8')) as TomlConfig
  } catch {
    return {}
  }
}

function deepMerge(base: TomlConfig, override: TomlConfig): TomlConfig {
  const result = { ...base } as Record<string, unknown>
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      result[k] = { ...(result[k] as Record<string, unknown> ?? {}), ...(v as Record<string, unknown>) }
    } else if (v !== undefined) {
      result[k] = v
    }
  }
  return result as TomlConfig
}

function loadToml(): TomlConfig {
  const bundledPath = join(__dirname, '..', 'squeezr.toml')
  const userPath = USER_CONFIG_PATH
  const localPath = join(process.cwd(), '.squeezr.toml')
  // One-time migration: if the bundled toml has been hand-edited (typical case
  // before 1.46.2 because the dashboard wrote ports there) AND no user config
  // exists yet, copy the bundled file to ~/.squeezr/ so the user's choices
  // survive the next `npm install -g`.
  migrateBundledToUserHome(bundledPath, userPath)
  const bundledCfg = loadTomlFile(bundledPath)
  const userCfg = loadTomlFile(userPath)
  const localCfg = loadTomlFile(localPath)
  if (Object.keys(userCfg).length > 0) {
    console.log(`[squeezr] Using user config: ${userPath}`)
  }
  if (Object.keys(localCfg).length > 0) {
    console.log(`[squeezr] Using project config: ${localPath}`)
  }
  // Precedence (low → high): bundled defaults → user home → project local.
  return deepMerge(deepMerge(bundledCfg, userCfg), localCfg)
}
function migrateBundledToUserHome(bundledPath: string, userPath: string): void {
  if (existsSync(userPath)) return
  if (!existsSync(bundledPath)) return
  try {
    const raw = readFileSync(bundledPath, 'utf-8')
    const parsed = parse(raw) as TomlConfig
    const port = parsed.proxy?.port
    const mitm = parsed.proxy?.mitm_port
    const hasCustomPorts = (port !== undefined && port !== 8080)
      || (mitm !== undefined && mitm !== (port ?? 8080) + 1)
    if (!hasCustomPorts) return
    mkdirSync(USER_CONFIG_DIR, { recursive: true })
    writeFileSync(userPath, raw, 'utf-8')
    console.log(`[squeezr] Migrated custom config from bundled toml to ${userPath}`)
  } catch {
    /* migration is best-effort */
  }
}

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

export class Config {
  readonly port: number
  readonly mitmPort: number
  readonly threshold: number
  readonly keepRecent: number
  readonly disabled: boolean
  readonly compressSystemPrompt: boolean
  readonly compressConversation: boolean
  readonly keepRecentAssistant: number
  readonly assistantThreshold: number
  readonly anthropicNativeCompact: boolean
  readonly compressionBackend: CompressionBackend
  readonly dryRun: boolean
  readonly skipTools: Set<string>
  readonly onlyTools: Set<string>
  readonly aiSkipTools: Set<string>
  readonly cacheEnabled: boolean
  readonly cacheMaxEntries: number
  readonly adaptiveEnabled: boolean
  readonly adaptiveLow: number
  readonly adaptiveMid: number
  readonly adaptiveHigh: number
  readonly adaptiveCritical: number
  readonly localEnabled: boolean
  readonly localUpstreamUrl: string
  readonly localCompressionModel: string
  readonly localDummyKeys: Set<string>

  constructor() {
    const t = loadToml()
    const p = t.proxy ?? {}
    const c = t.compression ?? {}
    const ca = t.cache ?? {}
    const ad = t.adaptive ?? {}
    const lo = t.local ?? {}

    this.port = parseInt(env('SQUEEZR_PORT', String(p.port ?? 8080)))
    this.mitmPort = parseInt(env('SQUEEZR_MITM_PORT', String(p.mitm_port ?? this.port + 1)))
    this.threshold = parseInt(env('SQUEEZR_THRESHOLD', String(c.threshold ?? 800)))
    this.keepRecent = parseInt(env('SQUEEZR_KEEP_RECENT', String(c.keep_recent ?? 3)))
    this.disabled = env('SQUEEZR_DISABLED', String(c.disabled ?? false)) === '1' || env('SQUEEZR_DISABLED', '') === 'true'
    this.compressSystemPrompt = c.compress_system_prompt ?? true
    this.compressConversation = c.compress_conversation ?? true  // safe by default — only deterministic on assistant msgs
    this.keepRecentAssistant = c.keep_recent_assistant ?? 3
    this.assistantThreshold = c.assistant_threshold ?? 300
    this.anthropicNativeCompact = c.anthropic_native_compact ?? false  // opt-in beta
    const validBackends = new Set<CompressionBackend>(['auto', 'local', 'haiku', 'gpt-mini', 'gemini-flash'])
    const backendRaw = (c.backend ?? 'auto') as CompressionBackend
    this.compressionBackend = validBackends.has(backendRaw) ? backendRaw : 'auto'
    this.dryRun = env('SQUEEZR_DRY_RUN', '') === '1'
    this.skipTools = new Set((c.skip_tools ?? []).map(t => t.toLowerCase()))
    this.onlyTools = new Set((c.only_tools ?? []).map(t => t.toLowerCase()))
    this.aiSkipTools = new Set((c.ai_skip_tools ?? ['read']).map(t => t.toLowerCase()))
    this.cacheEnabled = ca.enabled ?? true
    this.cacheMaxEntries = ca.max_entries ?? 1000
    this.adaptiveEnabled = ad.enabled ?? true
    this.adaptiveLow = ad.low_threshold ?? 1500
    this.adaptiveMid = ad.mid_threshold ?? 800
    this.adaptiveHigh = ad.high_threshold ?? 400
    this.adaptiveCritical = ad.critical_threshold ?? 150
    this.localEnabled = lo.enabled ?? true
    this.localUpstreamUrl = env('SQUEEZR_LOCAL_UPSTREAM', lo.upstream_url ?? 'http://localhost:11434')
    this.localCompressionModel = env('SQUEEZR_LOCAL_MODEL', lo.compression_model ?? 'qwen2.5-coder:1.5b')
    const rawDummies = lo.dummy_keys ?? ['ollama', 'lm-studio', 'sk-no-key-required', 'local', 'none', '']
    this.localDummyKeys = new Set(rawDummies.map(k => k.toLowerCase()))
  }

  thresholdForPressure(pressure: number): number {
    if (!this.adaptiveEnabled) return this.threshold
    if (pressure >= 0.90) return this.adaptiveCritical
    if (pressure >= 0.75) return this.adaptiveHigh
    if (pressure >= 0.50) return this.adaptiveMid
    return this.adaptiveLow
  }

  shouldSkipTool(toolName: string): boolean {
    const t = toolName.toLowerCase()
    if (this.onlyTools.size > 0) return !this.onlyTools.has(t)
    return this.skipTools.has(t)
  }

  isLocalKey(key: string): boolean {
    if (!this.localEnabled) return false
    const k = key.trim().toLowerCase()
    // JWT OAuth tokens (Codex) start with 'eyj' — never route those to local
    return this.localDummyKeys.has(k) || (k.length > 0 && !k.startsWith('sk-') && !k.startsWith('aiza') && !k.startsWith('eyj'))
  }
}

// ── Runtime overrides (hot-reload from dashboard) ─────────────────────────────
// These override the TOML config values without restarting the proxy.

export type CompressionMode = 'soft' | 'normal' | 'aggressive' | 'critical'

export type CompressionBackend = 'auto' | 'local' | 'haiku' | 'gpt-mini' | 'gemini-flash'

export interface RuntimeOverrides {
  mode: CompressionMode
  threshold?: number
  keepRecent?: number
  aiEnabled?: boolean
  anthropicNativeCompact?: boolean
  compressionBackend?: CompressionBackend
}

const MODES: Record<CompressionMode, Omit<RuntimeOverrides, 'mode'>> = {
  soft:       { threshold: 3000, keepRecent: 10, aiEnabled: false },
  normal:     { threshold: 800,  keepRecent: 3,  aiEnabled: true  },
  aggressive: { threshold: 200,  keepRecent: 1,  aiEnabled: true  },
  critical:   { threshold: 50,   keepRecent: 0,  aiEnabled: true  },
}

export const runtimeOverrides: RuntimeOverrides = { mode: 'normal' }

export function applyMode(mode: CompressionMode): void {
  const preset = MODES[mode]
  Object.assign(runtimeOverrides, { mode, ...preset })
  console.log(`[squeezr] Mode → ${mode} (threshold=${preset.threshold}, keepRecent=${preset.keepRecent}, ai=${preset.aiEnabled})`)
}

/** Effective threshold — runtime override wins over TOML adaptive threshold */
export function effectiveThreshold(config: Config, pressure: number): number {
  if (runtimeOverrides.threshold !== undefined) return runtimeOverrides.threshold
  return config.thresholdForPressure(pressure)
}

/** Effective keepRecent — runtime override wins */
export function effectiveKeepRecent(config: Config): number {
  return runtimeOverrides.keepRecent ?? config.keepRecent
}

/** Whether AI compression is enabled right now */
export function aiEnabled(): boolean {
  return runtimeOverrides.aiEnabled ?? true
}

/** Whether Anthropic's native compact-2026-01-12 beta is enabled */
export function anthropicNativeCompactEnabled(): boolean {
  return runtimeOverrides.anthropicNativeCompact ?? config.anthropicNativeCompact
}

/** Get the effective compression backend (runtime override > config > 'auto') */
export function effectiveBackend(): CompressionBackend {
  return runtimeOverrides.compressionBackend ?? config.compressionBackend
}

export const config = new Config()
