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
    ai_compression?: boolean  // master switch for ALL AI compression calls (Haiku/GPT/Gemini). Default FALSE — opt-in only.
    compress_system_prompt?: boolean
    compress_conversation?: boolean
    compress_tool_inputs?: boolean  // lossy-clean OLD Write/Edit/Bash tool_use INPUTS. Default FALSE — corrupts code (see 1.82.0).
    keep_recent_assistant?: number
    assistant_threshold?: number
    compress_assistant_ai?: boolean
    assistant_ai_min_chars?: number
    anthropic_native_compact?: boolean  // anthropic-beta: compact-2026-01-12
    backend?: string  // 'auto' | 'local' | 'haiku' | 'gpt-mini' | 'gemini-flash'
    skip_tools?: string[]
    only_tools?: string[]
    ai_skip_tools?: string[]
    capture_requests?: boolean  // capture incoming /v1/messages payloads (anonymized) to ~/.squeezr/captures/
    capture_limit?: number  // max number of captures to keep before stopping (default 20)
    stale_turns?: boolean         // summarize old assistant turns (default true)
    stale_turn_threshold?: number // user-turns before triggering (default 40)
    stale_keep_recent?: number    // turns to keep at full fidelity (default 15)
    tool_desc_compress?: boolean     // compress tool descriptions (default false)
    tool_desc_first_para?: boolean   // keep only first paragraph (default true)
    tool_desc_safe_only?: boolean    // only truncate known built-ins (default true)
    tool_desc_expand?: boolean       // store full spec in expand store, add squeezr_expand hint (default true)
    tool_desc_max_chars?: number     // hard-truncate to N chars after first-para (0 = off)
    mcp_block_servers?: string[]     // drop tools from these MCP servers (unless used in conversation)
    mcp_allow_servers?: string[]     // if set, ONLY these MCP servers survive (block list ignored)
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
  output?: {
    enabled?: boolean               // master switch for output-side reduction (default false)
    verbosity_steering?: boolean    // append terse-instruction block to system tail (default true)
    level?: number                  // verbosity level 1-4 (default 2)
    effort_routing?: boolean        // lower thinking budget on mechanical turns (default true)
    mechanical_thinking_floor?: number  // budget_tokens floor on mechanical turns (default 1024)
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
  readonly aiCompression: boolean
  readonly compressSystemPrompt: boolean
  readonly compressConversation: boolean
  readonly compressToolInputs: boolean
  readonly captureRequests: boolean
  readonly captureLimit: number
  readonly staleTurns: boolean
  readonly staleTurnThreshold: number
  readonly staleTurnKeepRecent: number
readonly toolDescCompress: boolean
  readonly toolDescFirstPara: boolean
  readonly toolDescSafeOnly: boolean
  readonly toolDescExpand: boolean
  readonly toolDescMaxChars: number
  readonly mcpBlockServers: Set<string>
  readonly mcpAllowServers: Set<string>
  readonly keepRecentAssistant: number
  readonly assistantThreshold: number
  readonly compressAssistantAi: boolean
  readonly assistantAiMinChars: number
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
  readonly outputShaperEnabled: boolean
  readonly outputVerbositySteering: boolean
  readonly outputLevel: 1 | 2 | 3 | 4
  readonly outputEffortRouting: boolean
  readonly outputMechanicalThinkingFloor: number

  constructor() {
    const t = loadToml()
    const p = t.proxy ?? {}
    const c = t.compression ?? {}
    const ca = t.cache ?? {}
    const ad = t.adaptive ?? {}
    const lo = t.local ?? {}
    const ou = t.output ?? {}

    this.port = parseInt(env('SQUEEZR_PORT', String(p.port ?? 8080)))
    this.mitmPort = parseInt(env('SQUEEZR_MITM_PORT', String(p.mitm_port ?? this.port + 1)))
    this.threshold = parseInt(env('SQUEEZR_THRESHOLD', String(c.threshold ?? 800)))
    this.keepRecent = parseInt(env('SQUEEZR_KEEP_RECENT', String(c.keep_recent ?? 3)))
    this.disabled = env('SQUEEZR_DISABLED', String(c.disabled ?? false)) === '1' || env('SQUEEZR_DISABLED', '') === 'true'
    // AI compression master switch — DEFAULT FALSE. When the user authenticates
    // with a Claude Code OAuth token (subscription), every Haiku compression call
    // bills against their OWN 5h plan quota — it can burn the plan faster than it
    // saves. Opt-in only: set compression.ai_compression = true to enable.
    this.aiCompression = c.ai_compression ?? false
    // compress_system_prompt also makes a Haiku call — gate it behind aiCompression too.
    this.compressSystemPrompt = (c.compress_system_prompt ?? true) && this.aiCompression
    this.compressConversation = c.compress_conversation ?? true  // safe by default — only deterministic on assistant msgs
    // Lossy-clean OLD tool_use INPUTS (Write.content, Edit.old/new_string, Bash.command).
    // DEFAULT FALSE: these are model-authored code that round-trips to disk verbatim
    // (Write) or must byte-match disk (Edit old_string). Running dedup/whitespace/JSON
    // minify over them folded repeated lines into "... [repeated N more times]", dropped
    // braces and JSX `>`, and .trim()'d file bodies — corruption that reached disk when
    // the model later re-edited from its now-mangled view of its own past writes.
    this.compressToolInputs = c.compress_tool_inputs ?? false
    this.captureRequests = c.capture_requests ?? false
    this.captureLimit = c.capture_limit ?? 20
    this.staleTurns = c.stale_turns ?? true
    this.staleTurnThreshold = c.stale_turn_threshold ?? 40
    this.staleTurnKeepRecent = c.stale_keep_recent ?? 15
this.toolDescCompress = c.tool_desc_compress ?? false
    this.toolDescFirstPara = c.tool_desc_first_para ?? true
    this.toolDescSafeOnly = c.tool_desc_safe_only ?? true
    this.toolDescExpand = c.tool_desc_expand ?? true
    this.toolDescMaxChars = c.tool_desc_max_chars ?? 0
    this.mcpBlockServers = new Set(c.mcp_block_servers ?? [])
    this.mcpAllowServers = new Set(c.mcp_allow_servers ?? [])
    this.keepRecentAssistant = c.keep_recent_assistant ?? 3
    this.assistantThreshold = c.assistant_threshold ?? 300
    // AI-compress long OLD assistant turns (Fase B2). Default OFF — it touches model
    // prose, so it's opt-in; protected by the guardrail + retry + governor. Min size
    // high (2000) so only substantial turns are touched.
    this.compressAssistantAi = c.compress_assistant_ai ?? false
    this.assistantAiMinChars = c.assistant_ai_min_chars ?? 2000
    this.anthropicNativeCompact = c.anthropic_native_compact ?? false  // opt-in beta
    const validBackends = new Set<CompressionBackend>(['auto', 'local', 'haiku', 'gpt-mini', 'gemini-flash'])
    // Default to the FREE local backend (Zest), never a paid cloud one. With AI
    // compression off by default this is belt-and-suspenders: even if a user enables
    // AI, updating to this version can never silently start billing Haiku/GPT/Gemini.
    // Cloud backends are opt-in only (explicit backend = "haiku" | "gpt-mini" | …).
    const backendRaw = (c.backend ?? 'local') as CompressionBackend
    this.compressionBackend = validBackends.has(backendRaw) ? backendRaw : 'local'
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
    // Output-side token reduction. DEFAULT OFF — opt-in, like all levers that
    // reshape behaviour rather than just clean tool output. Enable via TOML
    // [output] enabled = true, or env SQUEEZR_OUTPUT_SHAPER=1. Both sub-levers
    // (verbosity steering, effort routing) default ON once the master is on.
    this.outputShaperEnabled =
      env('SQUEEZR_OUTPUT_SHAPER', '') === '1' || env('SQUEEZR_OUTPUT_SHAPER', '') === 'true' || (ou.enabled ?? false)
    this.outputVerbositySteering = ou.verbosity_steering ?? true
    const lvl = ou.level ?? 2
    this.outputLevel = (lvl >= 1 && lvl <= 4 ? lvl : 2) as 1 | 2 | 3 | 4
    this.outputEffortRouting = ou.effort_routing ?? true
    this.outputMechanicalThinkingFloor = ou.mechanical_thinking_floor ?? 1024
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
  aiMinChars?: number   // governed by the quality auto-backoff (qualityGovernor)
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
  // If a runtime override threshold is set (from dashboard mode button), use it
  // as a FIXED value — ignore adaptive pressure. This makes compression output
  // byte-stable between requests, which is required for Anthropic prompt cache hits.
  // If no override: fall back to pressure-adaptive (legacy behavior, no cache markers).
  if (runtimeOverrides.threshold !== undefined) return runtimeOverrides.threshold
  // When cache markers are present, always use the mid threshold (normal mode default)
  // so the prefix is byte-stable. Adaptive only safe when there are no cache markers.
  return config.thresholdForPressure(pressure)
}

/** Effective keepRecent — runtime override wins */
export function effectiveKeepRecent(config: Config): number {
  return runtimeOverrides.keepRecent ?? config.keepRecent
}
// Minimum tool-result block size (chars) eligible for AI compression. Kept at 1500
// (validated safe): live data showed 1000 made the guardrail reject ~100% of the
// extra small blocks (they can't be summarized without dropping key tokens), which
// adds zero ratio and wastes Zest calls. Lowering below 1500 should wait for the
// Stage-5 quality harness. The governor can still raise this floor at runtime
// (runtimeOverrides.aiMinChars) if the expand/reject rate climbs.
export const DEFAULT_AI_MIN_CHARS = 1500
export function effectiveAiMinChars(): number {
  return runtimeOverrides.aiMinChars ?? DEFAULT_AI_MIN_CHARS
}

/** Whether the runtime mode override allows AI compression.
 * NOTE: this is only the mode gate. The master switch is `config.aiCompression`
 * (default false), checked alongside this in the compressor. */
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
