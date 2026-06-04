/**
 * AI compression toggle — PERSISTED across restarts.
 *
 * Master on/off for AI compression calls (Haiku/GPT/Gemini), controllable from
 * the dashboard. Persisted to ~/.squeezr/ai-compression.json so a restart keeps
 * the user's choice. Initial value falls back to the TOML `ai_compression`
 * setting (default false) when no persisted file exists.
 *
 * This is the SECOND gate (alongside the per-request rate limit and the cache
 * barrier). When OFF, zero AI calls happen regardless of anything else.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { config } from './config.js'

const TOGGLE_FILE = join(homedir(), '.squeezr', 'ai-compression.json')

function loadPersisted(): boolean {
  try {
    if (!existsSync(TOGGLE_FILE)) return config.aiCompression  // TOML default
    const data = JSON.parse(readFileSync(TOGGLE_FILE, 'utf-8')) as { enabled?: boolean }
    return data.enabled === true
  } catch {
    return config.aiCompression
  }
}

let enabled = loadPersisted()

function persist(): void {
  try {
    const dir = join(homedir(), '.squeezr')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = TOGGLE_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify({ enabled }))
    renameSync(tmp, TOGGLE_FILE)
  } catch {
    /* best-effort */
  }
}

export function isAiCompressionEnabled(): boolean {
  return enabled
}

export function setAiCompression(val: boolean): void {
  enabled = val
  persist()
  console.log(`[squeezr] AI compression ${val ? 'ON — will call the compression backend' : 'OFF — deterministic only (free)'} (persisted)`)
}

export function toggleAiCompression(): boolean {
  setAiCompression(!enabled)
  return enabled
}
