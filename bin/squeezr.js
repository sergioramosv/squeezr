#!/usr/bin/env node

import { spawn, execSync } from 'child_process'
import http from 'http'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const ROOT = path.join(__dirname, '..')
const pkg = require(path.join(ROOT, 'package.json'))

const args = process.argv.slice(2)
const command = args[0]

// ── update check (non-blocking) ───────────────────────────────────────────────

const UPDATE_CHECK_FILE = path.join(os.homedir(), '.squeezr', 'update-check.json')
const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000 // 4 hours

// Fire and forget — runs in background, never blocks CLI
// Convert semver string to comparable number (major*1M + minor*1k + patch)
function semverToNum(v) {
  if (!v || typeof v !== 'string') return 0
  const parts = v.split('.').map(p => parseInt(p) || 0)
  return (parts[0] || 0) * 1000000 + (parts[1] || 0) * 1000 + (parts[2] || 0)
}

// Returns the npm version IF it's strictly newer than the local version, else null
function newerVersionOrNull(latest) {
  if (!latest || latest === pkg.version) return null
  return semverToNum(latest) > semverToNum(pkg.version) ? latest : null
}

const updateCheckPromise = (async () => {
  try {
    // Read cached check
    let cached = null
    try { cached = JSON.parse(fs.readFileSync(UPDATE_CHECK_FILE, 'utf-8')) } catch {}
    if (cached && Date.now() - cached.checkedAt < UPDATE_CHECK_INTERVAL) {
      return newerVersionOrNull(cached.latest)
    }
    // Fetch latest from npm (with timeout)
    const { get } = await import('https')
    const latest = await new Promise((resolve, reject) => {
      const req = get('https://registry.npmjs.org/squeezr-ai/latest', { timeout: 3000 }, res => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(data).version) } catch { resolve(null) }
        })
      })
      req.on('error', () => resolve(null))
      req.setTimeout(3000, () => { req.destroy(); resolve(null) })
    })
    if (!latest) return null
    // Cache result
    const dir = path.dirname(UPDATE_CHECK_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(UPDATE_CHECK_FILE, JSON.stringify({ latest, checkedAt: Date.now() }))
    return newerVersionOrNull(latest)
  } catch { return null }
})()

async function showUpdateBanner() {
  try {
    const latest = await Promise.race([updateCheckPromise, new Promise(r => setTimeout(() => r(null), 500))])
    if (latest) {
      console.log('')
      console.log(`  ╭─────────────────────────────────────────────────────────╮`)
      console.log(`  │  Update available: v${pkg.version} → v${latest}${' '.repeat(Math.max(0, 30 - pkg.version.length - latest.length))}│`)
      console.log(`  │  Run: squeezr update                                   │`)
      console.log(`  ╰─────────────────────────────────────────────────────────╯`)
    }
  } catch {}
}

function getPortFromToml() {
  try {
    const toml = fs.readFileSync(path.join(ROOT, 'squeezr.toml'), 'utf-8')
    const m = toml.match(/^port\s*=\s*(\d+)/m)
    if (m) return parseInt(m[1])
  } catch {}
  return null
}

// Runtime info written by src/index.ts after a successful listen(). Reflects
// the *actual* bound port, which may differ from squeezr.toml when findFreePort
// drifted because the configured port was occupied.
const RUNTIME_FILE = path.join(os.homedir(), '.squeezr', 'runtime.json')

function readRuntimeInfo() {
  try { return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf-8')) } catch { return null }
}

function getMitmPort(port) {
  const envMitm = process.env.SQUEEZR_MITM_PORT
  if (envMitm) return parseInt(envMitm)
  const runtime = readRuntimeInfo()
  if (runtime && runtime.mitmPort) return runtime.mitmPort
  try {
    const toml = fs.readFileSync(path.join(ROOT, 'squeezr.toml'), 'utf-8')
    const m = toml.match(/^mitm_port\s*=\s*(\d+)/m)
    if (m) return parseInt(m[1])
  } catch {}
  return Number(port) + 1
}

function getPort() {
  if (process.env.SQUEEZR_PORT) return parseInt(process.env.SQUEEZR_PORT)
  const runtime = readRuntimeInfo()
  if (runtime && runtime.port) return runtime.port
  return getPortFromToml() || 8080
}

/**
 * Verifies that whatever is listening on `port` is actually a squeezr instance
 * (by checking the magic `identity` field in /squeezr/health), not an unrelated
 * HTTP service that happens to answer 200. Returns the parsed health JSON, or
 * null if the port is free, unreachable, or owned by a foreign service.
 */
function probeSqueezr(port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/squeezr/health' }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null)
        try {
          const json = JSON.parse(data)
          if (json && json.identity === 'squeezr') return resolve(json)
        } catch {}
        resolve(null)
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
  })
}

/**
 * Install/update shell wrapper functions so env vars are auto-refreshed
 * after squeezr start/setup/update (child processes can't modify parent env).
 */
function installShellWrapper() {
  if (process.platform === 'win32') return installPowerShellWrapper()
  if (isWSL() || process.platform === 'linux' || process.platform === 'darwin') return installBashWrapper()
}

function installBashWrapper() {
  const port = getPort()
  const bundlePath = path.join(os.homedir(), '.squeezr', 'mitm-ca', 'bundle.crt')
  const marker = '# squeezr shell wrapper'
  const endMarker = '# end squeezr shell wrapper'
  const wrapper = `${marker}
squeezr() {
  command squeezr "$@"
  case "$1" in
    start|setup|update)
      export ANTHROPIC_BASE_URL=http://localhost:${port}
      export GEMINI_API_BASE_URL=http://localhost:${port}
      export NODE_EXTRA_CA_CERTS=${bundlePath}
      ;;
  esac
}
${endMarker}`

  const profiles = [
    path.join(os.homedir(), '.bashrc'),
    path.join(os.homedir(), '.zshrc'),
  ]
  let installed = false
  for (const p of profiles) {
    if (!fs.existsSync(p)) continue
    try {
      const content = fs.readFileSync(p, 'utf-8')
      if (!content.includes(marker)) {
        fs.appendFileSync(p, `\n${wrapper}\n`)
        console.log(`  [ok] Shell wrapper added to ${p}`)
        installed = true
      } else {
        const updated = content.replace(new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), wrapper)
        fs.writeFileSync(p, updated)
        console.log(`  [ok] Shell wrapper updated in ${p}`)
      }
    } catch {}
  }
  if (installed) {
    console.log('')
    console.log('  ╔═══════════════════════════════════════════════════════════════╗')
    console.log('  ║  ONE-TIME SETUP: Close this terminal and open a new one.     ║')
    console.log('  ║  This loads the wrapper that auto-refreshes env vars.        ║')
    console.log('  ║  After that, you will NEVER need to do this again.           ║')
    console.log('  ╚═══════════════════════════════════════════════════════════════╝')
  }
}

function installPowerShellWrapper() {
  try {
    const psProfilePath = execSync('powershell -NoProfile -Command "[Environment]::GetFolderPath(\'MyDocuments\') + \'\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1\'"', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    const psProfileDir = path.dirname(psProfilePath)
    if (!fs.existsSync(psProfileDir)) fs.mkdirSync(psProfileDir, { recursive: true })
    const psMarker = '# squeezr wrapper'
    const psLines = []
    psLines.push(psMarker)
    psLines.push('function squeezr {')
    psLines.push('  & squeezr.cmd @args')
    psLines.push('  if (@("start","setup","update") -contains $args[0]) {')
    psLines.push('    foreach ($k in @("ANTHROPIC_BASE_URL","GEMINI_API_BASE_URL","NODE_EXTRA_CA_CERTS")) {')
    psLines.push('      $val = [Environment]::GetEnvironmentVariable($k, "User")')
    psLines.push('      if ($val) { [Environment]::SetEnvironmentVariable($k, $val, "Process") }')
    psLines.push('    }')
    psLines.push('  }')
    psLines.push('}')
    psLines.push('# end squeezr wrapper')
    const psFunction = psLines.join('\r\n')
    const existing = fs.existsSync(psProfilePath) ? fs.readFileSync(psProfilePath, 'utf-8') : ''
    if (!existing.includes(psMarker)) {
      fs.appendFileSync(psProfilePath, `\n${psFunction}\n`)
      console.log(`  [ok] PowerShell wrapper added to ${psProfilePath}`)
      console.log('')
      console.log('  ╔═══════════════════════════════════════════════════════════════╗')
      console.log('  ║  ONE-TIME SETUP: Close this terminal and open a new one.     ║')
      console.log('  ║  This loads the wrapper that auto-refreshes env vars.        ║')
      console.log('  ║  After that, you will NEVER need to do this again.           ║')
      console.log('  ╚═══════════════════════════════════════════════════════════════╝')
    } else {
      const updated = existing.replace(/# squeezr wrapper[\s\S]*?# end squeezr wrapper/, psFunction)
      fs.writeFileSync(psProfilePath, updated)
      console.log(`  [ok] PowerShell wrapper updated in ${psProfilePath}`)
    }
  } catch {
    console.log(`  [skip] PowerShell profile wrapper could not be installed`)
  }
}

const HELP = `
Squeezr v${pkg.version} — AI context compressor for Claude Code, Codex, Aider, Gemini CLI and Ollama

Usage:
  squeezr                  Start the proxy (default)
  squeezr start            Start the proxy
  squeezr setup            One-time setup: auto-start on login + configure all CLIs
  squeezr stop             Stop the running proxy
  squeezr logs             Show last 50 lines of the log file
  squeezr gain             Show token savings stats
  squeezr gain --reset     Reset saved stats
  squeezr discover         Show pattern coverage report (proxy must be running)
  squeezr status           Check if proxy is running
  squeezr config           Print config file path and current settings
  squeezr mcp install      Register Squeezr MCP server in Claude Code, Cursor, Windsurf & Cline
  squeezr mcp uninstall    Remove Squeezr MCP registration
  squeezr ports            Change HTTP and MITM proxy ports
  squeezr tunnel           Expose proxy via Cloudflare Tunnel for Cursor IDE
  squeezr enable-claude-desktop   Enable hosts-file redirect for Claude Desktop (admin once)
  squeezr disable-claude-desktop  Disable hosts-file redirect for Claude Desktop
  squeezr desktop start    Start SEPARATE proxy for Claude/Codex Desktop (ports 8443+8088)
  squeezr desktop stop     Stop the desktop proxy (does NOT affect main proxy)
  squeezr desktop status   Show desktop proxy status
  squeezr bypass           Toggle bypass mode (skip compression, keep logging)
  squeezr bypass --on      Enable bypass (disable compression)
  squeezr bypass --off     Disable bypass (resume compression)
  squeezr update           Kill old processes, install latest from npm, restart
  squeezr uninstall        Remove Squeezr completely (env vars, CA, auto-start, logs)
  squeezr version          Print version
  squeezr help             Show this help
`

function runNode(script, extraArgs = []) {
  const distPath = path.join(ROOT, 'dist', script)
  if (!fs.existsSync(distPath)) {
    console.error(`Error: ${distPath} not found. Run 'npm run build' first.`)
    process.exit(1)
  }
  const child = spawn(process.execPath, [distPath, ...extraArgs], {
    stdio: 'inherit',
    cwd: ROOT,
  })
  child.on('exit', code => process.exit(code ?? 0))
}

async function startDaemon() {
  const distIndex = path.join(ROOT, 'dist', 'index.js')
  if (!fs.existsSync(distIndex)) {
    console.error(`Error: ${distIndex} not found. Run 'npm run build' first.`)
    process.exit(1)
  }

  // Check if already running — and if the version matches. We use probeSqueezr
  // (which validates the `identity` field) so we don't mistake an unrelated
  // HTTP service squatting on this port for a real squeezr instance.
  const port = getPort()
  const running = await probeSqueezr(port)
  const runningVersion = running ? running.version : null
  if (runningVersion) {
    if (runningVersion === pkg.version) {
      const mitmPort = getMitmPort(port)
      console.log(`Squeezr is already running (v${pkg.version})`)
      console.log(`  HTTP proxy (Claude/Aider/Gemini): http://localhost:${port}`)
      console.log(`  MITM proxy (Codex):               http://localhost:${mitmPort}`)
      console.log(`  Dashboard:                        http://localhost:${port}/squeezr/dashboard`)
      return
    }
    // Version mismatch — old process from before npm update. Kill and restart.
    console.log(`Squeezr v${runningVersion} is running but v${pkg.version} is installed. Restarting...`)
    stopProxy()
    // Wait for ports to free up
    await new Promise(r => setTimeout(r, 1500))
  }

  // Launch detached background process
  const logDir = path.join(os.homedir(), '.squeezr')
  const logFile = path.join(logDir, 'squeezr.log')
  fs.mkdirSync(logDir, { recursive: true })
  const logFd = fs.openSync(logFile, 'a')
  const child = spawn(process.execPath, [distIndex], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    cwd: ROOT,
    env: { ...process.env, SQUEEZR_DAEMON: '1' },
  })
  child.unref()
  fs.closeSync(logFd)
  const mitmPort = getMitmPort(port)
  console.log(`Squeezr started (pid ${child.pid})`)
  console.log(`  HTTP proxy (Claude/Aider/Gemini): http://localhost:${port}`)
  console.log(`  MITM proxy (Codex):               http://localhost:${mitmPort}`)
  console.log(`  Dashboard:                        http://localhost:${port}/squeezr/dashboard`)
  console.log(`  Logs: ${logFile}`)

  // ── Also start the SEPARATE Desktop proxy (independent process) ────────────
  // This is the proxy that serves Claude Desktop and Codex Desktop. It runs in
  // its own Node process on ports 8443 + 8088. If it crashes, the main proxy
  // (just started above) keeps running. Failures here are non-fatal — we just
  // warn and continue.
  try {
    await desktopProxyStart()
  } catch (e) {
    console.warn(`Desktop proxy did not start: ${e?.message ?? e}`)
    console.warn(`(The main proxy is fine. Try \`squeezr desktop start\` separately.)`)
  }
}

function showLogs() {
  const logFile = path.join(os.homedir(), '.squeezr', 'squeezr.log')
  if (!fs.existsSync(logFile)) {
    console.log('No log file yet. Run: squeezr setup')
    return
  }
  // Show last 50 lines
  const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean)
  const tail = lines.slice(-50)
  if (tail.length === 0) {
    console.log('Log file is empty — no requests yet.')
    return
  }
  console.log(`=== ${logFile} (last ${tail.length} lines) ===\n`)
  console.log(tail.join('\n'))
}

function killMcpProcesses() {
  if (process.platform === 'win32') {
    try {
      execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='node.exe'\\" | Where-Object { $_.CommandLine -like '*squeezr*mcp*' -or $_.CommandLine -like '*mcp.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
        { stdio: 'pipe' }
      )
    } catch {}
  } else {
    try { execSync(`pkill -f 'squeezr.*mcp' 2>/dev/null`, { stdio: 'pipe' }) } catch {}
    try { execSync(`pkill -f 'mcp\\.js' 2>/dev/null`, { stdio: 'pipe' }) } catch {}
  }
}

function stopProxy() {
  const port = getPort()
  const mitmPort = getMitmPort(port)

  // ── Step 0: Stop the SEPARATE Desktop proxy first (independent process) ────
  // It has its own PID file. Failure here doesn't block main-proxy shutdown.
  try {
    const desktopPid = readDesktopPid()
    if (desktopPid) {
      try { process.kill(desktopPid, 'SIGTERM') } catch {}
      // Give it a moment to exit gracefully
      for (let i = 0; i < 20; i++) {
        try { process.kill(desktopPid, 0) } catch { break }
        execSync(process.platform === 'win32' ? `ping -n 1 127.0.0.1 > nul` : `sleep 0.1`, { stdio: 'pipe' })
      }
      try { process.kill(desktopPid, 'SIGKILL') } catch {}
      try { fs.unlinkSync(DESKTOP_PID_FILE) } catch {}
      // Also clean up any orphan listeners on the desktop ports
      for (const dp of [DESKTOP_HTTPS_PORT, DESKTOP_HTTP_PORT]) {
        try {
          if (process.platform === 'win32') {
            const out = execSync(`netstat -ano | findstr ":${dp} "`, { encoding: 'utf-8', stdio: 'pipe' })
            const matches = [...out.matchAll(/LISTENING\s+(\d+)/g)]
            for (const m of matches) {
              try { execSync(`taskkill /F /PID ${m[1]}`, { stdio: 'pipe' }) } catch {}
            }
          } else {
            try { execSync(`lsof -ti :${dp} -sTCP:LISTEN | xargs -r kill -9`, { stdio: 'pipe' }) } catch {}
          }
        } catch {}
      }
    }
  } catch {}

  // ── Step 1: Graceful shutdown via HTTP — persists history/cache before exit ──
  // /squeezr/control/stop emits SIGTERM which calls persistAndExit().
  // This prevents losing the current session's savings history on stop.
  let gracefulOk = false
  try {
    const req = http.request({ hostname: 'localhost', port, path: '/squeezr/control/stop', method: 'POST', timeout: 2000 })
    req.on('error', () => {})
    req.end()
    gracefulOk = true
    // Give the process time to persist and exit cleanly
    execSync(process.platform === 'win32'
      ? `ping -n 2 127.0.0.1 > nul`  // ~1s sleep on Windows
      : `sleep 1`, { stdio: 'pipe' })
  } catch {}

  // ── Step 2: Force-kill anything still listening (fallback) ──────────────────
  const ports = [port, mitmPort]
  let killed = gracefulOk  // count graceful as "killed"

  for (const p of ports) {
    try {
      let pids = []
      if (process.platform === 'win32') {
        const out = execSync(`netstat -ano | findstr ":${p} "`, { encoding: 'utf-8', stdio: 'pipe' })
        const matches = [...out.matchAll(/LISTENING\s+(\d+)/g)]
        pids = [...new Set(matches.map(m => m[1]))]
      } else {
        try {
          const out = execSync(`lsof -ti :${p} -sTCP:LISTEN`, { encoding: 'utf-8', stdio: 'pipe' }).trim()
          pids = out.split(/\s+/).filter(Boolean)
        } catch {
          try {
            const out = execSync(`fuser ${p}/tcp 2>/dev/null`, { encoding: 'utf-8', stdio: 'pipe' }).trim()
            pids = out.split(/\s+/).filter(Boolean)
          } catch {}
        }
      }
      for (const pid of pids) {
        try {
          if (process.platform === 'win32') {
            execSync(`taskkill /F /PID ${pid}`, { stdio: 'pipe' })
          } else {
            execSync(`kill -9 ${pid}`, { stdio: 'pipe' })
          }
          killed = true
        } catch {}
      }
    } catch {}
  }

  // Also stop the MCP server process
  killMcpProcesses()

  // Clear HTTPS_PROXY so npm and other tools don't try to use the dead proxy
  if (process.platform === 'win32') {
    try { execSync('setx HTTPS_PROXY ""', { stdio: 'pipe' }) } catch {}
  } else if (isWSL()) {
    try {
      const setxExe = '/mnt/c/Windows/System32/setx.exe'
      if (fs.existsSync(setxExe)) execSync(`"${setxExe}" HTTPS_PROXY ""`, { stdio: 'pipe' })
    } catch {}
  }

  if (killed) {
    console.log(`Squeezr stopped`)
  } else {
    console.log(`Squeezr is not running`)
  }
}

async function checkStatus() {
  const port = getPort()
  const mitmPort = getMitmPort(port)
  const json = await probeSqueezr(port, 2000)
  if (!json) {
    // Distinguish "nothing here" from "something foreign here" so the user gets
    // an actionable error instead of a misleading "not running".
    const occupied = await new Promise(resolve => {
      const req = http.get(`http://localhost:${port}/`, res => {
        resolve({ status: res.statusCode, server: res.headers.server })
        res.resume()
      })
      req.on('error', () => resolve(null))
      req.setTimeout(1500, () => { req.destroy(); resolve(null) })
    })
    if (occupied) {
      console.log(`Squeezr is NOT running on port ${port}, but a foreign service is.`)
      console.log(`  Foreign response: HTTP ${occupied.status}${occupied.server ? ` (Server: ${occupied.server})` : ''}`)
      console.log(`  Stop it or change squeezr.toml port, then run: squeezr start`)
    } else {
      console.log(`Squeezr is NOT running`)
      console.log('Start it with: squeezr start')
    }
    return false
  }
  console.log(`Squeezr is running  (v${json.version})`)
  console.log(`  HTTP proxy (Claude Code, Claude Desktop, Codex Desktop, Aider, Gemini): http://localhost:${port}`)
  console.log(`  MITM proxy (Codex CLI TLS):  http://localhost:${mitmPort}`)
  console.log(`  Dashboard:                   http://localhost:${port}/squeezr/dashboard`)
  if (json.mode) console.log(`  Mode:     ${json.mode}`)
  if (json.uptime_seconds != null) {
    const s = json.uptime_seconds
    const fmt = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s/60)}m ${s%60}s` : `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`
    console.log(`  Uptime:   ${fmt}`)
  }
  if (json.bypassed) console.log(`  ⚠ Bypass mode is ON (compression disabled)`)
  if (json.circuit_breaker) {
    const cb = json.circuit_breaker
    const icons = { closed: '🟢 OK', open: '🔴 OPEN', 'half-open': '🟡 PROBING' }
    console.log(`  Circuit:  ${icons[cb.state] || cb.state}${cb.total_trips ? ` (${cb.total_trips} trip${cb.total_trips > 1 ? 's' : ''})` : ''}`)
  }
  return true
}

function showConfig() {
  const tomlPath = path.join(ROOT, 'squeezr.toml')
  console.log(`Config file: ${tomlPath}`)
  if (fs.existsSync(tomlPath)) {
    console.log('\nCurrent config:')
    console.log(fs.readFileSync(tomlPath, 'utf-8'))
  } else {
    console.log('No squeezr.toml found. Using defaults.')
  }
}


// ── squeezr mcp ───────────────────────────────────────────────────────────────

async function mcpInstall() {
  const mcpServerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'mcp.js')
  const entry = {
    type: 'stdio',
    command: 'node',
    args: [mcpServerPath],
  }

  // Claude Desktop config path varies by platform
  const claudeDesktopConfig = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json')

  const targets = [
    {
      name: 'Claude Code',
      file: path.join(os.homedir(), '.claude.json'),
      key: 'mcpServers',
    },
    {
      name: 'Claude Desktop',
      file: claudeDesktopConfig,
      key: 'mcpServers',
    },
    {
      name: 'Cursor',
      file: path.join(os.homedir(), '.cursor', 'mcp.json'),
      key: 'mcpServers',
    },
    {
      name: 'Windsurf',
      file: path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
      key: 'mcpServers',
    },
    {
      name: 'Cline / Roo-Cline',
      file: path.join(os.homedir(), '.vscode', 'extensions', 'mcp_settings.json'),
      key: 'mcpServers',
    },
  ]

  let installed = 0

  for (const target of targets) {
    try {
      // Only install into configs that already exist (user has that tool)
      if (!fs.existsSync(target.file) && target.name !== 'Claude Code') continue

      let cfg = {}
      if (fs.existsSync(target.file)) {
        try { cfg = JSON.parse(fs.readFileSync(target.file, 'utf-8')) } catch { cfg = {} }
      }
      cfg[target.key] = cfg[target.key] || {}
      cfg[target.key].squeezr = entry

      const dir = path.dirname(target.file)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(target.file, JSON.stringify(cfg, null, 2))
      installed++
      console.log()
      console.log('  ok ' + target.name + ': ' + target.file)
    } catch (e) {
      console.warn()
      console.warn('  warn ' + target.name + ': ' + (e.message || e))
    }
  }

  console.log()
  console.log('MCP server registered in ' + installed + ' client(s).')
  console.log('Server binary: ' + mcpServerPath)
  console.log('')
  console.log('Available tools in Claude Desktop, Claude Code, Codex Desktop, Cursor…:')
  console.log('  squeezr_status         — Check if Squeezr is running')
  console.log('  squeezr_stats          — Real-time token savings')
  console.log('  squeezr_set_mode       — Change compression aggressiveness')
  console.log('  squeezr_config         — Current configuration')
  console.log('  squeezr_habits         — Wasteful pattern report')
  console.log('  squeezr_open_dashboard — Open the Squeezr dashboard in your browser')
}

async function mcpUninstall() {
  const claudeDesktopConfig = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json')
  const files = [
    path.join(os.homedir(), '.claude.json'),
    claudeDesktopConfig,
    path.join(os.homedir(), '.cursor', 'mcp.json'),
    path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    path.join(os.homedir(), '.vscode', 'extensions', 'mcp_settings.json'),
  ]
  let removed = 0
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (cfg.mcpServers?.squeezr) {
        delete cfg.mcpServers.squeezr
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
        console.log()
        removed++
      }
    } catch { /* ignore */ }
  }
  if (removed === 0) console.log('Squeezr MCP not found in any config.')
  else console.log()
}

// ── squeezr ports ─────────────────────────────────────────────────────────────

async function configurePorts() {
  const { createInterface } = await import('readline')
  const tomlPath = path.join(ROOT, 'squeezr.toml')
  let tomlContent = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, 'utf-8') : ''

  // Read current ports from toml
  const portMatch = tomlContent.match(/^port\s*=\s*(\d+)/m)
  const mitmMatch = tomlContent.match(/^mitm_port\s*=\s*(\d+)/m)
  const currentPort = portMatch ? parseInt(portMatch[1]) : 8080
  const currentMitm = mitmMatch ? parseInt(mitmMatch[1]) : currentPort + 1

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q) => new Promise(resolve => rl.question(q, resolve))

  console.log(`\nCurrent ports:`)
  console.log(`  HTTP proxy (Claude/Aider/Gemini): ${currentPort}`)
  console.log(`  MITM proxy (Codex):               ${currentMitm}`)
  console.log(`  Dashboard:                        ${currentPort}/squeezr/dashboard  (same port as proxy)\n`)

  const newPort = await ask(`HTTP proxy port [${currentPort}]: `)
  const newMitm = await ask(`MITM proxy port [${currentMitm}]: `)
  rl.close()

  const finalPort = newPort.trim() ? parseInt(newPort.trim()) : currentPort
  const finalMitm = newMitm.trim() ? parseInt(newMitm.trim()) : currentMitm

  if (isNaN(finalPort) || isNaN(finalMitm) || finalPort < 1 || finalMitm < 1 || finalPort > 65535 || finalMitm > 65535) {
    console.error('Invalid port number. Must be between 1 and 65535.')
    process.exit(1)
  }
  if (finalPort === finalMitm) {
    console.error('HTTP and MITM ports must be different.')
    process.exit(1)
  }

  // Update toml
  if (portMatch) {
    tomlContent = tomlContent.replace(/^port\s*=\s*\d+/m, `port = ${finalPort}`)
  } else if (tomlContent.includes('[proxy]')) {
    tomlContent = tomlContent.replace('[proxy]', `[proxy]\nport = ${finalPort}`)
  } else {
    tomlContent = `[proxy]\nport = ${finalPort}\n` + tomlContent
  }

  if (mitmMatch) {
    tomlContent = tomlContent.replace(/^mitm_port\s*=\s*\d+/m, `mitm_port = ${finalMitm}`)
  } else {
    // Add after port line
    tomlContent = tomlContent.replace(/^(port\s*=\s*\d+)/m, `$1\nmitm_port = ${finalMitm}`)
  }

  fs.writeFileSync(tomlPath, tomlContent)
  console.log(`\nSaved to ${tomlPath}`)

  // Update env vars
  if (process.platform === 'win32') {
    try { execSync(`setx SQUEEZR_PORT "${finalPort}"`, { stdio: 'pipe' }) } catch {}
    try { execSync(`setx SQUEEZR_MITM_PORT "${finalMitm}"`, { stdio: 'pipe' }) } catch {}
    try { execSync(`setx ANTHROPIC_BASE_URL "http://localhost:${finalPort}"`, { stdio: 'pipe' }) } catch {}
    try { execSync(`setx GEMINI_API_BASE_URL "http://localhost:${finalPort}"`, { stdio: 'pipe' }) } catch {}
    console.log('Environment variables updated. Restart your terminal for changes to take effect.')
  } else {
    // Update shell profiles directly
    const profiles = [
      path.join(os.homedir(), '.zshrc'),
      path.join(os.homedir(), '.bashrc'),
      path.join(os.homedir(), '.bash_profile'),
    ]
    const envBlock = [
      `export SQUEEZR_PORT=${finalPort}`,
      `export SQUEEZR_MITM_PORT=${finalMitm}`,
      `export ANTHROPIC_BASE_URL=http://localhost:${finalPort}`,
      `export GEMINI_API_BASE_URL=http://localhost:${finalPort}`,
    ].join('\n')
    for (const p of profiles) {
      try {
        let content = fs.readFileSync(p, 'utf-8')
        if (content.includes('# squeezr env vars')) {
          // Replace existing block (from marker to the closing fi)
          content = content.replace(
            /# squeezr env vars[\s\S]*?(?:fi|unset -f _squeezr_alive)/,
            `# squeezr env vars\n${envBlock}\n# squeezr auto-heal (validates identity, not just HTTP 200)\n_squeezr_alive() {\n  curl -sf --max-time 2 "http://localhost:${finalPort}/squeezr/health" 2>/dev/null | grep -q '"identity":"squeezr"'\n}\nif ! _squeezr_alive; then squeezr start > /dev/null 2>&1; fi\nunset -f _squeezr_alive`
          )
          fs.writeFileSync(p, content)
          console.log(`  [ok] Updated ${p}`)
        }
      } catch {}
    }
    // Also update env for WSL setx if on WSL
    try {
      const procVersion = fs.readFileSync('/proc/version', 'utf-8')
      if (/microsoft|wsl/i.test(procVersion)) {
        const setx = '/mnt/c/Windows/System32/setx.exe'
        try { execSync(`"${setx}" SQUEEZR_PORT "${finalPort}"`, { stdio: 'pipe' }) } catch {}
        try { execSync(`"${setx}" SQUEEZR_MITM_PORT "${finalMitm}"`, { stdio: 'pipe' }) } catch {}
        try { execSync(`"${setx}" ANTHROPIC_BASE_URL "http://localhost:${finalPort}"`, { stdio: 'pipe' }) } catch {}
        try { execSync(`"${setx}" GEMINI_API_BASE_URL "http://localhost:${finalPort}"`, { stdio: 'pipe' }) } catch {}
      }
    } catch {}
  }

  // Apply to current process so stop/start works immediately
  process.env.SQUEEZR_PORT = String(finalPort)
  process.env.SQUEEZR_MITM_PORT = String(finalMitm)
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${finalPort}`

  // Auto stop + start
  console.log('')
  stopProxy()
  await new Promise(r => setTimeout(r, 1500))
  await startDaemon()
  console.log(`\nOpen a new terminal for env vars to apply to other tools.`)
}

// ── squeezr uninstall ─────────────────────────────────────────────────────────

async function uninstall() {
  const { createInterface } = await import('readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise(resolve => rl.question(
    'This will remove Squeezr completely: stop proxy, remove env vars, CA certs, auto-start, config, and logs.\nContinue? [y/N] ', resolve
  ))
  rl.close()
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('Cancelled.')
    return
  }

  console.log('\nUninstalling Squeezr...\n')

  // 1. Stop proxy
  stopProxy()

  // 2. Remove env vars
  if (process.platform === 'win32') {
    const vars = ['ANTHROPIC_BASE_URL', 'GEMINI_API_BASE_URL', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'SQUEEZR_PORT', 'SQUEEZR_MITM_PORT', 'openai_base_url', 'NO_PROXY']
    for (const v of vars) {
      try { execSync(`reg delete "HKCU\\Environment" /v ${v} /f`, { stdio: 'pipe' }) } catch {}
    }
    console.log('  [ok] Windows env vars removed')
  } else {
    // Remove squeezr block from shell profiles
    const profiles = [
      path.join(os.homedir(), '.zshrc'),
      path.join(os.homedir(), '.bashrc'),
      path.join(os.homedir(), '.bash_profile'),
    ]
    for (const p of profiles) {
      try {
        const content = fs.readFileSync(p, 'utf-8')
        if (content.includes('# squeezr env vars')) {
          const cleaned = content.replace(/\n?# squeezr env vars[\s\S]*?fi\n?/g, '\n')
          fs.writeFileSync(p, cleaned)
          console.log(`  [ok] Cleaned ${p}`)
        }
      } catch {}
    }
    // Also clean .profile
    const profilePath = path.join(os.homedir(), '.profile')
    try {
      const content = fs.readFileSync(profilePath, 'utf-8')
      if (content.includes('# squeezr env vars')) {
        const cleaned = content.replace(/\n?# squeezr env vars[^\n]*(\nexport [^\n]*)*/g, '')
        fs.writeFileSync(profilePath, cleaned)
        console.log(`  [ok] Cleaned ${profilePath}`)
      }
    } catch {}
  }

  // 3. Remove CA from certificate stores
  if (process.platform === 'win32') {
    try { execSync('certutil -delstore -user Root "Squeezr-MITM-CA"', { stdio: 'pipe' }); console.log('  [ok] CA removed from user certificate store') } catch {}
    try { execSync('certutil -delstore Root "Squeezr-MITM-CA"', { stdio: 'pipe' }) } catch {}
  } else if (process.platform === 'darwin') {
    try { execSync('security delete-certificate -c "Squeezr-MITM-CA" ~/Library/Keychains/login.keychain-db', { stdio: 'pipe' }); console.log('  [ok] CA removed from Keychain') } catch {}
  }
  // On Linux, CA is only in bundle.crt which gets deleted with ~/.squeezr below

  // 4. Remove auto-start
  if (process.platform === 'win32') {
    try { execSync('nssm stop SqueezrProxy', { stdio: 'pipe' }) } catch {}
    try { execSync('nssm remove SqueezrProxy confirm', { stdio: 'pipe' }) } catch {}
    try { execSync('schtasks /Delete /TN "Squeezr" /F', { stdio: 'pipe' }); console.log('  [ok] Removed scheduled task') } catch {}
    // Remove Startup folder VBS (fallback auto-start)
    const startupVbs = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'squeezr-start.vbs')
    try { fs.unlinkSync(startupVbs); console.log('  [ok] Removed startup VBS script') } catch {}
  } else if (process.platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.squeezr.plist')
    try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' }) } catch {}
    try { fs.unlinkSync(plistPath); console.log('  [ok] Removed launchd plist') } catch {}
  } else {
    try { execSync('systemctl --user disable --now squeezr', { stdio: 'pipe' }) } catch {}
    const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'squeezr.service')
    try { fs.unlinkSync(servicePath); console.log('  [ok] Removed systemd service') } catch {}
  }

  // 5. Remove ~/.squeezr (logs, cache, CA, stats)
  const squeezrDir = path.join(os.homedir(), '.squeezr')
  try {
    fs.rmSync(squeezrDir, { recursive: true, force: true })
    console.log(`  [ok] Removed ${squeezrDir}`)
  } catch {}

  // 6. Remove global config
  const tomlPath = path.join(ROOT, 'squeezr.toml')
  try { fs.unlinkSync(tomlPath) } catch {}

  // 7. Remove shell wrapper functions from profiles
  if (process.platform === 'win32') {
    try {
      const psProfilePath = execSync('powershell -NoProfile -Command "[Environment]::GetFolderPath(\'MyDocuments\') + \'\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1\'"', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
      if (fs.existsSync(psProfilePath)) {
        const content = fs.readFileSync(psProfilePath, 'utf-8')
        if (content.includes('# squeezr wrapper')) {
          const cleaned = content.replace(/\n?# squeezr wrapper[\s\S]*?# end squeezr wrapper\n?/g, '')
          fs.writeFileSync(psProfilePath, cleaned)
          console.log(`  [ok] Removed PowerShell wrapper from ${psProfilePath}`)
        }
      }
    } catch {}
  }
  // Remove bash/zsh wrapper
  for (const p of [path.join(os.homedir(), '.bashrc'), path.join(os.homedir(), '.zshrc')]) {
    try {
      const content = fs.readFileSync(p, 'utf-8')
      if (content.includes('# squeezr shell wrapper')) {
        const cleaned = content.replace(/\n?# squeezr shell wrapper[\s\S]*?# end squeezr shell wrapper\n?/g, '')
        fs.writeFileSync(p, cleaned)
        console.log(`  [ok] Removed shell wrapper from ${p}`)
      }
    } catch {}
  }

  // 8. Remove MCP registrations
  console.log('  [..] Removing MCP registrations...')
  try { await mcpUninstall() } catch {}

  // 9. npm uninstall -g (clear HTTPS_PROXY first so npm doesn't hit dead proxy)
  console.log('  [..] Uninstalling npm package...')
  const cleanEnv = { ...process.env, HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '' }
  try {
    execSync('npm uninstall -g squeezr-ai', { stdio: 'inherit', env: cleanEnv })
    console.log('  [ok] npm package removed')
  } catch {
    try {
      execSync('sudo npm uninstall -g squeezr-ai', { stdio: 'inherit', env: cleanEnv })
      console.log('  [ok] npm package removed')
    } catch {
      console.log('  [warn] Could not uninstall npm package. Run manually: npm uninstall -g squeezr-ai')
    }
  }

  console.log('\nDone! Squeezr has been completely removed.\n')
}

// ── Claude Desktop hosts file + TLS intercept ────────────────────────────────
// Claude Desktop ignores ANTHROPIC_BASE_URL (it's an Electron GUI app), so the
// only way to intercept is at DNS level: hosts file redirects api.anthropic.com
// → 127.0.0.1, and Squeezr listens on :443 with TLS using its local CA cert.
//
// This function adds/removes the hosts file entry + firewall rule. Requires
// admin. On Windows, re-launches itself elevated via PowerShell Start-Process -Verb RunAs.

const HOSTS_FILE_WIN = 'C:\\Windows\\System32\\drivers\\etc\\hosts'
const HOSTS_FILE_UNIX = '/etc/hosts'
const HOSTS_MARKER_BEGIN = '# squeezr-claude-desktop BEGIN'
const HOSTS_MARKER_END   = '# squeezr-claude-desktop END'
const INTERCEPTED_DOMAINS = ['api.anthropic.com']
const CLAUDE_DESKTOP_FLAG_FILE = path.join(os.homedir(), '.squeezr', 'claude-desktop-enabled')
const MITM_INTERNAL_PORT = 8443

async function toggleClaudeDesktopIntercept(enable) {
  const isWin = process.platform === 'win32'
  const hostsPath = isWin ? HOSTS_FILE_WIN : HOSTS_FILE_UNIX

  // Check if running as admin
  const isAdmin = await checkIsAdmin()
  if (!isAdmin) {
    if (isWin) {
      console.log('Admin rights required to modify hosts file and bind to port 443.')
      console.log('Relaunching elevated...\n')
      const verb = enable ? 'enable-claude-desktop' : 'disable-claude-desktop'
      try {
        execSync(
          `powershell -NoProfile -Command "Start-Process -FilePath '${process.execPath}' -ArgumentList '${process.argv[1]}','${verb}' -Verb RunAs -Wait"`,
          { stdio: 'inherit' }
        )
        console.log('\nDone. Restart Squeezr to apply: squeezr stop && squeezr start')
      } catch (e) {
        console.error('Failed to launch elevated process: ' + e.message)
      }
      return
    } else {
      console.error('Run with sudo: sudo squeezr ' + (enable ? 'enable' : 'disable') + '-claude-desktop')
      process.exit(1)
    }
  }

  // Read hosts file
  let content = ''
  try { content = fs.readFileSync(hostsPath, 'utf-8') } catch (e) {
    console.error('Could not read hosts file: ' + e.message)
    process.exit(1)
  }

  // Strip any existing squeezr block
  const blockRegex = new RegExp(
    `\\r?\\n?${HOSTS_MARKER_BEGIN}[\\s\\S]*?${HOSTS_MARKER_END}\\r?\\n?`,
    'g'
  )
  content = content.replace(blockRegex, '')

  if (enable) {
    const block = [
      '',
      HOSTS_MARKER_BEGIN,
      '# Redirects Claude Desktop to Squeezr for token compression.',
      '# Remove this block (or run `squeezr disable-claude-desktop`) to undo.',
      ...INTERCEPTED_DOMAINS.map(d => `127.0.0.1 ${d}`),
      HOSTS_MARKER_END,
      '',
    ].join('\n')
    content += block

    fs.writeFileSync(hostsPath, content)
    console.log('[1/4] Hosts file updated: api.anthropic.com → 127.0.0.1')

    if (isWin) {
      // 2. netsh portproxy 443 → 8443 (so Squeezr listens on 8443 without admin)
      try {
        execSync(`netsh interface portproxy delete v4tov4 listenport=443 listenaddress=127.0.0.1`, { stdio: 'pipe' })
      } catch {}
      try {
        execSync(`netsh interface portproxy add v4tov4 listenport=443 listenaddress=127.0.0.1 connectport=${MITM_INTERNAL_PORT} connectaddress=127.0.0.1`, { stdio: 'pipe' })
        console.log(`[2/4] Port forwarding 127.0.0.1:443 → 127.0.0.1:${MITM_INTERNAL_PORT} (netsh portproxy)`)
      } catch (e) {
        console.warn('Could not add netsh portproxy: ' + e.message)
      }

      // 3. Firewall: open inbound 443
      try {
        execSync('netsh advfirewall firewall delete rule name="Squeezr-Claude-Desktop-443"', { stdio: 'pipe' })
      } catch {}
      try {
        execSync('netsh advfirewall firewall add rule name="Squeezr-Claude-Desktop-443" dir=in action=allow protocol=TCP localport=443', { stdio: 'pipe' })
        console.log('[3/4] Firewall rule added for port 443.')
      } catch (e) {
        console.warn('Could not add firewall rule: ' + e.message)
      }
      // Flush DNS cache so the change takes effect immediately
      try { execSync('ipconfig /flushdns', { stdio: 'pipe' }) } catch {}
    }

    // Note: no persistent flag file needed — Squeezr auto-detects the hosts file
    // entry on startup and activates the MITM listener accordingly.

    console.log('\n[NEXT] Restart Squeezr:    squeezr stop && squeezr start')
    console.log('       Close Claude Desktop completely (including system tray).')
    console.log('       Reopen Claude Desktop and try any query.')
    console.log('       Verify in dashboard "By client" section → should show "claude_desktop".')
  } else {
    fs.writeFileSync(hostsPath, content)
    console.log('[1/4] Hosts file cleaned: api.anthropic.com restored to normal DNS.')
    if (isWin) {
      try {
        execSync(`netsh interface portproxy delete v4tov4 listenport=443 listenaddress=127.0.0.1`, { stdio: 'pipe' })
        console.log('[2/4] Port forwarding rule removed.')
      } catch {}
      try {
        execSync('netsh advfirewall firewall delete rule name="Squeezr-Claude-Desktop-443"', { stdio: 'pipe' })
        console.log('[3/4] Firewall rule removed.')
      } catch {}
      try { execSync('ipconfig /flushdns', { stdio: 'pipe' }) } catch {}
    }
    // Legacy flag cleanup (if exists from older version)
    try {
      const legacyFlag = path.join(os.homedir(), '.squeezr', 'claude-desktop-enabled')
      if (fs.existsSync(legacyFlag)) fs.unlinkSync(legacyFlag)
    } catch {}
    console.log('\n[NEXT] Restart Squeezr:    squeezr stop && squeezr start')
  }
}

async function checkIsAdmin() {
  if (process.platform === 'win32') {
    try {
      execSync('net session', { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  } else {
    return process.getuid && process.getuid() === 0
  }
}

// ── Desktop proxy lifecycle (TOTALLY SEPARATE from main proxy on 8080) ───────
//   `squeezr desktop start`  → spawns dist/desktopProxy.js detached
//   `squeezr desktop stop`   → kills via PID file (does NOT touch port 8080)
//   `squeezr desktop status` → prints state
//
// Critical: this proxy lives or dies independently. Crashing it cannot affect
// the main proxy on 8080 (Claude Code, Codex CLI, Aider, Gemini CLI).

const DESKTOP_PID_FILE = path.join(os.homedir(), '.squeezr', 'desktop-proxy.pid')
const DESKTOP_LOG_FILE = path.join(os.homedir(), '.squeezr', 'desktop-proxy.log')
const DESKTOP_HTTPS_PORT = 8443
const DESKTOP_HTTP_PORT  = 8088

function readDesktopPid() {
  try {
    const raw = fs.readFileSync(DESKTOP_PID_FILE, 'utf-8').trim()
    const pid = Number(raw)
    if (!pid || Number.isNaN(pid)) return null
    // Check process actually exists
    try { process.kill(pid, 0); return pid } catch { return null }
  } catch { return null }
}

// Probe whether the desktop proxy listener is actually answering. Used to
// detect orphan processes — situations where the PID file is stale but a
// previous desktop proxy is still bound to the ports.
async function isDesktopPortBound(port) {
  return new Promise(resolve => {
    const net = require('node:net')
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 500 }, () => {
      sock.end()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
  })
}

// Find the PID owning a local TCP listener on Windows via `netstat -ano`. We
// use this only to clean up orphan desktop-proxy processes; it is a best
// effort and returns null if it can't parse the output.
function findPidByPort(port) {
  if (process.platform !== 'win32') return null
  try {
    const out = require('node:child_process').execSync(`netstat -ano -p TCP`, { encoding: 'utf-8' })
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/)
      if (m && Number(m[1]) === port) return Number(m[2])
    }
  } catch { /* ignore */ }
  return null
}

async function desktopProxyStart() {
  const existing = readDesktopPid()
  if (existing) {
    console.log(`Desktop proxy already running (pid=${existing}).`)
    console.log(`  HTTPS: https://127.0.0.1:${DESKTOP_HTTPS_PORT}  (Claude Desktop)`)
    console.log(`  HTTP:  http://127.0.0.1:${DESKTOP_HTTP_PORT}   (Codex Desktop)`)
    return
  }
  // Detect orphan listener (PID file dead but listener still up) — common
  // after an ungraceful restart. Reclaim it by adopting the running PID,
  // otherwise the spawn below would crash with EADDRINUSE.
  if (await isDesktopPortBound(DESKTOP_HTTPS_PORT) || await isDesktopPortBound(DESKTOP_HTTP_PORT)) {
    const orphanPid = findPidByPort(DESKTOP_HTTPS_PORT) ?? findPidByPort(DESKTOP_HTTP_PORT)
    if (orphanPid) {
      try { fs.writeFileSync(DESKTOP_PID_FILE, String(orphanPid), 'utf-8') } catch {}
      console.log(`Desktop proxy is already bound to ports ${DESKTOP_HTTPS_PORT}/${DESKTOP_HTTP_PORT} (pid=${orphanPid}, adopted).`)
    } else {
      console.log(`Desktop proxy ports ${DESKTOP_HTTPS_PORT}/${DESKTOP_HTTP_PORT} are already in use by an unknown process. Use 'squeezr desktop stop' first.`)
    }
    return
  }
  const distPath = path.join(ROOT, 'dist', 'desktopProxy.js')
  if (!fs.existsSync(distPath)) {
    console.error(`Error: ${distPath} not found. Run 'npm run build' first.`)
    process.exit(1)
  }
  try { fs.mkdirSync(path.dirname(DESKTOP_LOG_FILE), { recursive: true }) } catch {}
  const out = fs.openSync(DESKTOP_LOG_FILE, 'a')
  const err = fs.openSync(DESKTOP_LOG_FILE, 'a')
  const child = spawn(process.execPath, [distPath], {
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      SQUEEZR_DESKTOP_HTTPS_PORT: String(DESKTOP_HTTPS_PORT),
      SQUEEZR_DESKTOP_HTTP_PORT:  String(DESKTOP_HTTP_PORT),
    },
  })
  child.unref()
  // Wait briefly to confirm it didn't immediately exit
  await new Promise(r => setTimeout(r, 800))
  if (child.exitCode !== null) {
    console.error(`Desktop proxy failed to start (exit ${child.exitCode}). Check log: ${DESKTOP_LOG_FILE}`)
    process.exit(1)
  }
  console.log(`Desktop proxy started (pid=${child.pid}).`)
  console.log(`  HTTPS: https://127.0.0.1:${DESKTOP_HTTPS_PORT}  (Claude Desktop)`)
  console.log(`  HTTP:  http://127.0.0.1:${DESKTOP_HTTP_PORT}   (Codex Desktop)`)
  console.log(`  Log:   ${DESKTOP_LOG_FILE}`)
  console.log(``)
  console.log(`Note: the main Squeezr proxy on 8080 is unaffected by this command.`)
}

async function desktopProxyStop() {
  let pid = readDesktopPid()
  if (!pid) {
    // PID file is missing or its pid is dead — but a listener may still be
    // bound by an orphan. Try to locate it by port and kill that instead.
    if (await isDesktopPortBound(DESKTOP_HTTPS_PORT) || await isDesktopPortBound(DESKTOP_HTTP_PORT)) {
      pid = findPidByPort(DESKTOP_HTTPS_PORT) ?? findPidByPort(DESKTOP_HTTP_PORT)
      if (!pid) {
        console.log(`Desktop proxy ports ${DESKTOP_HTTPS_PORT}/${DESKTOP_HTTP_PORT} are in use but PID cannot be resolved. Stop the owning process manually.`)
        return
      }
      console.log(`Recovered orphan desktop proxy pid=${pid} from listener.`)
    } else {
      console.log('Desktop proxy is not running.')
      return
    }
  }
  try {
    process.kill(pid, 'SIGTERM')
    // Wait up to 3s for graceful exit
    for (let i = 0; i < 30; i++) {
      try { process.kill(pid, 0) } catch { break }
      await new Promise(r => setTimeout(r, 100))
    }
    // Force kill if still alive
    try { process.kill(pid, 'SIGKILL') } catch {}
    try { fs.unlinkSync(DESKTOP_PID_FILE) } catch {}
    console.log(`Desktop proxy stopped (was pid=${pid}).`)
  } catch (e) {
    console.error(`Failed to stop desktop proxy: ${e.message}`)
    process.exit(1)
  }
}

async function desktopProxyStatus() {
  let pid = readDesktopPid()
  // Fallback when PID file is stale: probe the desktop ports. If the listener
  // answers, the proxy IS running — just under a different PID than the one
  // recorded. This is the common shape after an ungraceful restart.
  if (!pid) {
    const bound = (await isDesktopPortBound(DESKTOP_HTTPS_PORT))
              || (await isDesktopPortBound(DESKTOP_HTTP_PORT))
    if (!bound) {
      console.log('Desktop proxy is NOT running.')
      console.log('Start it with: squeezr desktop start')
      return
    }
    const orphanPid = findPidByPort(DESKTOP_HTTPS_PORT) ?? findPidByPort(DESKTOP_HTTP_PORT)
    if (orphanPid) {
      try { fs.writeFileSync(DESKTOP_PID_FILE, String(orphanPid), 'utf-8') } catch {}
      pid = orphanPid
      console.log(`Desktop proxy is running (pid=${pid}, recovered from orphan listener).`)
    } else {
      console.log(`Desktop proxy listener is bound on ${DESKTOP_HTTPS_PORT}/${DESKTOP_HTTP_PORT} but its PID could not be resolved.`)
    }
  } else {
    console.log(`Desktop proxy is running (pid=${pid}).`)
  }
  console.log(`  HTTPS: https://127.0.0.1:${DESKTOP_HTTPS_PORT}  (Claude Desktop)`)
  console.log(`  HTTP:  http://127.0.0.1:${DESKTOP_HTTP_PORT}   (Codex Desktop)`)
  console.log(`  Log:   ${DESKTOP_LOG_FILE}`)
  // Surface the activation state of the Claude Desktop hosts redirect — the
  // most common reason "nothing appears in the logs" even when this listener
  // is bound is that the user never ran `enable-claude-desktop`, so Claude
  // Desktop's traffic goes directly to api.anthropic.com.
  const hostsActive = await isClaudeDesktopHostsActive()
  if (hostsActive) {
    console.log(``)
    console.log(`  Claude Desktop interception: ACTIVE (hosts redirect set)`)
  } else {
    console.log(``)
    console.log(`  Claude Desktop interception: NOT SET`)
    console.log(`  → Run as admin: squeezr enable-claude-desktop`)
    console.log(`    Without this, Claude Desktop talks to api.anthropic.com directly`)
    console.log(`    and no traffic will reach this proxy.`)
  }
}

// Best-effort detection of whether the hosts file currently redirects
// api.anthropic.com to 127.0.0.1 (the prerequisite for Claude Desktop
// traffic to reach the desktop proxy).
async function isClaudeDesktopHostsActive() {
  try {
    const hostsPath = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
      : '/etc/hosts'
    const txt = fs.readFileSync(hostsPath, 'utf-8')
    return /^\s*127\.0\.0\.1\s+api\.anthropic\.com\b/m.test(txt)
        || txt.includes('# squeezr-claude-desktop BEGIN')
  } catch { return false }
}

// ── Codex Desktop config helper ──────────────────────────────────────────────
// Writes openai_base_url to ~/.codex/config.toml so Codex Desktop routes
// through Squeezr's HTTP proxy (no MITM needed — uses standard base URL).

function configureCodexDesktop(port) {
  const codexDir  = path.join(os.homedir(), '.codex')
  const codexToml = path.join(codexDir, 'config.toml')
  const url = `http://localhost:${port}/v1`
  const marker = 'openai_base_url'
  const line = `openai_base_url = "${url}"`

  try {
    fs.mkdirSync(codexDir, { recursive: true })
    if (fs.existsSync(codexToml)) {
      let content = fs.readFileSync(codexToml, 'utf-8')
      // Match openai_base_url = "anything" — including empty "" which Codex Desktop
      // sometimes writes back to its config (bug we observed in the wild).
      // Force-overwrite any existing value, even if empty.
      const re = /openai_base_url\s*=\s*"[^"]*"/
      if (re.test(content)) {
        const before = content.match(re)?.[0] ?? ''
        content = content.replace(re, line)
        fs.writeFileSync(codexToml, content)
        if (before === `openai_base_url = ""`) {
          console.log(`  [ok] Codex Desktop: FIXED empty openai_base_url in ${codexToml}`)
        } else {
          console.log(`  [ok] Codex Desktop: updated ${codexToml}`)
        }
      } else {
        fs.appendFileSync(codexToml, `\n# Squeezr: route Codex Desktop through the compression proxy\n${line}\n`)
        console.log(`  [ok] Codex Desktop: configured ${codexToml}`)
      }
    } else {
      fs.writeFileSync(codexToml, `# Squeezr: route Codex Desktop through the compression proxy\n${line}\n`)
      console.log(`  [ok] Codex Desktop: created ${codexToml}`)
    }
  } catch (err) {
    console.log(`  [warn] Codex Desktop config: ${err.message}`)
  }
}

// ── squeezr setup ─────────────────────────────────────────────────────────────

async function setupWindows() {
  const squeezrBin = process.argv[1]
  const nodeExe = process.execPath
  const distIndex = path.join(ROOT, 'dist', 'index.js')

  console.log('Setting up Squeezr for Windows...\n')

  // 1. Set env vars permanently via setx (user scope, no admin needed)
  const port = getPort()
  const mitmPort = getMitmPort(port)
  const caPath = path.join(os.homedir(), '.squeezr', 'mitm-ca', 'ca.crt')
  const vars = {
    ANTHROPIC_BASE_URL: `http://localhost:${port}`,
    // openai_base_url NOT set — Codex uses WebSocket and must go via HTTPS_PROXY/MITM,
    // not through the HTTP proxy. Setting it breaks Codex's ws:// connections.
    GEMINI_API_BASE_URL: `http://localhost:${port}`,
    // HTTPS_PROXY intentionally NOT set globally — it routes ALL HTTPS traffic through
    // the MITM proxy which breaks Claude Code, npm, and other tools. Only Codex needs it.
    // Users who need Codex MITM can set it per-session: $env:HTTPS_PROXY="http://localhost:8081"
    NODE_EXTRA_CA_CERTS: caPath,
  }
  // Clean up HTTPS_PROXY from registry if set by older versions
  try { execSync('reg delete "HKCU\\Environment" /v HTTPS_PROXY /f', { stdio: 'pipe' }) } catch {}
  for (const [key, value] of Object.entries(vars)) {
    try {
      execSync(`setx ${key} "${value}"`, { stdio: 'pipe' })
      console.log(`  [ok] ${key}=${value}`)
    } catch {
      console.log(`  [skip] ${key} could not be set`)
    }
  }

  // 1b. Configure Codex Desktop (~/.codex/config.toml → openai_base_url)
  // On Windows, ANTHROPIC_BASE_URL from setx is already visible to all GUI apps
  // (including Claude Desktop) since user-level env vars propagate to new processes.
  configureCodexDesktop(port)

  // 1c. Register MCP server in Claude Desktop + Codex Desktop automatically
  await mcpInstall()

  // 1c. Install PowerShell wrapper so env vars auto-refresh after start/setup/update
  installShellWrapper()

  // 2. Auto-start: try NSSM (Windows service, survives crashes) → fallback to Task Scheduler
  const logDir = path.join(os.homedir(), '.squeezr')
  const serviceName = 'SqueezrProxy'
  let autoStartOk = false

  const nssmAvailable = (() => {
    try { execSync('where nssm', { stdio: 'pipe' }); return true } catch { return false }
  })()

  if (nssmAvailable) {
    try {
      // Remove existing service if present (ignore errors)
      try { execSync(`nssm stop ${serviceName}`, { stdio: 'pipe' }) } catch {}
      try { execSync(`nssm remove ${serviceName} confirm`, { stdio: 'pipe' }) } catch {}

      execSync(`nssm install ${serviceName} "${nodeExe}" "${distIndex}"`, { stdio: 'pipe' })
      execSync(`nssm set ${serviceName} AppDirectory "${ROOT}"`, { stdio: 'pipe' })
      execSync(`nssm set ${serviceName} AppStdout "${logDir}\\service-stdout.log"`, { stdio: 'pipe' })
      execSync(`nssm set ${serviceName} AppStderr "${logDir}\\service-stderr.log"`, { stdio: 'pipe' })
      execSync(`nssm set ${serviceName} AppRotateFiles 1`, { stdio: 'pipe' })
      execSync(`nssm set ${serviceName} AppRotateSeconds 86400`, { stdio: 'pipe' })
      execSync(`nssm set ${serviceName} AppExit Default Restart`, { stdio: 'pipe' })
      execSync(`nssm set ${serviceName} AppRestartDelay 3000`, { stdio: 'pipe' })
      execSync(`nssm set ${serviceName} Description "Squeezr AI token compression proxy on port 8080"`, { stdio: 'pipe' })
      execSync(`nssm start ${serviceName}`, { stdio: 'pipe' })
      console.log(`  [ok] Auto-start registered as Windows service via NSSM (auto-restart on crash)`)
      autoStartOk = true
    } catch (err) {
      const msg = err.stderr?.toString() || err.message || ''
      if (msg.includes('Access') || msg.includes('admin') || msg.includes('5')) {
        console.log(`  [warn] NSSM requires admin — run as Administrator for service install`)
      } else {
        console.log(`  [warn] NSSM install failed: ${msg.trim().split('\n')[0]}`)
      }
    }
  }

  if (!autoStartOk) {
    // Fallback: Task Scheduler (no crash recovery, but works without admin)
    const taskName = 'Squeezr'
    const nodeArg = `${nodeExe} \`"${distIndex}\`"`
    const ps = [
      `$e = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue`,
      `if ($e) { Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false }`,
      `$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-WindowStyle Hidden -NonInteractive -Command "${nodeArg}"' -WorkingDirectory '${ROOT}'`,
      `$t = New-ScheduledTaskTrigger -AtLogon`,
      `$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)`,
      `Register-ScheduledTask -TaskName '${taskName}' -Action $a -Trigger $t -Settings $s -Force | Out-Null`,
    ].join('; ')
    try {
      execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: 'pipe' })
      console.log(`  [ok] Auto-start registered in Task Scheduler (install NSSM for crash recovery)`)
      autoStartOk = true
    } catch {
      // ignore — will fall through to Startup folder VBS
    }
  }

  if (!autoStartOk) {
    // Final fallback: VBS script in user Startup folder (no admin, no special tools)
    try {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      const squeezrCmd = path.join(appData, 'npm', 'squeezr.cmd')
      const startupDir = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
      const vbsPath = path.join(startupDir, 'squeezr-start.vbs')
      const cmdToRun = fs.existsSync(squeezrCmd) ? squeezrCmd : nodeExe
      const cmdArg = fs.existsSync(squeezrCmd) ? 'start' : `"${distIndex}"`
      const vbsContent = [
        'Set WshShell = CreateObject("WScript.Shell")',
        `WshShell.Run """${cmdToRun}"" ${cmdArg}", 0, False`,
        '',
      ].join('\r\n')
      fs.mkdirSync(startupDir, { recursive: true })
      fs.writeFileSync(vbsPath, vbsContent)
      console.log(`  [ok] Auto-start registered in Startup folder (${vbsPath})`)
    } catch (err) {
      console.log(`  [warn] Auto-start failed — run as admin or install NSSM: https://nssm.cc`)
    }
  }

  // 3. Start Squeezr right now as a detached background process (no window)
  //    Logs go to ~/.squeezr/squeezr.log
  const logFile = path.join(logDir, 'squeezr.log')
  fs.mkdirSync(logDir, { recursive: true })
  const logFd = fs.openSync(logFile, 'a')
  const child = spawn(nodeExe, [distIndex], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    cwd: ROOT,
  })
  child.unref()
  fs.closeSync(logFd)
  console.log(`  [ok] Squeezr started in background (pid ${child.pid})`)
  console.log(`  [ok] Logs → ${logFile}`)

  // 4. Trust MITM CA in Windows Certificate Store (for Rust apps like Codex)
  //    Node.js apps use NODE_EXTRA_CA_CERTS; Rust/native apps need the cert store.
  //    The CA is generated on first proxy start — wait briefly for it to appear.
  const waitForCa = (retries = 10, interval = 500) => new Promise(resolve => {
    const check = (n) => {
      if (fs.existsSync(caPath)) return resolve(true)
      if (n <= 0) return resolve(false)
      setTimeout(() => check(n - 1), interval)
    }
    check(retries)
  })

  waitForCa().then(found => {
    if (!found) {
      console.log(`  [warn] MITM CA not found yet — run 'squeezr setup' again after first start`)
      printDone()
      return
    }
    // Try machine store (admin) first, fall back to user store (no admin)
    try {
      execSync(`certutil -addstore -f Root "${caPath}"`, { stdio: 'pipe' })
      console.log(`  [ok] MITM CA trusted in Windows Certificate Store (machine-level)`)
    } catch {
      try {
        execSync(`certutil -addstore -user Root "${caPath}"`, { stdio: 'pipe' })
        console.log(`  [ok] MITM CA trusted in Windows Certificate Store (user-level)`)
      } catch {
        console.log(`  [warn] Could not trust MITM CA — trust manually:`)
        console.log(`         certutil -addstore -user Root "${caPath}"`)
      }
    }
    printDone()
  })

  function printDone() {
    console.log(`
Done!

  Squeezr is running on http://localhost:${port}
  MITM proxy on http://localhost:${mitmPort} (Codex CLI TLS interception)

  Configured:
    Claude Code        ANTHROPIC_BASE_URL=http://localhost:${port}
    Claude Desktop     same — setx env var is visible to all GUI apps
    Codex Desktop      ~/.codex/config.toml openai_base_url set
    Codex CLI          HTTPS_PROXY=http://localhost:${mitmPort} codex  (per-session)
    Aider / OpenCode   ANTHROPIC_BASE_URL + openai_base_url set
    Gemini CLI         GEMINI_API_BASE_URL=http://localhost:${port}

  squeezr status   — check it's running
  squeezr gain     — see token savings
`)
    }
}

async function setupUnix() {
  const squeezrBin = process.argv[1]
  const nodeExe = process.execPath
  const platform = process.platform

  console.log(`Setting up Squeezr for ${platform === 'darwin' ? 'macOS' : 'Linux'}...\n`)

  // 1. Set env vars + auto-heal guard in shell profile
  const distIndex = path.join(ROOT, 'dist', 'index.js')
  const port = getPort()
  const mitmPort = getMitmPort(port)
  const bundlePath = path.join(os.homedir(), '.squeezr', 'mitm-ca', 'bundle.crt')
  // The auto-heal validates that whatever answers on the configured port is
  // actually squeezr (by checking the magic `identity` field). A bare
  // `curl -sf .../squeezr/health` is NOT enough because curl returns success on
  // 3xx redirects, so a foreign service (e.g. an Apache+WordPress container on
  // 8080) would be mistaken for a healthy squeezr — and Claude Code would then
  // route its API requests into the wrong service, producing cryptic errors
  // like `undefined is not an object (evaluating '$.speed')`.
  const shellBlock = [
    `# squeezr env vars`,
    `export ANTHROPIC_BASE_URL=http://localhost:${port}`,
    `export openai_base_url=http://localhost:${port}`,
    `export GEMINI_API_BASE_URL=http://localhost:${port}`,
    `export NODE_EXTRA_CA_CERTS=${bundlePath}`,
    `# NOTE: HTTPS_PROXY is intentionally NOT set globally — it would route ALL HTTPS`,
    `# (including Claude Code) through the MITM proxy and cause 502 errors.`,
    `# For Codex, set it per-session only: HTTPS_PROXY=http://localhost:${mitmPort} codex`,
    `# squeezr auto-heal: start proxy if not running (validates identity, not just HTTP 200)`,
    `_squeezr_alive() {`,
    `  curl -sf --max-time 2 "http://localhost:${port}/squeezr/health" 2>/dev/null | grep -q '"identity":"squeezr"'`,
    `}`,
    `if ! _squeezr_alive; then`,
    `  nohup ${nodeExe} ${distIndex} >> "${os.homedir()}/.squeezr/squeezr.log" 2>&1 &`,
    `  disown`,
    `fi`,
    `unset -f _squeezr_alive`,
  ].join('\n')
  const marker = '# squeezr env vars'

  // Env-only block (no auto-heal) for .profile — loaded by login shells
  // before .bashrc's "case $-" interactive guard
  const envOnlyBlock = [
    `# squeezr env vars`,
    `export ANTHROPIC_BASE_URL=http://localhost:${port}`,
    `export openai_base_url=http://localhost:${port}`,
    `export GEMINI_API_BASE_URL=http://localhost:${port}`,
    `export NODE_EXTRA_CA_CERTS=${bundlePath}`,
  ].join('\n')

  // Write env vars to ~/.profile (login shell — always loaded)
  const profilePath = path.join(os.homedir(), '.profile')
  try {
    const profileContent = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf-8') : ''
    if (!profileContent.includes(marker)) {
      fs.appendFileSync(profilePath, `\n${envOnlyBlock}\n`)
      console.log(`  [ok] Env vars added to ${profilePath}`)
    } else {
      const updated = profileContent.replace(/# squeezr env vars[\s\S]*?(?=\n(?!export )|\n*$)/, envOnlyBlock)
      fs.writeFileSync(profilePath, updated)
      console.log(`  [ok] Env vars updated in ${profilePath}`)
    }
  } catch {}

  // Write full block (env + auto-heal) to interactive shell profile
  const profiles = [
    path.join(os.homedir(), '.zshrc'),
    path.join(os.homedir(), '.bashrc'),
    path.join(os.homedir(), '.bash_profile'),
  ]
  const profile = profiles.find(p => fs.existsSync(p)) ?? profiles[0]
  const existing = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf-8') : ''
  if (!existing.includes(marker)) {
    fs.appendFileSync(profile, `\n${shellBlock}\n`)
    console.log(`  [ok] Env vars + auto-heal added to ${profile}`)
  } else {
    const updatedContent = existing.replace(
      /# squeezr env vars[\s\S]*?fi\n?/,
      shellBlock + '\n'
    )
    fs.writeFileSync(profile, updatedContent)
    console.log(`  [ok] Env vars + auto-heal updated in ${profile}`)
  }

  // 2. Configure Codex Desktop + Claude Desktop
  // Codex Desktop reads ~/.codex/config.toml (openai_base_url key).
  configureCodexDesktop(port)

  // Register MCP server in Claude Desktop and Codex Desktop automatically
  await mcpInstall()

  // Claude Desktop (GUI app) does not read shell env vars.
  // macOS: inject via a launchd env-setter plist (persists across reboots).
  // Linux: write to ~/.config/environment.d/ (systemd user env, read by GUI apps).
  if (platform === 'darwin') {
    const envPlistDir  = path.join(os.homedir(), 'Library', 'LaunchAgents')
    const envPlistPath = path.join(envPlistDir, 'com.squeezr.env.plist')
    fs.mkdirSync(envPlistDir, { recursive: true })
    const envVars = [
      ['ANTHROPIC_BASE_URL',  `http://localhost:${port}`],
      ['GEMINI_API_BASE_URL', `http://localhost:${port}`],
      ['NODE_EXTRA_CA_CERTS', bundlePath],
    ]
    const envSetCmds = envVars.map(([k, v]) => `launchctl setenv ${k} "${v}"`).join(' && ')
    fs.writeFileSync(envPlistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.squeezr.env</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>${envSetCmds}</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>`)
    try {
      execSync(`launchctl unload "${envPlistPath}" 2>/dev/null; launchctl load -w "${envPlistPath}"`, { stdio: 'pipe' })
      console.log(`  [ok] Claude Desktop: env vars set via launchctl (visible to all GUI apps)`)
    } catch {
      console.log(`  [warn] Claude Desktop: launchctl env plist failed — restart Claude Desktop manually after setup`)
    }
  } else {
    // Linux: systemd user environment.d — read by all user processes incl. GUI apps
    const envDDir  = path.join(os.homedir(), '.config', 'environment.d')
    const envDPath = path.join(envDDir, 'squeezr.conf')
    fs.mkdirSync(envDDir, { recursive: true })
    fs.writeFileSync(envDPath, [
      `# Squeezr — visible to all GUI apps (Claude Desktop, etc.)`,
      `ANTHROPIC_BASE_URL=http://localhost:${port}`,
      `GEMINI_API_BASE_URL=http://localhost:${port}`,
      `NODE_EXTRA_CA_CERTS=${bundlePath}`,
    ].join('\n') + '\n')
    console.log(`  [ok] Claude Desktop: env vars written to ${envDPath} (effective after next login)`)
  }

  // 3a. macOS — launchd
  if (platform === 'darwin') {
    const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
    const plistPath = path.join(plistDir, 'com.squeezr.plist')
    fs.mkdirSync(plistDir, { recursive: true })
    fs.writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.squeezr</string>
  <key>ProgramArguments</key>
  <array><string>${nodeExe}</string><string>${squeezrBin}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${os.homedir()}/.squeezr/squeezr.log</string>
  <key>StandardErrorPath</key><string>${os.homedir()}/.squeezr/squeezr.log</string>
</dict>
</plist>`)
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null; launchctl load "${plistPath}"`, { stdio: 'pipe' })
      console.log(`  [ok] Auto-start registered via launchd`)
      console.log(`  [ok] Squeezr started now`)
    } catch {
      console.log(`  [warn] launchctl failed — starting in background`)
      spawn(nodeExe, [squeezrBin], { detached: true, stdio: 'ignore' }).unref()
    }

    // Trust MITM CA in macOS Keychain (for Codex TLS interception)
    // CA is generated on first proxy start — wait briefly for it to appear
    const caPath = path.join(os.homedir(), '.squeezr', 'mitm-ca', 'ca.crt')
    const waitForCa = (retries = 10, interval = 500) => new Promise(resolve => {
      const check = (n) => {
        if (fs.existsSync(caPath)) return resolve(true)
        if (n <= 0) return resolve(false)
        setTimeout(() => check(n - 1), interval)
      }
      check(retries)
    })
    waitForCa().then(found => {
      if (found) {
        try {
          execSync(`security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db "${caPath}" 2>/dev/null`, { stdio: 'pipe' })
          console.log(`  [ok] MITM CA trusted in macOS Keychain`)
        } catch {
          console.log(`  [info] To trust MITM CA for Codex: security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db "${caPath}"`)
        }
      }
    })

  // 3b. Linux — systemd
  } else {
    const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user')
    const servicePath = path.join(serviceDir, 'squeezr.service')
    fs.mkdirSync(serviceDir, { recursive: true })
    fs.writeFileSync(servicePath, `[Unit]
Description=Squeezr AI proxy
After=network.target

[Service]
ExecStart=${nodeExe} ${squeezrBin}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`)
    try {
      execSync('systemctl --user daemon-reload && systemctl --user enable --now squeezr', { stdio: 'pipe' })
      console.log(`  [ok] Auto-start registered via systemd`)
      console.log(`  [ok] Squeezr started now`)
    } catch {
      console.log(`  [warn] systemctl failed — starting in background`)
      spawn(nodeExe, [squeezrBin], { detached: true, stdio: 'ignore' }).unref()
    }
  }

  console.log(`
Done!

  Squeezr is running on http://localhost:${port}

  Configured:
    Claude Code        ANTHROPIC_BASE_URL=http://localhost:${port}
    Claude Desktop     ${platform === 'darwin' ? 'env vars set via launchctl (restart app once)' : 'env vars in ~/.config/environment.d/ (re-login to activate)'}
    Codex Desktop      ~/.codex/config.toml openai_base_url set
    Codex CLI          HTTPS_PROXY=http://localhost:${mitmPort} codex  (per-session)
    Aider / OpenCode   ANTHROPIC_BASE_URL + openai_base_url set
    Gemini CLI         GEMINI_API_BASE_URL=http://localhost:${port}

  Run: source ${profile}  (or open a new terminal)
  squeezr status   — check it's running
  squeezr gain     — see token savings
`)
  installShellWrapper()
}

// ── WSL2 detection ───────────────────────────────────────────────────────────

function isWSL() {
  try {
    const release = fs.readFileSync('/proc/version', 'utf-8')
    return /microsoft|wsl/i.test(release)
  } catch {
    return false
  }
}

// ── squeezr setup — WSL2 ────────────────────────────────────────────────────

async function setupWSL() {
  const nodeExe = process.execPath
  const distIndex = path.join(ROOT, 'dist', 'index.js')

  console.log('Setting up Squeezr for WSL2...\n')

  // 1. Set env vars + auto-heal guard in WSL shell profile (.bashrc / .zshrc)
  //    The guard checks if the proxy is alive on terminal open. If not, it starts
  //    it in the background. This is the safety net for WSL2 where systemd and
  //    Task Scheduler may both fail.
  const port = getPort()
  const mitmPort = getMitmPort(port)
  const bundlePath = path.join(os.homedir(), '.squeezr', 'mitm-ca', 'bundle.crt')
  const shellBlock = [
    `# squeezr env vars`,
    `export ANTHROPIC_BASE_URL=http://localhost:${port}`,
    `export openai_base_url=http://localhost:${port}`,
    `export GEMINI_API_BASE_URL=http://localhost:${port}`,
    `export NODE_EXTRA_CA_CERTS=${bundlePath}`,
    `# NOTE: HTTPS_PROXY is intentionally NOT set globally — set per-session for Codex only:`,
    `# HTTPS_PROXY=http://localhost:${mitmPort} codex`,
    `# squeezr auto-heal: start proxy if not running (validates identity, not just HTTP 200)`,
    `_squeezr_alive() {`,
    `  curl -sf --max-time 2 "http://localhost:${port}/squeezr/health" 2>/dev/null | grep -q '"identity":"squeezr"'`,
    `}`,
    `if ! _squeezr_alive; then`,
    `  nohup ${nodeExe} ${distIndex} >> "${os.homedir()}/.squeezr/squeezr.log" 2>&1 &`,
    `  disown`,
    `fi`,
    `unset -f _squeezr_alive`,
  ].join('\n')
  const marker = '# squeezr env vars'

  // Env-only block for .profile (loaded before .bashrc's interactive guard)
  const envOnlyBlock = [
    `# squeezr env vars`,
    `export ANTHROPIC_BASE_URL=http://localhost:${port}`,
    `export openai_base_url=http://localhost:${port}`,
    `export GEMINI_API_BASE_URL=http://localhost:${port}`,
    `export NODE_EXTRA_CA_CERTS=${bundlePath}`,
  ].join('\n')

  const profilePath = path.join(os.homedir(), '.profile')
  try {
    const profileContent = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf-8') : ''
    if (!profileContent.includes(marker)) {
      fs.appendFileSync(profilePath, `\n${envOnlyBlock}\n`)
      console.log(`  [ok] Env vars added to ${profilePath}`)
    } else {
      const updated = profileContent.replace(/# squeezr env vars[\s\S]*?(?=\n(?!export )|\n*$)/, envOnlyBlock)
      fs.writeFileSync(profilePath, updated)
      console.log(`  [ok] Env vars updated in ${profilePath}`)
    }
  } catch {}

  // Full block (env + auto-heal) in interactive shell profile
  const profiles = [
    path.join(os.homedir(), '.zshrc'),
    path.join(os.homedir(), '.bashrc'),
    path.join(os.homedir(), '.bash_profile'),
  ]
  const profile = profiles.find(p => fs.existsSync(p)) ?? profiles[1]
  const existing = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf-8') : ''
  if (!existing.includes(marker)) {
    fs.appendFileSync(profile, `\n${shellBlock}\n`)
    console.log(`  [ok] Env vars + auto-heal added to ${profile}`)
  } else {
    const updatedContent = existing.replace(
      /# squeezr env vars[\s\S]*?fi\n?/,
      shellBlock + '\n'
    )
    fs.writeFileSync(profile, updatedContent)
    console.log(`  [ok] Env vars + auto-heal updated in ${profile}`)
  }

  // 2. Set Windows env vars via setx.exe (so Windows-launched CLIs see them)
  //    ANTHROPIC_BASE_URL via setx is also visible to Claude Desktop (GUI app).
  const setxExe = '/mnt/c/Windows/System32/setx.exe'
  const winVars = {
    ANTHROPIC_BASE_URL: 'http://localhost:8080',
    openai_base_url: 'http://localhost:8080',
    GEMINI_API_BASE_URL: 'http://localhost:8080',
  }
  if (fs.existsSync(setxExe)) {
    for (const [key, value] of Object.entries(winVars)) {
      try {
        execSync(`"${setxExe}" ${key} "${value}"`, { stdio: 'pipe' })
        console.log(`  [ok] Windows env: ${key}=${value}`)
      } catch {
        console.log(`  [skip] Windows env: ${key} could not be set`)
      }
    }
  } else {
    console.log('  [skip] setx.exe not found — Windows env vars not set')
  }

  // 3. Configure Codex Desktop + MCP
  //    WSL-side ~/.codex/config.toml (for Codex Desktop running in WSL)
  configureCodexDesktop(port)

  // Register MCP server in Claude Desktop and Codex Desktop automatically
  await mcpInstall()
  //    Windows-side %USERPROFILE%\.codex\config.toml (for Codex Desktop on Windows)
  try {
    const winHome = execSync('cmd.exe /c echo %USERPROFILE%', { stdio: 'pipe' }).toString().trim().replace(/\r/g, '')
    const winCodexDir = winHome + '\\.codex'
    const winMountedDir = winCodexDir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`)
    const winMountedToml = winMountedDir + '/config.toml'
    const winUrl = `http://localhost:${port}/v1`
    const winLine = `openai_base_url = "${winUrl}"`
    fs.mkdirSync(winMountedDir, { recursive: true })
    if (fs.existsSync(winMountedToml)) {
      let content = fs.readFileSync(winMountedToml, 'utf-8')
      if (content.includes('openai_base_url')) {
        content = content.replace(/openai_base_url\s*=\s*"[^"]*"/, winLine)
        fs.writeFileSync(winMountedToml, content)
      } else {
        fs.appendFileSync(winMountedToml, `\n# Squeezr\n${winLine}\n`)
      }
    } else {
      fs.writeFileSync(winMountedToml, `# Squeezr\n${winLine}\n`)
    }
    console.log(`  [ok] Codex Desktop (Windows): ${winCodexDir}\\config.toml`)
  } catch {
    console.log(`  [skip] Codex Desktop (Windows): could not write config`)
  }

  // 3. Auto-start: try systemd first (WSL2 with systemd enabled), fallback to
  //    Windows Task Scheduler, then plain background process
  let autoStartDone = false

  // 3a. Try systemd (works on newer WSL2 with [boot] systemd=true in wsl.conf)
  try {
    const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user')
    fs.mkdirSync(serviceDir, { recursive: true })
    const servicePath = path.join(serviceDir, 'squeezr.service')
    fs.writeFileSync(servicePath, `[Unit]
Description=Squeezr AI proxy
After=network.target

[Service]
ExecStart=${nodeExe} ${distIndex}
Restart=always
RestartSec=5
WorkingDirectory=${ROOT}

[Install]
WantedBy=default.target
`)
    execSync('systemctl --user daemon-reload && systemctl --user enable --now squeezr', { stdio: 'pipe' })
    console.log('  [ok] Auto-start registered via systemd')
    autoStartDone = true
  } catch {
    // systemd not available — try Windows Task Scheduler
  }

  // 3b. Fallback: Windows Task Scheduler via powershell.exe
  if (!autoStartDone) {
    const winNodeExe = execSync('wslpath -w "$(which node)"', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    const winDistIndex = execSync(`wslpath -w "${distIndex}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    const winRoot = execSync(`wslpath -w "${ROOT}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    const taskName = 'Squeezr'
    const ps = [
      `$e = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue`,
      `if ($e) { Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false }`,
      `$a = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument '-d ${os.hostname()} -- ${nodeExe} ${distIndex}' -WorkingDirectory '${winRoot}'`,
      `$t = New-ScheduledTaskTrigger -AtLogon`,
      `$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)`,
      `Register-ScheduledTask -TaskName '${taskName}' -Action $a -Trigger $t -Settings $s -Force | Out-Null`,
    ].join('; ')

    try {
      execSync(`powershell.exe -NoProfile -Command "${ps}"`, { stdio: 'pipe' })
      console.log('  [ok] Auto-start registered via Windows Task Scheduler')
      autoStartDone = true
    } catch {
      console.log('  [warn] Task Scheduler failed — run PowerShell as admin for auto-start')
    }
  }

  // 4. Start proxy now as a detached background process
  const logDir = path.join(os.homedir(), '.squeezr')
  const logFile = path.join(logDir, 'squeezr.log')
  fs.mkdirSync(logDir, { recursive: true })
  const logFd = fs.openSync(logFile, 'a')
  const child = spawn(nodeExe, [distIndex], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: ROOT,
  })
  child.unref()
  fs.closeSync(logFd)
  console.log(`  [ok] Squeezr started in background (pid ${child.pid})`)
  console.log(`  [ok] Logs → ${logFile}`)

  const setupPort = getPort()
  const setupMitmPort = getMitmPort(setupPort)
  console.log(`
Done!

  Squeezr is running on http://localhost:${setupPort}

  Configured:
    Claude Code        ANTHROPIC_BASE_URL=http://localhost:${setupPort}
    Claude Desktop     Windows setx env var set (restart app once to pick it up)
    Codex Desktop      ~/.codex/config.toml + Windows %USERPROFILE%\\.codex\\config.toml
    Codex CLI          HTTPS_PROXY=http://localhost:${setupMitmPort} codex  (per-session)
    Aider / OpenCode   ANTHROPIC_BASE_URL + openai_base_url set
    Gemini CLI         GEMINI_API_BASE_URL=http://localhost:${setupPort}

  Windows env vars are set (effective in new terminals immediately).
  WSL env vars added to ${profile}.

  squeezr status   — check it's running
  squeezr gain     — see token savings
`)
  installShellWrapper()
}

// ── squeezr tunnel ────────────────────────────────────────────────────────────
// Exposes the local proxy via a Cloudflare Quick Tunnel (free, no account needed).
// Cursor IDE requires a public HTTPS URL because its servers call the endpoint
// from Cloudflare's infrastructure — localhost is unreachable from there.

async function startTunnel() {
  const port = getPort()

  // Verify proxy is running first
  const running = await new Promise(resolve => {
    const req = http.get(`http://localhost:${port}/squeezr/health`, res => {
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(2000, () => { req.destroy(); resolve(false) })
  })

  if (!running) {
    console.error(`Squeezr proxy is not running on port ${port}.`)
    console.error(`Start it first: squeezr start`)
    process.exit(1)
  }

  console.log(`Starting Cloudflare Quick Tunnel for http://localhost:${port}...`)
  console.log(`(free, no account needed — powered by trycloudflare.com)\n`)

  // Try cloudflared binary, fall back to npx
  let tunnelCmd, tunnelArgs
  try {
    execSync('cloudflared --version', { stdio: 'pipe' })
    tunnelCmd = 'cloudflared'
    tunnelArgs = ['tunnel', '--url', `http://localhost:${port}`]
  } catch {
    tunnelCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    tunnelArgs = ['cloudflared@latest', 'tunnel', '--url', `http://localhost:${port}`]
    console.log(`cloudflared not installed — using npx cloudflared (may take a moment to download)\n`)
  }

  let tunnelUrl = null
  const child = spawn(tunnelCmd, tunnelArgs, { stdio: ['ignore', 'pipe', 'pipe'] })

  const printInstructions = (url) => {
    console.log(`\n  ╔══════════════════════════════════════════════════════════════════╗`)
    console.log(`  ║  Tunnel active:  ${url.padEnd(49)}║`)
    console.log(`  ╠══════════════════════════════════════════════════════════════════╣`)
    console.log(`  ║  CURSOR SETUP                                                    ║`)
    console.log(`  ║                                                                  ║`)
    console.log(`  ║  1. Cursor → Settings → Models                                   ║`)
    console.log(`  ║  2. Add your OpenAI or Anthropic API key                         ║`)
    console.log(`  ║  3. Enable "Override OpenAI Base URL"                            ║`)
    console.log(`  ║  4. Set URL to: ${(url + '/v1').padEnd(49)}║`)
    console.log(`  ║  5. Disable all built-in Cursor models                           ║`)
    console.log(`  ║  6. Add a custom model pointing to the same URL                  ║`)
    console.log(`  ║                                                                  ║`)
    console.log(`  ║  CONTINUE EXTENSION (VS Code / JetBrains)                        ║`)
    console.log(`  ║  No tunnel needed — use http://localhost:${port} directly         ${' '.repeat(Math.max(0, 17 - String(port).length))}║`)
    console.log(`  ║                                                                  ║`)
    console.log(`  ║  Press Ctrl+C to stop the tunnel                                 ║`)
    console.log(`  ╚══════════════════════════════════════════════════════════════════╝\n`)
  }

  const parseUrl = (line) => {
    const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
    return m ? m[0] : null
  }

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    if (!tunnelUrl) {
      const found = parseUrl(text)
      if (found) { tunnelUrl = found; printInstructions(tunnelUrl) }
    }
    process.stdout.write(text)
  })

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    if (!tunnelUrl) {
      const found = parseUrl(text)
      if (found) { tunnelUrl = found; printInstructions(tunnelUrl) }
    }
    // Only show cloudflared logs if no URL yet (suppress verbose after)
    if (!tunnelUrl) process.stderr.write(text)
  })

  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error(`Could not start tunnel. Install cloudflared: https://developers.cloudflare.com/cloudflared/downloads`)
    } else {
      console.error(`Tunnel error: ${err.message}`)
    }
    process.exit(1)
  })

  child.on('exit', (code) => {
    if (code !== 0) console.log(`\nTunnel stopped (exit ${code})`)
    process.exit(0)
  })

  process.on('SIGINT', () => { child.kill(); process.exit(0) })
  process.on('SIGTERM', () => { child.kill(); process.exit(0) })
}

// ── CLI router ────────────────────────────────────────────────────────────────

switch (command) {
  case undefined:
  case 'start':
    startDaemon()
    break

  case 'setup':
    if (process.platform === 'win32') setupWindows()
    else if (isWSL()) setupWSL()
    else setupUnix()
    break

  case 'update':
    await (async () => {
      console.log('Stopping Squeezr...')
      stopProxy()  // also kills MCP via killMcpProcesses()
      console.log('Releasing file locks...')
      killMcpProcesses()  // double-kill in case stopProxy was too fast
      await new Promise(r => setTimeout(r, 2000))

      console.log('Installing latest version...')
      const cleanEnv = { ...process.env, HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '' }
      let installed = false
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          execSync('npm install -g squeezr-ai@latest', { stdio: 'inherit', env: cleanEnv })
          installed = true
          break
        } catch (err) {
          const msg = String(err?.stderr || err?.message || '')
          if ((msg.includes('EBUSY') || msg.includes('EPERM')) && attempt < 4) {
            console.log(`  Files still locked, retrying in 3s (attempt ${attempt}/4)...`)
            // Try harder to release locks on retry
            killMcpProcesses()
            await new Promise(r => setTimeout(r, 3000))
          } else if (!msg.includes('EBUSY') && !msg.includes('EPERM') && process.platform !== 'win32') {
            // On Unix, try sudo as fallback (not useful on Windows)
            try {
              execSync('sudo npm install -g squeezr-ai@latest', { stdio: 'inherit', env: cleanEnv })
              installed = true
            } catch {}
            break
          } else {
            break
          }
        }
      }
      if (!installed) {
        console.error('\nUpdate failed: files are still locked.')
        console.error('Fix: close Claude Code completely (this releases the MCP server lock), then run "squeezr update" again.')
        process.exit(1)
      }

      // Clear update check cache
      try { fs.unlinkSync(UPDATE_CHECK_FILE) } catch {}

      // Resolve the NEW package root from npm global modules
      let newRoot = ROOT
      try {
        const npmRoot = execSync('npm root -g', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
        const candidate = path.join(npmRoot, 'squeezr-ai')
        if (fs.existsSync(path.join(candidate, 'package.json'))) newRoot = candidate
      } catch {}

      // Read the new version and write cache so no stale banner appears
      try {
        const newPkg = JSON.parse(fs.readFileSync(path.join(newRoot, 'package.json'), 'utf-8'))
        const dir = path.dirname(UPDATE_CHECK_FILE)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(UPDATE_CHECK_FILE, JSON.stringify({ latest: newPkg.version, checkedAt: Date.now() }))
        console.log(`\nUpdated to v${newPkg.version}`)
      } catch {}

      // Start the daemon directly from the new dist/index.js (no re-exec of old binary)
      console.log('Starting Squeezr...')
      const newDistIndex = path.join(newRoot, 'dist', 'index.js')
      const startPort = getPort()
      const startMitmPort = getMitmPort(startPort)
      const logDir = path.join(os.homedir(), '.squeezr')
      const logFile = path.join(logDir, 'squeezr.log')
      fs.mkdirSync(logDir, { recursive: true })
      const logFd = fs.openSync(logFile, 'a')
      const child = spawn(process.execPath, [newDistIndex], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        cwd: newRoot,
        env: { ...process.env, SQUEEZR_DAEMON: '1' },
      })
      child.unref()
      fs.closeSync(logFd)
      console.log(`Squeezr started (pid ${child.pid})`)
      console.log(`  HTTP proxy (Claude/Aider/Gemini): http://localhost:${startPort}`)
      console.log(`  MITM proxy (Codex):               http://localhost:${startMitmPort}`)
      console.log(`  Dashboard:                        http://localhost:${startPort}/squeezr/dashboard`)
      console.log(`  Logs: ${logFile}`)

      // Ensure PowerShell wrapper is installed (so env vars refresh automatically)
      installShellWrapper()
    })()
    break
  case 'stop':
    stopProxy()
    break

  case 'logs':
    showLogs()
    break

  case 'gain':
    runNode('gain.js', args.slice(1))
    break

  case 'discover':
    runNode('discover.js', args.slice(1))
    break

  case 'status':
    checkStatus()
    break

  case 'ports':
    await configurePorts()
    break

  case 'tunnel':
    await startTunnel()
    break

  case 'bypass':
    await (async () => {
      const port = getPort()
      const body = args[1] === '--on' ? JSON.stringify({ enabled: true })
        : args[1] === '--off' ? JSON.stringify({ enabled: false })
        : '{}'
      try {
        const res = await fetch(`http://localhost:${port}/squeezr/bypass`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        const json = await res.json()
        if (json.bypassed) {
          console.log('⏸️  Bypass mode ON — compression disabled')
          console.log('   Requests pass through uncompressed but are still logged.')
          console.log('   Turn off: squeezr bypass --off')
        } else {
          console.log('▶️  Bypass mode OFF — compression active')
        }
      } catch {
        console.log('Squeezr is NOT running')
        console.log('Start it with: squeezr start')
      }
    })()
    break

  case 'uninstall':
    await uninstall()
    break
  case 'enable-claude-desktop':
  case 'disable-claude-desktop':
    await toggleClaudeDesktopIntercept(command === 'enable-claude-desktop')
    break
  case 'desktop': {
    const sub = args[1] ?? 'status'
    if (sub === 'start')      await desktopProxyStart()
    else if (sub === 'stop')  await desktopProxyStop()
    else if (sub === 'status') await desktopProxyStatus()
    else { console.error(`Unknown desktop subcommand: ${sub}. Use start|stop|status`); process.exit(1) }
    break
  }
  case 'config':
    showConfig()
    break

  case 'mcp': {
    const subCmd = args[1] ?? 'install'
    if (subCmd === 'uninstall') await mcpUninstall()
    else await mcpInstall()
    break
  }
  case 'version':
  case '--version':
  case '-v':
    console.log(pkg.version)
    break

  case '--help':
  case '-h':
  case 'help':
    console.log(HELP)
    break

  default:
    console.error(`Unknown command: ${command}`)
    console.log(HELP)
    process.exit(1)
}

if (command !== 'update') await showUpdateBanner()
