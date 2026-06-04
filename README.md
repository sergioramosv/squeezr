# Squeezr

**Token compression proxy for AI coding CLIs.** Sits between your CLI and the API, compresses context on the fly — **without ever breaking Anthropic's prompt cache** — and saves thousands of tokens per session. Real-time dashboard, MCP integration, and an optional AI compression layer powered by **Zest**, Squeezr's own model.

[![npm](https://img.shields.io/npm/v/squeezr-ai)](https://www.npmjs.com/package/squeezr-ai) [![license](https://img.shields.io/npm/l/squeezr-ai)](LICENSE)

## Supported CLIs & apps

| Client | Protocol | Proxy method |
|--------|----------|--------------|
| Claude Code | HTTP to Anthropic API | `ANTHROPIC_BASE_URL=http://localhost:8080` |
| Claude Desktop | HTTP to Anthropic API | Windows: `setx` (via `squeezr setup`); macOS: `launchctl setenv`; Linux: `environment.d` |
| Aider | HTTP to Anthropic/OpenAI API | `ANTHROPIC_BASE_URL` / `openai_base_url` |
| OpenCode | HTTP to Anthropic/OpenAI API | `ANTHROPIC_BASE_URL` / `openai_base_url` |
| Gemini CLI | HTTP to Gemini API | `GEMINI_API_BASE_URL=http://localhost:8080` |
| Ollama | HTTP (local) | Transparent via dummy API key detection |
| Codex Desktop | HTTP to OpenAI API | `~/.codex/config.toml` → `openai_base_url` (via `squeezr setup`) |
| Codex CLI | WebSocket to chatgpt.com | TLS-terminating MITM proxy on :8081 |
| Cursor IDE | HTTP to OpenAI API (BYOK only) | `localhost:8080` directly (CORS) or `squeezr tunnel` |
| Continue (VS Code) | HTTP to OpenAI-compat | `apiBase: http://localhost:8080/v1` |

Works with both API keys and subscription plans (OAuth) — Claude Code Max/Pro, OpenAI Plus, etc.

## Quick start

```bash
npm install -g squeezr-ai
squeezr setup   # env vars, auto-start, CA trust, MCP server — all automatic
squeezr start
```

## Prompt-cache safety (the core design principle)

Anthropic bills cached context at **0.1x** — but only if the request prefix arrives **byte-for-byte identical** between requests. A proxy that mutates history differently on each request silently invalidates that cache and re-bills the full context at full price, costing far more than compression saves.

Squeezr is built around this constraint:

- **Deterministic compression is byte-stable** — same input always produces the same output (fixed-pressure rules), so the cached prefix never changes → Anthropic's cache keeps hitting.
- **Unstable passes never touch the cached prefix** — AI compression, cross-turn dedup, diff-reads and stale-turn summaries only operate past the last `cache_control` marker (or freely for clients that don't use caching).
- **Live cache health monitoring** — the dashboard's *Prompt Cache* card shows `cache_read` vs `cache_creation` tokens and a Hit Health %. Green (≥80%) means you're paying the minimum possible; red means something is invalidating your prefix.

Full write-up: [docs/PROMPT_CACHE.md](docs/PROMPT_CACHE.md)

## How it works

Every request passes through Squeezr on `localhost:8080`. Compression layers, in order:

1. **MCP tool filtering** (opt-in) — drop tool definitions from MCP servers you block (`mcp_block_servers`) or that aren't allow-listed. A single chatty MCP server can cost ~18k tokens *per request*. Servers used in the conversation are never filtered.
2. **Tool description compression** — tool descriptions are truncated to their first paragraph (Bash: 10,441 → 53 chars), with the full spec stored in the expand store. The model retrieves it on demand via `squeezr_expand`. Saves ~17k tokens/request on a stock Claude Code session.
3. **System prompt compression** — skill/plugin duplicate blocks deduplicated; optional AI summarization (gated behind `ai_compression`).
4. **Deterministic preprocessing** — zero-latency regex rules on every tool result: ANSI/progress-bar/timestamp stripping, line dedup, JSON minification, plus ~30 tool-specific patterns (git, vitest/jest, tsc, eslint, cargo, pytest, docker, kubectl, gh…). Byte-stable → cache-safe.
5. **Cross-turn dedup & diff-reads** — repeated tool outputs collapse to references; repeated file reads become diffs against the latest read. (Only past the cache barrier.)
6. **Stale-turn summarization** — conversations >40 turns get old assistant prose collapsed to keyword summaries. (Only for clients without prompt caching.)
7. **AI compression** (opt-in, off by default) — blocks ≥1500 chars summarized by a small model. Measured on real data: 75–91% compression on large blocks. Backends: **Zest (local, free, deterministic)**, Haiku, GPT-4o-mini, Gemini Flash. Guarded by a rate limiter (20 calls/5 min), a persistent on/off toggle, and the cache barrier.

### Recovery: nothing is ever lost

Every compressed block embeds a `squeezr_expand(id)` reference. A `squeezr_expand` tool is injected into each request — if the model needs the original content, it retrieves it in one call. The dashboard tracks expand rate as the compression-quality metric (0 = nothing important was lost).

### Adaptive pressure

Compression aggressiveness scales with context usage: <50% → light (1500-char threshold), 50–75% → normal (800), 75–90% → aggressive (400), >90% → critical (150).

## Web dashboard

`http://localhost:8080/squeezr/dashboard` — 3 pages, SSE-updated:

| Page | What it shows |
|------|---------------|
| **Overview** | All-time tokens saved (single source of truth), ratio + per-request average, cost saved, Top Tools (real per-tool block counts), Session Cache (AI layer), AI Compression card (calls / saved / spent / net), **Prompt Cache health** (read vs creation + hit %), Savings by type (per-technique breakdown), by model (incl. what compression backends spend), by client, compression mode + **Bypass / AI Compression toggles** |
| **Savings** | Day / Week / Month / All-time filters with period navigation — per-period tokens, cost, sessions, charts, By Model / By Client / Top Tools / AI Compression / Session Cache, all persisted across restarts |
| **Settings** | Client base-URL reference, ports, version/uptime, bypass & circuit breaker state, **AI Compression on/off**, **Restart / Stop buttons**, update check |

## Safety & resilience

Squeezr sits in the critical path. It is designed to never break your workflow — and never burn your plan:

- **Bypass mode (persisted)** — one click/command disables all compression; survives restarts. The emergency stop.
- **AI compression master switch (persisted, default OFF)** — with a subscription OAuth token, AI compression calls bill against *your own plan*; only enable it with a separately billed API key or the free local Zest backend.
- **AI rate limiter** — hard cap of 20 AI calls per 5-minute sliding window, process-global.
- **AI minimum block size (1500 chars)** — measured on real data: small blocks *expand* under AI compression; Squeezr never AI-compresses them.
- **Cache barrier** — unstable passes can't touch the cached prefix (see prompt-cache safety above).
- **Circuit breaker** — 3 consecutive AI backend failures → AI compression disabled for 60s, deterministic continues.
- **Atomic persistence** — stats, history, caches and toggles are written atomically (tmp + rename); a crash can't corrupt them.
- **Self-test on startup** — detects port squatting (the classic `$.speed` Claude Code error), env-var drift, and pipeline issues.

## Honest metrics

One source of truth (`~/.squeezr/stats.json`, continuous net counters — never inflated per-session sums):

- **Net saved** = what actually left your requests, after `[squeezr:id]` tag overhead.
- **Savings by type** — deterministic, dedup, tool descriptions, stale turns, AI, MCP filter, system prompt (gross per-technique, labeled as such).
- **AI spend tracking** — every compression backend call's real token usage (input/output, per model) is counted and shown against what it saved.
- **Prompt cache** — `cache_read` vs `cache_creation` from Anthropic's real usage fields. Anthropic's cache discount is shown separately and *not* claimed as Squeezr savings.

## Zest — Squeezr's own compression model

Zest (`zest-0.8b`, fine-tuned from Qwen3.5-0.8B with LoRA) is Squeezr's local compression model: free, runs on CPU via Ollama, and **deterministic in greedy decoding** — which makes AI compression byte-stable and therefore cache-safe. Status: v3 trained (89% eval accuracy), GGUF packaging in progress. Design doc: [docs/REINVENT_AI.md](docs/REINVENT_AI.md)

## MCP server

Installed automatically into Claude Code, Cursor, Windsurf and Cline by `squeezr setup`.

Tools: `squeezr_status`, `squeezr_stats`, `squeezr_set_mode`, `squeezr_config`, `squeezr_habits`, `squeezr_stop`, `squeezr_check_updates`, `squeezr_update`, `squeezr_set_project`, `squeezr_bypass`.

## Configuration

User config lives at **`~/.squeezr/squeezr.toml`** (survives npm updates). A project-local `.squeezr.toml` deep-merges on top.

```toml
[compression]
threshold = 800              # min chars to compress a tool result
keep_recent = 3              # recent tool results never touched
ai_compression = false       # MASTER switch for AI calls — default OFF (see Safety)
compress_system_prompt = true
compress_conversation = true
stale_turns = true           # auto-disabled when prompt-cache markers are present
tool_desc_compress = true    # first-paragraph truncation + expand recovery
tool_desc_expand = true
# mcp_block_servers = ["some-mcp"]   # drop these servers' tools (~18k tok/req each)
# mcp_allow_servers = ["github-mcp"] # if set, only these survive
# skip_tools = ["Read"]              # never compress these tool types
# Per-command: append "# squeezr:skip" to any Bash command to skip its result

[cache]
enabled = true
max_entries = 1000

[adaptive]
enabled = true               # pressure-based thresholds (see Adaptive pressure)

[local]
enabled = true
upstream_url = "http://localhost:11434"
compression_model = "qwen2.5-coder:1.5b"   # or zest-0.8b once published
```

Env vars: `SQUEEZR_PORT`, `SQUEEZR_MITM_PORT`, `SQUEEZR_THRESHOLD`, `SQUEEZR_KEEP_RECENT`, `SQUEEZR_DISABLED`, `SQUEEZR_DRY_RUN`, `SQUEEZR_LOCAL_UPSTREAM`, `SQUEEZR_LOCAL_MODEL`.

## CLI commands

```bash
squeezr setup          # configure everything (env, auto-start, CA, MCP)
squeezr start          # start the proxy
squeezr restart        # stop + start (reloads config)
squeezr stop           # stop the proxy
squeezr update         # install latest from npm + restart
squeezr status         # is it running? version, port, self-test
squeezr logs           # last 50 log lines
squeezr config         # print current config
squeezr ports          # change HTTP / MITM ports
squeezr gain           # all-time savings (--session, --details, --reset)
squeezr discover       # detect installed AI CLIs
squeezr bypass         # toggle bypass (--on / --off) — persisted
squeezr tunnel         # Cloudflare Tunnel (Cursor IDE)
squeezr mcp install    # register MCP server (mcp uninstall to remove)
squeezr desktop start  # separate proxy for Claude/Codex Desktop (stop/status)
squeezr uninstall      # remove completely
squeezr version
```

## REST endpoints

`/squeezr/stats` · `/squeezr/history` · `/squeezr/health` · `/squeezr/bypass` (GET/POST) · `/squeezr/ai-compression` (GET/POST) · `/squeezr/config` · `/squeezr/native-compact` · `/squeezr/control/restart` · `/squeezr/control/stop` · `/squeezr/dashboard`

## Requirements

Node.js ≥18, ~140 MB RAM, no GPU. Full details: [docs/HARDWARE_REQUIREMENTS.md](docs/HARDWARE_REQUIREMENTS.md)

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Internal architecture |
| [docs/PROMPT_CACHE.md](docs/PROMPT_CACHE.md) | How Anthropic's prompt cache works + the 3 cache-breakers we found and fixed |
| [docs/REINVENT_AI.md](docs/REINVENT_AI.md) | Data-driven design of the AI compression layer (Zest) |
| [docs/HARDWARE_REQUIREMENTS.md](docs/HARDWARE_REQUIREMENTS.md) | Measured hardware requirements |
| [docs/TOOLS_ISSUE.md](docs/TOOLS_ISSUE.md) | The 28k-tokens-per-request tool descriptions problem |
| [CHANGELOG.md](CHANGELOG.md) | Full version history |

## Troubleshooting

**Claude Code throws `undefined is not an object (evaluating '$.speed')`** — something that isn't Squeezr is squatting on the port (often a Docker container on 8080). Run `squeezr status`; if it reports a foreign service: `squeezr ports` to move, or stop the offender. `cat ~/.squeezr/runtime.json` shows the actual bound port.

**Dashboard shows 0 AI calls with AI Compression ON** — expected with Claude Code: the prompt-cache barrier leaves nothing safe for AI to compress (everything cacheable is protected, everything recent is preserved). AI compression shines for clients without prompt caching, or via the (upcoming) stable Zest pipeline.

## License

MIT
