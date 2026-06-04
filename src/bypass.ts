/**
 * Bypass module — compression toggle, PERSISTED across restarts.
 *
 * When bypass is ON, requests pass through uncompressed (but still logged).
 * State is persisted to ~/.squeezr/bypass.json so a `squeezr restart` (or a
 * crash + auto-restart) does NOT silently re-enable compression — the
 * 2026-06-04 incident: a restart reset bypass to OFF and the proxy resumed
 * burning the plan via cache-invalidating compression.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BYPASS_FILE = join(homedir(), '.squeezr', 'bypass.json')

function loadPersisted(): boolean {
  try {
    if (!existsSync(BYPASS_FILE)) return false
    const data = JSON.parse(readFileSync(BYPASS_FILE, 'utf-8')) as { bypassed?: boolean }
    return data.bypassed === true
  } catch {
    return false
  }
}

let bypassed = loadPersisted()

function persist(): void {
  try {
    const dir = join(homedir(), '.squeezr')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = BYPASS_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify({ bypassed }))
    renameSync(tmp, BYPASS_FILE)
  } catch {
    /* best-effort */
  }
}

export function isBypassed(): boolean {
  return bypassed
}

export function setBypassed(val: boolean): void {
  bypassed = val
  persist()
  console.log(`[squeezr] Bypass mode ${val ? 'ON — compression disabled' : 'OFF — compression active'} (persisted)`)
}

export function toggleBypassed(): boolean {
  setBypassed(!bypassed)
  return bypassed
}
