# Pillar A — Config redesign + automatic migration (the 2.0 breaking change)

> V2_ROADMAP A.1 (schema redesign) + A.2 (safe defaults). This is what legitimises
> the MAJOR bump in SemVer: the flat `[compression]` (~25 flags) becomes clear
> namespaces, with **automatic 1:1 lossless migration** on first 2.0 boot so the
> user touches nothing.
>
> Investigated by Karajan (researcher). Verdict: viable; the hard part is the
> TOML *writers*, not the flag mapping.

## New schema (4 headline namespaces + kept tables)
```toml
[input]     # everything that compresses what ENTERS (tool results, system prompt refs, tool descs, MCP, stale turns)
[ai]        # AI backend, master switch, min-chars, rate-limit, guardrails (all billable/behavioural)
[output]    # output-side reduction (already shipped in 1.83.0)
[safety]    # bypass, circuit-breaker, cache-barrier, structured/compressibility guards
# kept as-is (already clean): [proxy], [cache] (LRU compression cache), [adaptive], [local]
```

## Old → new mapping (complete)
| New | Keys |
|---|---|
| `[input]` | threshold, keep_recent, compress_conversation, compress_tool_inputs, stale_turns, stale_turn_threshold, stale_keep_recent, tool_desc_compress, tool_desc_first_para, tool_desc_safe_only, tool_desc_expand, tool_desc_max_chars, mcp_block_servers, mcp_allow_servers, skip_tools, only_tools, keep_recent_assistant, assistant_threshold, capture_requests, capture_limit |
| `[ai]` | ai_compression (master), backend, compress_system_prompt (ai-gated), compress_assistant_ai, assistant_ai_min_chars, ai_skip_tools, anthropic_native_compact, **NEW** rate_limit_window_ms (300000), rate_limit_max_calls (20), min_chars (1500) |
| `[output]` | enabled, verbosity_steering, level, effort_routing, mechanical_thinking_floor |
| `[safety]` | disabled (bypass), **NEW** circuit_breaker_{failures:3,reset_ms:60000,timeout_ms:5000}, guard_min_ratio (0.15), guard_soft_tolerance (0.10), max_deflate (0.55) |
| `[proxy]` | port, mitm_port (unchanged) |
| `[cache]` | enabled, max_entries (unchanged — this is the LRU compression cache, NOT the prompt-cache barrier) |
| `[adaptive]` | enabled, low/mid/high/critical_threshold (unchanged) |
| `[local]` | enabled, upstream_url, compression_model, dummy_keys (unchanged — local backend infra) |

Coupled pairs that MUST migrate together: `compress_conversation` ⟷ `compress_tool_inputs` (the first gates the second).

## A.2 — safe-default flips (golden rule: only deterministic + cache-safe + reversible)
- `input.tool_desc_compress = true` (with `tool_desc_expand = true`, recoverable) — the cheap ~17-23K tokens/request win, OFF today.
- Stays OFF: `ai.ai_compression`, `output.enabled`, and `input.compress_tool_inputs` (NEVER on — corrupted disk code in 1.82.0).
- `output.verbosity_steering` is cache-safe (byte-stable system-tail append); `effort_routing` changes thinking budget → stays gated under `output.enabled`.

## Migration design (correctness is everything here)
1. **Gate by a persisted `schema_version` marker** (top-level in the toml). Absent/`1` → run `migrateSchemaV1toV2()` once; `2` → skip. Prevents re-runs and double-migration.
2. **Read the MERGED EFFECTIVE value** (bundled + user), not just the user file — otherwise users relying on a bundled default (e.g. `tool_desc_compress=true` in the bundled toml vs `false` in code) get silently downgraded.
3. **Backup** the original to `squeezr.toml.v1.bak` before writing.
4. **Emit a fresh, fully-commented v2 toml from a template** populated with migrated values (see decision C) — the comments ARE the user docs.
5. **Validate loudly**: re-parse the written file and assert the effective Config is identical to pre-migration; on mismatch, restore the backup and fail loudly (no silent revert-to-defaults — today `loadTomlFile` swallows parse errors, which violates the no-silent-fallback rule).
6. **Sidecars stay authoritative**: `ai-compression.json` / `bypass.json` override at runtime; migration treats toml only as the default source, never rewrites a value the runtime is currently overriding.

## The real work: rewrite the TOML writers (highest risk)
`server.ts` `persistBackendToToml()` (→ `[compression]`), POST `/squeezr/ports` `updateKey()` (→ `[proxy]`), and dashboard toggles write via **regex on hardcoded table/key names**. After migration these would append orphan keys or recreate the OLD tables → silent un-migration. Replace with a single structured writer that targets the new namespaces and round-trips safely. A read→write→read test must guard it.

## Phases
- **P1** ✅ (1.99.3) — v2 `TomlConfig` types + dual parse (v1 back-compat) + exposed constants. 9 tests.
- **P2** ✅ (1.99.4) — `migrateSchemaV1toV2()` + gate + backup + loud validation (not wired to boot). 7 tests.
- **P3** ✅ (1.99.5) — structured toml writers targeting v2 namespaces (kills the un-migration risk). 4 tests.
- **P4 + P5** → the **2.0.0** release (they are coupled — see below).

### Why P4 and P5 must ship together as 2.0.0
Making the bundled toml v2 while a user is still on v1 would let the bundled
`[input]` value override the user's `[compression]` override (different tables,
resolver reads `inp ?? c` → bundled wins). Cross-schema precedence bug.

**Fix (cleaner):** the bundled `squeezr.toml` becomes **pure documentation** — every
option shown commented-out with its default, **no active values** — and the safe
A.2 defaults move into the **code** (`config.ts`). Then nothing in the bundled file
can override a user override, and code defaults supply the safe values.

2.0.0 = one atomic release:
1. Flip code defaults to safe A.2 values: `tool_desc_compress` default `false`→`true`
   (with `tool_desc_expand=true`). Keep OFF: `ai_compression`, `output.enabled`,
   `compress_tool_inputs`. (This is THE observable behaviour change → MAJOR.)
2. Rewrite bundled `squeezr.toml` as fully-commented v2 docs, no active keys.
3. Wire `migrateUserConfigFile()` at startup (index.ts, production-only, explicit —
   never on config import, so tests never migrate the dev's real ~/.squeezr).
   Ordering is safe: migration is effect-preserving, so config built before/after
   it is identical; the write just tidies the file to v2 for next boot.
4. Project-local `./.squeezr.toml` old-schema detection + loud warn (decision B).
5. README + CHANGELOG; version → 2.0.0; `npm install -g .`.

## Decisions (Sergio, 2026-07-21)
- **A. Newly-exposed constants → EXPOSE NOW.** Add `[ai]` rate-limit + min-chars and `[safety]` circuit-breaker/guard/max-deflate keys, defaulting to today's hardcoded values. Their modules (`aiRateLimit`, `circuitBreaker`, `compressionGuard`, `compressibilityProbe`) read from `config` instead of local constants.
- **B. Project-local `./.squeezr.toml` → DETECT + WARN LOUDLY.** Never auto-rewrite a file in an arbitrary cwd. On old-schema detection, print a loud warning with migration instructions and keep reading it via the v1 back-compat shim so nothing breaks.
- **C. Comment strategy → FRESH COMMENTED TEMPLATE.** Emit a new fully-commented v2 toml populated with migrated values; back up the original to `squeezr.toml.v1.bak` (covers any user-authored comments that the template drops).
