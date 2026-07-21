import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secureKeyFile } from '../codexMitm.js'

// Security regression: the CA private key must be locked to the current user.
// 0o600 is a no-op on Windows, so secureKeyFile applies a per-OS restriction
// (icacls on Windows, chmod on POSIX). It must never throw — a key we cannot
// secure is warned about, not fatal — and must leave the file readable by us.
describe('secureKeyFile', () => {
  it('secures a key file without throwing and keeps it owner-readable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'squeezr-key-'))
    const keyPath = join(dir, 'ca.key')
    writeFileSync(keyPath, 'PRIVATE-KEY-MATERIAL', { mode: 0o600 })
    try {
      expect(() => secureKeyFile(keyPath)).not.toThrow()
      expect(readFileSync(keyPath, 'utf-8')).toBe('PRIVATE-KEY-MATERIAL')
      if (process.platform !== 'win32') {
        // On POSIX the mode must be owner-only (no group/other bits).
        expect(statSync(keyPath).mode & 0o077).toBe(0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
