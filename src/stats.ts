import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Savings } from './compressor.js'

const STATS_FILE = join(homedir(), '.squeezr', 'stats.json')
const CHARS_PER_TOKEN = 3.5

interface ToolData { count: number; savedChars: number; originalChars: number }

export interface LatencyInfo {
  totalMs: number
  detMs?: number
  aiMs?: number
}

// ── Latency tracker (rolling percentile window) ──────────────────────────────

class LatencyTracker {
  private window: number[] = []
  constructor(private readonly maxSize = 200) {}

  record(ms: number): void {
    this.window.push(ms)
    if (this.window.length > this.maxSize) this.window.shift()
  }

  private percentile(p: number): number {
    if (this.window.length === 0) return 0
    const sorted = [...this.window].sort((a, b) => a - b)
    const idx = Math.ceil((p / 100) * sorted.length) - 1
    return sorted[Math.max(0, idx)]
  }

  summary(): { count: number; p50: number; p95: number; p99: number; avg: number; last: number } {
    const n = this.window.length
    if (n === 0) return { count: 0, p50: 0, p95: 0, p99: 0, avg: 0, last: 0 }
    const avg = Math.round(this.window.reduce((a, b) => a + b, 0) / n)
    return {
      count: n,
      p50: this.percentile(50),
      p95: this.percentile(95),
      p99: this.percentile(99),
      avg,
      last: this.window[n - 1],
    }
  }
}

export class Stats {
  // All fields declared with initializers — no bare type declarations to avoid ES2022 native field defineProperty issues
  private requests = 0
  private totalOriginalChars = 0
  private totalCompressedChars = 0
  private totalCompressions = 0
  private totalSessionCacheHits = 0
  private byTool: Record<string, ToolData> = {}
  private byProject: Record<string, {
    requests: number; savedChars: number; savedTokens: number
  }> = {}
  private byClient: Record<string, { requests: number; originalChars: number; savedChars: number }> = Stats.loadPersistedByClient()
  private byModel: Record<string, { requests: number; originalChars: number; savedChars: number }> = Stats.loadPersistedByModel()
  private currentProject = 'unknown'
  private sessionStart = Date.now()
  private lastOriginalChars = 0
  private lastCompressedChars = 0
// Breakdown counters for honest reporting
  private totalDetSaved = 0
  private totalDedupSaved = 0
  private totalAiSaved = 0
  private totalOverheadChars = 0
  private totalSyspromptSaved = 0
  private totalToolDescSaved = 0
  private totalMcpFilterSaved = 0
  private totalStaleTurnsSaved = 0
  private totalSkillDedupSaved = 0
  private totalAiCompressionCalls = 0

  // Latency tracking (rolling percentile windows)
  private latencyTotal = new LatencyTracker()
  private latencyDet = new LatencyTracker()
  private latencyAi = new LatencyTracker()

  // Expand rate tracking — THE quality metric for compression
  private expandCalls = 0
  private expandHits = 0
  private expandMisses = 0

  record(originalChars: number, compressedChars: number, savings: Savings, latency?: LatencyInfo, client?: string, model?: string): void {
    this.requests++
    this.totalOriginalChars += originalChars
    this.totalCompressedChars += compressedChars
    this.totalCompressions += savings.compressed
    this.totalSessionCacheHits += savings.sessionCacheHits
    this.lastOriginalChars = originalChars
    this.lastCompressedChars = compressedChars

    // Accumulate breakdown
this.totalDetSaved += savings.detSavedChars ?? 0
    this.totalDedupSaved += savings.dedupSavedChars ?? 0
    this.totalAiSaved += savings.aiSavedChars ?? 0
    this.totalOverheadChars += savings.overheadChars ?? 0
    this.totalToolDescSaved += savings.toolDescSavedChars ?? 0
    this.totalMcpFilterSaved += savings.mcpFilterSavedChars ?? 0
    this.totalStaleTurnsSaved += savings.staleTurnsSavedChars ?? 0
    this.totalSkillDedupSaved += savings.skillDedupSavedChars ?? 0
    this.totalSyspromptSaved += savings.syspromptSavedChars ?? 0
    this.totalAiCompressionCalls += savings.compressed

    // Latency tracking
    if (latency) {
      this.latencyTotal.record(latency.totalMs)
      if (latency.detMs != null) this.latencyDet.record(latency.detMs)
      if (latency.aiMs != null) this.latencyAi.record(latency.aiMs)
    }

for (const entry of savings.byTool) {
      if (!this.byTool[entry.tool]) this.byTool[entry.tool] = { count: 0, savedChars: 0, originalChars: 0 }
      // Det entries are per-tool aggregates carrying a real block count; AI entries
      // are per-block (count undefined → 1). Without this, every tool showed the
      // same number (= request count) in Top Tools.
      this.byTool[entry.tool].count += entry.count ?? 1
      this.byTool[entry.tool].savedChars += entry.savedChars
      this.byTool[entry.tool].originalChars += entry.originalChars
    }

    if (savings.savedChars > 0) {
      const pct = Math.round((savings.savedChars / Math.max(savings.originalChars, 1)) * 100)
      const tokens = Math.round(savings.savedChars / CHARS_PER_TOKEN)
      console.log(`[squeezr] ${savings.compressed} block(s) AI-compressed | -${savings.savedChars.toLocaleString()} chars (~${tokens.toLocaleString()} tokens) (${pct}% total saved, incl. deterministic)`)
    }

    this.persist(originalChars, compressedChars, savings, client, model)
  }

  /** @deprecated Pass savings.syspromptSavedChars instead */
  recordSystemPromptSaved(originalLen: number, compressedLen: number): void {
    if (compressedLen < originalLen) {
      this.totalSyspromptSaved += originalLen - compressedLen
    }
  }

  /** Call instead of record() when a project name is known. */
  recordWithProject(project: string, originalChars: number, compressedChars: number, savings: Savings, latency?: LatencyInfo, client?: string, model?: string): void {
    if (project !== 'unknown') this.currentProject = project
    this.record(originalChars, compressedChars, savings, latency, client, model)

    // Per-project session totals
    const p = this.currentProject
    if (!this.byProject[p]) this.byProject[p] = { requests: 0, savedChars: 0, savedTokens: 0 }
    this.byProject[p].requests++
    const saved = originalChars - compressedChars
    this.byProject[p].savedChars += saved
    this.byProject[p].savedTokens = Math.round(this.byProject[p].savedChars / CHARS_PER_TOKEN)

    // Per-client tracking
    if (client) {
      if (!this.byClient[client]) this.byClient[client] = { requests: 0, originalChars: 0, savedChars: 0 }
      this.byClient[client].requests++
      this.byClient[client].originalChars += originalChars
      this.byClient[client].savedChars += saved
    }

    // Per-model tracking
    if (model) {
      if (!this.byModel[model]) this.byModel[model] = { requests: 0, originalChars: 0, savedChars: 0 }
      this.byModel[model].requests++
      this.byModel[model].originalChars += originalChars
      this.byModel[model].savedChars += saved
    }
  }

  setProject(project: string): void {
    if (project !== 'unknown') this.currentProject = project
  }

  /** Track an expand call — the key quality metric for compression. */
  recordExpand(found: boolean): void {
    this.expandCalls++
    if (found) this.expandHits++
    else this.expandMisses++
  }

  currentProjectName(): string {
    return this.currentProject
  }

  summary() {
    const totalSaved = this.totalOriginalChars - this.totalCompressedChars
    const pct = this.totalOriginalChars > 0 ? Math.round((totalSaved / this.totalOriginalChars) * 1000) / 10 : 0
    const byToolOut: Record<string, { count: number; saved_chars: number; saved_tokens: number; avg_pct: number }> = {}
    for (const [tool, data] of Object.entries(this.byTool)) {
      byToolOut[tool] = {
        count: data.count,
        saved_chars: data.savedChars,
        saved_tokens: Math.round(data.savedChars / CHARS_PER_TOKEN),
        avg_pct: Math.round((data.savedChars / Math.max(data.originalChars, 1)) * 1000) / 10,
      }
    }
    return {
      requests: this.requests,
      compressions: this.totalCompressions,
      session_cache_hits: this.totalSessionCacheHits,
      total_original_chars: this.totalOriginalChars,
      total_saved_chars: totalSaved,
      total_saved_tokens: Math.round(totalSaved / CHARS_PER_TOKEN),
      savings_pct: pct,
      uptime_seconds: Math.round((Date.now() - this.sessionStart) / 1000),
      by_tool: byToolOut,
      current_project: this.currentProject,
      last_original_chars: this.lastOriginalChars,
      last_compressed_chars: this.lastCompressedChars,
      // Savings breakdown for honest dashboard reporting
breakdown: {
        tool_results_det: this.totalDetSaved,
        tool_results_ai: this.totalAiSaved,
        read_dedup: this.totalDedupSaved,
        tool_desc: this.totalToolDescSaved,
        mcp_filter: this.totalMcpFilterSaved,
        stale_turns: this.totalStaleTurnsSaved,
        skill_dedup: this.totalSkillDedupSaved,
        system_prompt: this.totalSyspromptSaved,
        overhead: this.totalOverheadChars,
        ai_calls: this.totalAiCompressionCalls,
      },
      // Latency percentiles (ms) for compression timing
      latency: {
        total: this.latencyTotal.summary(),
        deterministic: this.latencyDet.summary(),
        ai: this.latencyAi.summary(),
      },
      // Expand rate — key quality metric (high = compression too aggressive)
      expand: {
        calls: this.expandCalls,
        hits: this.expandHits,
        misses: this.expandMisses,
        rate_pct: this.totalCompressions > 0
          ? Math.round((this.expandCalls / this.totalCompressions) * 1000) / 10
          : 0,
      },
      // Per-model breakdown: tokens saved per model used
      by_model: Object.fromEntries(
        Object.entries(this.byModel).map(([model, data]) => [
          model,
          {
            requests: data.requests,
            original_tokens: Math.round(data.originalChars / CHARS_PER_TOKEN),
            saved_tokens: Math.round(data.savedChars / CHARS_PER_TOKEN),
            savings_pct: data.originalChars > 0
              ? Math.round((data.savedChars / data.originalChars) * 1000) / 10
              : 0,
          },
        ])
      ),
      // Per-client breakdown: tokens saved by Claude Code/Desktop, Codex, Gemini, etc.
      by_client: Object.fromEntries(
        Object.entries(this.byClient).map(([client, data]) => [
          client,
          {
            requests: data.requests,
            original_tokens: Math.round(data.originalChars / CHARS_PER_TOKEN),
            saved_tokens: Math.round(data.savedChars / CHARS_PER_TOKEN),
            savings_pct: data.originalChars > 0
              ? Math.round((data.savedChars / data.originalChars) * 1000) / 10
              : 0,
          },
        ])
      ),
    }
  }

  /**
   * Persist ONLY the delta from this request — not cumulative session totals.
   * This fixes the old triangular accumulation bug where session accumulators
   * were written in full on each request, inflating totals exponentially.
   */
  private persist(originalChars: number, compressedChars: number, savings: Savings, client?: string, model?: string): void {
    try {
      const dir = join(homedir(), '.squeezr')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      // Robust read: a corrupted stats.json (e.g. null bytes from an interrupted
      // write) must NOT abort persistence forever — treat it as empty and rebuild.
      let existing: Record<string, any> = {}
      if (existsSync(STATS_FILE)) {
        try {
          existing = JSON.parse(readFileSync(STATS_FILE, 'utf-8'))
        } catch {
          console.log('[squeezr] stats.json corrupted — rebuilding from session counters')
          existing = {}
        }
      }

      // Core counters — delta only
      existing.requests = (existing.requests ?? 0) + 1
      existing.total_saved_chars = (existing.total_saved_chars ?? 0) + (originalChars - compressedChars)
      existing.total_original_chars = (existing.total_original_chars ?? 0) + originalChars

      // Breakdown — delta only
      existing.det_saved_chars = (existing.det_saved_chars ?? 0) + (savings.detSavedChars ?? 0)
      existing.dedup_saved_chars = (existing.dedup_saved_chars ?? 0) + (savings.dedupSavedChars ?? 0)
      existing.ai_saved_chars = (existing.ai_saved_chars ?? 0) + (savings.aiSavedChars ?? 0)
      existing.overhead_chars = (existing.overhead_chars ?? 0) + (savings.overheadChars ?? 0)
      existing.tool_desc_saved_chars = (existing.tool_desc_saved_chars ?? 0) + (savings.toolDescSavedChars ?? 0)
      existing.mcp_filter_saved_chars = (existing.mcp_filter_saved_chars ?? 0) + (savings.mcpFilterSavedChars ?? 0)
      existing.stale_turns_saved_chars = (existing.stale_turns_saved_chars ?? 0) + (savings.staleTurnsSavedChars ?? 0)
      existing.skill_dedup_saved_chars = (existing.skill_dedup_saved_chars ?? 0) + (savings.skillDedupSavedChars ?? 0)
      existing.sysprompt_saved_chars = (existing.sysprompt_saved_chars ?? 0) + (savings.syspromptSavedChars ?? 0)
existing.ai_compression_calls = (existing.ai_compression_calls ?? 0) + savings.compressed
      // Local AI calls (Zest/Ollama) — persisted separately, not added to cost counters
      if (savings.localAiCalls != null && savings.localAiCalls > 0) {
        existing.local_ai_calls = (existing.local_ai_calls ?? 0) + savings.localAiCalls
        existing.local_ai_saved_chars = (existing.local_ai_saved_chars ?? 0) + (savings.localAiSavedChars ?? 0)
      }

      // ── Daily totals (local calendar day, 00:00–23:59) for the "Today" overview ──
      // Reset whenever the local date rolls over so the overview never shows all-time.
      const todayKey = new Date().toLocaleDateString('en-CA') // 'YYYY-MM-DD' local
      if (existing.today_date !== todayKey) {
        existing.today_date = todayKey
        existing.today_saved_chars = 0
        existing.today_original_chars = 0
        existing.today_requests = 0
        existing.today_ai_saved_chars = 0
        existing.today_ai_calls = 0
        existing.today_local_ai_calls = 0
        existing.today_by_model = {}
        existing.today_by_client = {}
      }
      existing.today_saved_chars = (existing.today_saved_chars ?? 0) + (originalChars - compressedChars)
      existing.today_original_chars = (existing.today_original_chars ?? 0) + originalChars
      existing.today_requests = (existing.today_requests ?? 0) + 1
      existing.today_ai_saved_chars = (existing.today_ai_saved_chars ?? 0) + (savings.aiSavedChars ?? 0)
      existing.today_ai_calls = (existing.today_ai_calls ?? 0) + savings.compressed
      existing.today_local_ai_calls = (existing.today_local_ai_calls ?? 0) + (savings.localAiCalls ?? 0)
      // Per-model / per-client breakdown for TODAY (so the Overview cards match the
      // today hero, not all-time). Char-based; converted to tokens in the payload.
      const dayDelta = originalChars - compressedChars
      if (model) {
        const tbm = (existing.today_by_model ??= {}) as Record<string, { requests: number; originalChars: number; savedChars: number }>
        if (!tbm[model]) tbm[model] = { requests: 0, originalChars: 0, savedChars: 0 }
        tbm[model].requests++
        tbm[model].originalChars += originalChars
        tbm[model].savedChars += dayDelta
      }
      if (client) {
        const tbc = (existing.today_by_client ??= {}) as Record<string, { requests: number; originalChars: number; savedChars: number }>
        if (!tbc[client]) tbc[client] = { requests: 0, originalChars: 0, savedChars: 0 }
        tbc[client].requests++
        tbc[client].originalChars += originalChars
        tbc[client].savedChars += dayDelta
      }

      // By-tool: write current session snapshot (these are already correct cumulative values)
      const bt = existing.by_tool ?? {}
      for (const [tool, data] of Object.entries(this.byTool)) {
        if (!bt[tool]) bt[tool] = { count: 0, savedChars: 0, originalChars: 0 }
        bt[tool].count = data.count
        bt[tool].savedChars = data.savedChars
        bt[tool].originalChars = data.originalChars
      }
      existing.by_tool = bt

      // By-model: write cumulative snapshot (byModel is pre-loaded from disk at startup
      // so it already includes historical data — just overwrite with current state)
      existing.by_model = Object.fromEntries(
        Object.entries(this.byModel).map(([model, data]) => [model, {
          requests: data.requests,
          originalChars: data.originalChars,
          savedChars: data.savedChars,
        }])
      )

      // By-client: same pattern — pre-loaded from disk so this overwrite is a
      // cumulative snapshot, not a session-only blow-away.
      existing.by_client = Object.fromEntries(
        Object.entries(this.byClient).map(([client, data]) => [client, {
          requests: data.requests,
          originalChars: data.originalChars,
          savedChars: data.savedChars,
        }])
      )

      // Atomic write: write to tmp then rename, so a kill mid-write can never
      // leave stats.json half-written (the null-bytes corruption of 2026-05-24).
      const tmp = STATS_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify(existing))
      renameSync(tmp, STATS_FILE)
    } catch { /* ignore */ }
  }

  static loadGlobal(): Record<string, unknown> {
    try {
      if (existsSync(STATS_FILE)) return JSON.parse(readFileSync(STATS_FILE, 'utf-8'))
    } catch { /* ignore */ }
    return {}
  }

  static loadPersistedByModel(): Record<string, { requests: number; originalChars: number; savedChars: number }> {
    try {
      const data = Stats.loadGlobal()
      if (data.by_model && typeof data.by_model === 'object') {
        return data.by_model as Record<string, { requests: number; originalChars: number; savedChars: number }>
      }
    } catch { /* ignore */ }
    return {}
  }

  static loadPersistedByClient(): Record<string, { requests: number; originalChars: number; savedChars: number }> {
    try {
      const data = Stats.loadGlobal()
      if (data.by_client && typeof data.by_client === 'object') {
        return data.by_client as Record<string, { requests: number; originalChars: number; savedChars: number }>
      }
    } catch { /* ignore */ }
    return {}
  }
}
