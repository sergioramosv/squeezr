/**
 * Squeezr Desktop Proxy — a TOTALLY SEPARATE Node.js process from the main
 * Squeezr proxy. Serves Claude Desktop and Codex Desktop, both of which ignore
 * `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`.
 *
 * Why a separate process?
 *   The user explicitly demanded: "HAZ OTRO PROXY NUEVO EN OTRO PUERTO PARA
 *   CLAUDE DESKTOP Y CODEX DESKTOP ASI SI LO ROMPES NO DEJA DE FUNCIONAR EL
 *   DE CLAUDE CODE TERMINAL". This is exactly that. If this process crashes,
 *   the main proxy on 8080 (which Claude Code uses) keeps running untouched.
 *
 * Ports:
 *   - 8088 (HTTP)  → Codex Desktop, which can be configured to point here
 *   - 8443 (HTTPS) → Claude Desktop, intercepted via hosts file redirect
 *                    `127.0.0.1 api.anthropic.com` + netsh portproxy 443→8443
 *
 * Outbound to api.anthropic.com uses direct-DNS bypass (1.1.1.1 / 8.8.8.8) to
 * skip the hosts file redirect — otherwise we'd loop back into ourselves.
 *
 * Lifecycle:
 *   `squeezr desktop start` → spawns this process detached
 *   `squeezr desktop stop`  → kills it via its PID file
 *   `squeezr desktop status` → prints PID, ports, uptime
 *
 * This entrypoint imports the same Hono `app` from server.ts to reuse the
 * compression pipeline — but the network handling, the TLS server, and the
 * outbound DNS strategy are completely independent. Crucially, it does NOT
 * touch the main proxy's port 8080 — those are two separate listeners.
 */
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import tls from 'node:tls'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, unlinkSync } from 'node:fs'
import forge from 'node-forge'
import { anthropicDirectFetch } from './anthropicDirectFetch.js'

// ── Configuration ────────────────────────────────────────────────────────────
const HTTPS_PORT = Number(process.env.SQUEEZR_DESKTOP_HTTPS_PORT) || 8443
const HTTP_PORT  = Number(process.env.SQUEEZR_DESKTOP_HTTP_PORT)  || 8088
const MAIN_PROXY_PORT = Number(process.env.SQUEEZR_PORT) || 8080

const PID_FILE = join(homedir(), '.squeezr', 'desktop-proxy.pid')
const CA_DIR       = join(homedir(), '.squeezr', 'mitm-ca')
const CA_KEY_PATH  = join(CA_DIR, 'ca.key')
const CA_CERT_PATH = join(CA_DIR, 'ca.crt')

// ── Cert generation (signs per-host certs with Squeezr's local CA) ──────────
const certCache = new Map<string, { key: string; cert: string }>()

function getCert(hostname: string): { key: string; cert: string } {
  const cached = certCache.get(hostname)
  if (cached) return cached
  if (!fs.existsSync(CA_KEY_PATH) || !fs.existsSync(CA_CERT_PATH)) {
    throw new Error(`Squeezr CA not found at ${CA_DIR}. Run \`squeezr setup\` first.`)
  }
  const caKey  = forge.pki.privateKeyFromPem(fs.readFileSync(CA_KEY_PATH, 'utf-8'))
  const caCert = forge.pki.certificateFromPem(fs.readFileSync(CA_CERT_PATH, 'utf-8'))
  const keys   = forge.pki.rsa.generateKeyPair(2048)
  const cert   = forge.pki.createCertificate()
  cert.publicKey   = keys.publicKey
  cert.serialNumber = crypto.randomBytes(8).toString('hex')
  cert.validity.notBefore = new Date()
  cert.validity.notAfter  = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1)
  cert.setSubject([{ name: 'commonName', value: hostname }])
  cert.setIssuer(caCert.subject.attributes)
  cert.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: false },
  ])
  cert.sign(caKey, forge.md.sha256.create())
  const result = {
    key:  forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  }
  certCache.set(hostname, result)
  return result
}

// ── PID file (for `squeezr desktop stop`) ───────────────────────────────────
function writePidFile(): void {
  try {
    fs.mkdirSync(join(homedir(), '.squeezr'), { recursive: true })
    writeFileSync(PID_FILE, String(process.pid), 'utf-8')
  } catch (e) {
    console.warn(`[desktop-proxy] failed to write PID file: ${(e as Error).message}`)
  }
}

function clearPidFile(): void {
  try { unlinkSync(PID_FILE) } catch { /* ignore */ }
}

// ── Convert Node IncomingMessage → Web Request (so Hono app can serve it) ───
async function nodeReqToWebRequest(
  req: import('node:http').IncomingMessage,
  extraHeaders?: Record<string, string>,
): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const body = chunks.length ? Buffer.concat(chunks) : null

  const host = req.headers.host || 'api.anthropic.com'
  const proto = (req.socket as any).encrypted ? 'https' : 'http'
  const url = `${proto}://${host}${req.url ?? '/'}`

  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue
    if (Array.isArray(v)) for (const vv of v) headers.append(k, vv)
    else headers.set(k, String(v))
  }
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v)
  }

  return new Request(url, {
    method: req.method ?? 'GET',
    headers,
    body: (body && req.method !== 'GET' && req.method !== 'HEAD') ? body : null,
  })
}

async function pipeWebResponseToNode(
  webRes: Response,
  nodeRes: import('node:http').ServerResponse,
): Promise<void> {
  nodeRes.statusCode = webRes.status
  webRes.headers.forEach((v, k) => {
    const lk = k.toLowerCase()
    if (lk === 'transfer-encoding' || lk === 'connection' || lk === 'content-length') return
    try { nodeRes.setHeader(k, v) } catch { /* invalid */ }
  })
  if (!webRes.body) { nodeRes.end(); return }
  const reader = webRes.body.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) nodeRes.write(Buffer.from(value))
    }
  } finally {
    nodeRes.end()
  }
}

// ── Routing ─────────────────────────────────────────────────────────────────
// The desktop proxy is a thin TLS-termination + path-routing layer. It does
// NOT compress traffic in-process — it relays to the main Squeezr proxy on
// 127.0.0.1:${MAIN_PROXY_PORT}, which owns the single canonical Stats singleton
// and the dashboard. If the desktop proxy compressed locally it would end up
// with its OWN Stats/byClient counter — invisible to the dashboard — and both
// processes would race on `~/.squeezr/stats.json`.
//
// Claude Desktop (HTTPS 8443) hits api.anthropic.com:
//   /v1/messages              → relay to main proxy (compression + stats)
//   /v1/oauth/... /api/... …  → passthrough straight to api.anthropic.com via
//                               direct DNS. NOT through Hono's catch-all —
//                               `detectUpstream` misroutes OAuth as OpenAI.
//
// Codex Desktop (HTTP 8088) hits OpenAI-shaped endpoints:
//   everything                → relay to main proxy (it routes to OpenAI)
async function relayToMainProxy(webReq: Request): Promise<Response> {
  const url = new URL(webReq.url)
  const targetUrl = `http://127.0.0.1:${MAIN_PROXY_PORT}${url.pathname}${url.search}`
  const init: RequestInit = {
    method: webReq.method,
    headers: webReq.headers,
    body: (webReq.method !== 'GET' && webReq.method !== 'HEAD') ? webReq.body : null,
  }
  ;(init as any).duplex = 'half'
  return fetch(targetUrl, init)
}

async function routeAnthropicRequest(webReq: Request): Promise<Response> {
  const url = new URL(webReq.url)
  if (url.pathname === '/v1/messages') {
    return relayToMainProxy(webReq)
  }
  const upstreamUrl = `https://api.anthropic.com${url.pathname}${url.search}`
  return anthropicDirectFetch(upstreamUrl, {
    method: webReq.method,
    headers: webReq.headers,
    body: (webReq.method !== 'GET' && webReq.method !== 'HEAD') ? webReq.body : null,
    // @ts-ignore - duplex is required when sending a stream body
    duplex: 'half',
  } as RequestInit)
}

async function routeOpenAIRequest(webReq: Request): Promise<Response> {
  return relayToMainProxy(webReq)
}

// ── HTTPS server for Claude Desktop (intercepts api.anthropic.com via hosts) ─
let httpsServer: HttpsServer | null = null
let httpServer: HttpServer | null = null

function startHttpsListener(): Promise<void> {
  return new Promise((resolve, reject) => {
    const defaultCert = getCert('api.anthropic.com')

    const sniCallback = (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void): void => {
      try {
        const { key, cert } = getCert(servername || 'api.anthropic.com')
        cb(null, tls.createSecureContext({ key, cert }))
      } catch (e) {
        cb(e as Error)
      }
    }

    httpsServer = createHttpsServer({
      key: defaultCert.key,
      cert: defaultCert.cert,
      SNICallback: sniCallback,
    }, async (req, res) => {
      try {
        const webReq = await nodeReqToWebRequest(req, { 'x-squeezr-client': 'claude_desktop' })
        const webRes = await routeAnthropicRequest(webReq)
        await pipeWebResponseToNode(webRes, res)
      } catch (e: any) {
        console.error(`[desktop-proxy/https] handler error: ${e?.message ?? e}`)
        try {
          res.statusCode = 502
          res.end(JSON.stringify({ error: 'squeezr_desktop_proxy_error', message: String(e?.message ?? e) }))
        } catch { /* closed */ }
      }
    })

    httpsServer.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[desktop-proxy/https] port ${HTTPS_PORT} in use`)
        reject(err)
      } else {
        reject(err)
      }
    })

    httpsServer.listen(HTTPS_PORT, '127.0.0.1', () => {
      console.log(`[desktop-proxy/https] listening on 127.0.0.1:${HTTPS_PORT} (Claude Desktop)`)
      resolve()
    })
  })
}

function startHttpListener(): Promise<void> {
  return new Promise((resolve, reject) => {
    httpServer = createHttpServer(async (req, res) => {
      try {
        const webReq = await nodeReqToWebRequest(req, { 'x-squeezr-client': 'codex_desktop' })
        const webRes = await routeOpenAIRequest(webReq)
        await pipeWebResponseToNode(webRes, res)
      } catch (e: any) {
        console.error(`[desktop-proxy/http] handler error: ${e?.message ?? e}`)
        try {
          res.statusCode = 502
          res.end(JSON.stringify({ error: 'squeezr_desktop_proxy_error', message: String(e?.message ?? e) }))
        } catch { /* closed */ }
      }
    })

    httpServer.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[desktop-proxy/http] port ${HTTP_PORT} in use`)
        reject(err)
      } else {
        reject(err)
      }
    })

    httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
      console.log(`[desktop-proxy/http] listening on 127.0.0.1:${HTTP_PORT} (Codex Desktop)`)
      resolve()
    })
  })
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  writePidFile()

  console.log(`Squeezr Desktop Proxy starting (pid=${process.pid})`)
  console.log(`  HTTPS (Claude Desktop): https://127.0.0.1:${HTTPS_PORT}`)
  console.log(`  HTTP  (Codex Desktop):  http://127.0.0.1:${HTTP_PORT}`)
  console.log(`  Relay target (main):   http://127.0.0.1:${MAIN_PROXY_PORT}`)

  // Start both listeners. If either fails to bind, exit cleanly so the parent
  // CLI sees the error and can report it. We don't try to recover here.
  try {
    await Promise.all([startHttpsListener(), startHttpListener()])
  } catch (err) {
    console.error(`[desktop-proxy] startup failed: ${(err as Error).message}`)
    clearPidFile()
    process.exit(1)
  }

  console.log(`Squeezr Desktop Proxy ready.`)
}

function shutdown(): void {
  console.log(`[desktop-proxy] shutting down`)
  try { httpsServer?.close() } catch {}
  try { httpServer?.close() } catch {}
  clearPidFile()
  process.exit(0)
}

process.on('SIGINT',  shutdown)
process.on('SIGTERM', shutdown)
process.on('uncaughtException', (err) => {
  // Isolation: log the error and KEEP RUNNING. The desktop proxy must not
  // bring down anything else. If a single TLS handshake fails, the listener
  // recovers automatically. We don't propagate the crash.
  console.error(`[desktop-proxy] uncaught: ${err.message}`)
  console.error(err.stack)
})

main().catch((err) => {
  console.error(`[desktop-proxy] fatal: ${err.message}`)
  clearPidFile()
  process.exit(1)
})
