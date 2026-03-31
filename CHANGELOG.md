# Changelog

All notable changes to Squeezr will be documented here.

## [0.3.0] - 2026-03-31

### Added
- **System prompt compression** — Haiku compresses Claude Code's ~13KB system prompt on first request and caches it. Estimated -40% per request.
- **Adaptive thresholds** — compression aggressiveness scales with context pressure: low/mid/high/critical tiers based on % of context used
- **Compression cache** — repeated tool results are served from `~/.squeezr/cache.json` at zero Haiku cost. Hit rate shown in `/squeezr/stats`
- **Conversation compression** — opt-in (`compress_conversation = true` in `squeezr.toml`) to also compress old user/assistant messages
- **Auto-start on login** — `install.sh` configures launchd (macOS) or systemd (Linux); `install.ps1` registers a Windows Task Scheduler task
- **`squeezr.toml` config file** — all settings editable in TOML, env vars still override
- **Dry-run mode** — set `SQUEEZR_DRY_RUN=1` to see what would be compressed without modifying requests
- Cache stats (`size`, `hits`, `misses`, `hit_rate_pct`) exposed in `/squeezr/stats`
- Context pressure logged when above 50%

### Changed
- `config.py` reads from `squeezr.toml` first, env vars override
- `requirements.txt` adds `tomli` for Python < 3.11
- Version bumped to 0.3.0

## [0.2.0] - 2026-03-31

### Added
- `gain.py` CLI command — shows token savings with breakdown by tool (Bash, Read, Grep, etc.)
- Per-tool savings tracking in stats (count, chars saved, avg compression %)
- Efficiency bar visualization (24-char block meter)
- Stats persistence to `~/.squeezr/stats.json` across proxy restarts
- `--reset` flag for `gain.py` to clear saved stats
- Tool name extraction from `tool_use` blocks to enrich compression reporting

### Changed
- `stats.py` now tracks `by_tool` breakdown per request
- `compressor.py` now returns tool names alongside savings data
- Version bumped to 0.2.0

## [0.1.0] - 2026-03-31

### Added
- Local API proxy that intercepts Claude Code requests to Anthropic API
- Semantic compression of old tool results using Claude Haiku
- Configurable compression threshold (`SQUEEZR_THRESHOLD`, default 800 chars)
- Configurable recent context preservation (`SQUEEZR_KEEP_RECENT`, default 3 tool results)
- Real-time per-request savings logging to console
- `/squeezr/stats` endpoint for session summary
- `/squeezr/health` endpoint
- Catch-all route to forward any Anthropic endpoint without modification
- Full streaming support (SSE passthrough)
- `install.sh` for macOS/Linux
- `install.ps1` for Windows
