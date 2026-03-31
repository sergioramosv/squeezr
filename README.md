# Squeezr

**Squeezr is a local proxy that sits between Claude Code and Anthropic's API and uses Claude Haiku to semantically compress your context window — saving thousands of tokens per session, automatically, with zero changes to your workflow.**

---

## The problem

Every time you send a message in Claude Code, the entire conversation history is re-sent to the API. That includes every file you read, every `git diff`, every test output, every bash command — even from 30 messages ago when it's no longer relevant. Claude Code's system prompt alone weighs ~13KB and gets sent on every single request.

The result: your context fills up fast, costs spike, and sessions hit the limit sooner than they should.

---

## How Squeezr fixes it

Squeezr intercepts every API request before it reaches Anthropic and runs four compression layers:

```
Claude Code
    |
    v
localhost:8080  (Squeezr proxy)
    |
    |-- [1] System prompt compression
    |        First request: Haiku compresses ~13KB system prompt to ~600 tokens
    |        Subsequent requests: cached compressed version used automatically
    |
    |-- [2] Adaptive tool result compression
    |        Old tool results (bash output, file reads, grep, etc.) get
    |        compressed by Haiku. Threshold adjusts based on context pressure:
    |          < 50% full  →  compress blocks > 1,500 chars
    |          50-75% full →  compress blocks > 800 chars
    |          75-90% full →  compress blocks > 400 chars
    |          > 90% full  →  compress blocks > 150 chars (everything possible)
    |
    |-- [3] Compression cache
    |        Already-compressed content is cached to disk.
    |        If the same output appears again (same git status, same error),
    |        Haiku is not called — the cached result is reused instantly.
    |
    |-- [4] Conversation compression (opt-in)
    |        Old user/assistant messages can also be summarized by Haiku,
    |        further reducing long-running session context.
    |
    v
api.anthropic.com
```

Recent content is always preserved untouched — by default the last 3 tool results are never compressed. Claude always has full context for what it's currently working on.

---

## Why not just use /compact?

`/compact` is a nuclear option: it replaces your entire context with a single lossy summary and you lose granularity. Squeezr is surgical — it compresses old, irrelevant content while keeping recent work at full fidelity. You can run a session for hours without ever hitting the context limit.

---

## Why Haiku?

Haiku (claude-haiku-4-5) costs ~25x less than Sonnet. The economics are decisive:

| Action | Cost |
|---|---|
| Haiku compresses a 3,000-token tool result to 150 tokens | ~$0.0001 |
| Saving 2,850 tokens on every subsequent Sonnet request | ~$0.009 saved per request |
| Net savings per compression | ~98% |

For a typical 2-hour coding session with 40+ tool calls, Squeezr can save tens of thousands of tokens at a total Haiku cost of a few cents.

---

## How it differs from RTK

[RTK](https://github.com/rtk-ai/rtk) and Squeezr solve different parts of the same problem. They are complementary, not competing.

| | RTK | Squeezr |
|---|---|---|
| **Where it acts** | Shell layer — filters stdout before it enters context | API layer — compresses what's already accumulated in history |
| **Method** | Static rules and regex patterns | Semantic AI compression via Haiku |
| **What it covers** | Current command output only | All tool results, system prompt, optionally conversation messages |
| **Usage** | Manual — you type `rtk git diff` | Automatic — transparent proxy, nothing changes |
| **Turn 1: git diff** | Filters from 5K to 1K chars | Does nothing (too recent) |
| **Turn 20: that same diff** | Cannot touch it | Compresses it to 200 chars |

**Used together:** RTK reduces what enters context initially. Squeezr compresses what accumulates over time. A typical session without anything: 200K tokens. With RTK: ~130K. With RTK + Squeezr: ~50-60K.

---

## Quick start

### Option A — Installer (recommended)

```bash
# macOS / Linux
bash install.sh

# Windows (PowerShell, run as admin for Task Scheduler)
.\install.ps1
```

The installer sets up dependencies, configures `ANTHROPIC_BASE_URL` in your shell profile, and registers Squeezr as a login service so it starts automatically.

### Option B — Manual

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Start the proxy
python main.py

# 3. Point Claude Code to it (in a new terminal)
export ANTHROPIC_BASE_URL=http://localhost:8080        # macOS / Linux
$env:ANTHROPIC_BASE_URL="http://localhost:8080"        # Windows PowerShell

# 4. Use Claude Code normally
claude
```

---

## Configuration

All settings live in `squeezr.toml`. Environment variables override TOML values.

```toml
[proxy]
port = 8080

[compression]
threshold = 800           # min chars to compress a tool result
keep_recent = 3           # recent tool results to leave untouched
disabled = false
compress_system_prompt = true    # compress Claude Code's system prompt
compress_conversation = false    # also compress old conversation messages

[cache]
enabled = true
max_entries = 1000        # LRU cap

[adaptive]
enabled = true
low_threshold = 1500      # used when context < 50% full
mid_threshold = 800       # 50-75%
high_threshold = 400      # 75-90%
critical_threshold = 150  # > 90% — compress everything
```

### Environment variable overrides

| Variable | Default | Description |
|---|---|---|
| `SQUEEZR_PORT` | `8080` | Local port |
| `SQUEEZR_THRESHOLD` | `800` | Base compression threshold (chars) |
| `SQUEEZR_KEEP_RECENT` | `3` | Recent tool results to skip |
| `SQUEEZR_DISABLED` | — | Set to `1` to disable (passthrough only) |
| `SQUEEZR_DRY_RUN` | — | Set to `1` to preview savings without compressing |

---

## Dry-run mode

Not sure what Squeezr would compress in your sessions? Run it in dry-run mode first:

```bash
# macOS / Linux
SQUEEZR_DRY_RUN=1 python main.py

# Windows PowerShell
$env:SQUEEZR_DRY_RUN="1"; python main.py
```

Console output will show exactly what would be compressed and how many chars would be saved — without touching any requests.

```
[squeezr dry-run] Would compress 4 block(s) | potential -12,430 chars | pressure=67% threshold=800
```

---

## Live stats

While Squeezr is running, each compressed request logs to console:

```
[squeezr] 2 block(s) compressed | -4,821 chars (~1,377 tokens) (87% saved)
[squeezr] Context pressure: 68% -> threshold=800 chars
[squeezr] System prompt compressed: -71% (13,204 -> 3,849 chars) [cached]
```

### `gain.py` — full stats dashboard

```bash
python gain.py
```

```
════════════════════════════════════════════════════════════
  Squeezr Token Savings  (live session)
════════════════════════════════════════════════════════════
  Total requests:    38
  Compressions:      91
  Chars saved:       142,830  (~40,808 tokens)
  Savings:           73.4%
  Efficiency meter:  █████████████████░░░░░░░ 73.4%

  By Tool
  ────────────────────────────────────────────────────────
  #   Tool              Count    Saved    Avg%
  ────────────────────────────────────────────────────────
  1   Bash                 41   89.2K     81%  ████████░░
  2   Read                 28   38.1K     74%  ███████░░░
  3   Grep                 14   12.4K     69%  ██████░░░░
  4   conversation          8    3.1K     61%  ██████░░░░
  ────────────────────────────────────────────────────────
```

Stats persist to `~/.squeezr/stats.json` across proxy restarts.

```bash
python gain.py --reset   # clear all saved stats
```

Full JSON summary at: `http://localhost:8080/squeezr/stats`

---

## Auto-start

The installer configures Squeezr to start automatically on login:

| OS | Method |
|---|---|
| macOS | launchd (`~/Library/LaunchAgents/com.squeezr.plist`) |
| Linux | systemd user service (`~/.config/systemd/user/squeezr.service`) |
| Windows | Task Scheduler task (runs at login, restarts on failure) |

To stop auto-start:
```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.squeezr.plist

# Linux
systemctl --user disable squeezr && systemctl --user stop squeezr

# Windows PowerShell
Unregister-ScheduledTask -TaskName "Squeezr" -Confirm:$false
```

---

## Requirements

- Python 3.9+
- An Anthropic API key
- Claude Code (or any tool using the Anthropic SDK)

---

## Endpoints

| Endpoint | Description |
|---|---|
| `POST /v1/messages` | Main proxy — compresses and forwards |
| `GET /squeezr/stats` | JSON session stats including cache hit rate |
| `GET /squeezr/health` | Health check |
| `* /{path}` | All other Anthropic endpoints forwarded unmodified |

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
