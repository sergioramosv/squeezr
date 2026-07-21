/**
 * Structured writer for ~/.squeezr/squeezr.toml — pillar A / P3.
 *
 * The old writers edited the toml text with regexes that HARDCODED the v1 table
 * names ([proxy]/[compression]). After the v2 migration those would recreate the
 * old tables on the next dashboard save and silently un-migrate the file. This
 * writer parses → sets the nested [table].key → re-serialises, so it always
 * targets the correct v2 namespace by construction and can never resurrect a v1
 * table. Comments in the USER override file are not preserved on write — the full
 * documentation lives in the bundled squeezr.toml, not the user's overrides.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { USER_CONFIG_PATH } from './config.js'

type TomlDoc = Record<string, Record<string, unknown>>

/** Set one [table].key = value in the user toml (parse → mutate → serialise). */
export function setUserConfigValue(table: string, key: string, value: unknown, targetPath: string = USER_CONFIG_PATH): void {
  setUserConfigValues(table, { [key]: value }, targetPath)
}

/** Set several keys in the same [table] in a single read/write.
 *  `targetPath` is a test seam; production always writes USER_CONFIG_PATH. */
export function setUserConfigValues(table: string, values: Record<string, unknown>, targetPath: string = USER_CONFIG_PATH): void {
  mkdirSync(dirname(targetPath), { recursive: true })
  const raw = existsSync(targetPath) ? readFileSync(targetPath, 'utf-8') : ''
  const doc = (raw.trim() ? parse(raw) : {}) as TomlDoc
  const current = (doc[table] && typeof doc[table] === 'object') ? doc[table] : {}
  doc[table] = { ...current, ...values }
  writeFileSync(targetPath, stringify(doc), 'utf-8')
}
