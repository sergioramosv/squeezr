/**
 * Claude Desktop MITM worker — runs as a SEPARATE Node.js child process.
 *
 * Why a separate process?
 *   The user demanded total isolation: "HAZLO POR SEPARADO COMO PROCESOS
 *   INDEPENDIENTES". If this worker crashes, throws, or hangs, the main
 *   Squeezr proxy (which Claude Code, Codex, Aider, etc. depend on) keeps
 *   running untouched.
 *
 * What it does:
 *   1. Listens on TLS port 8443 (forwarded from :443 via netsh portproxy)
 *   2. Receives Claude Desktop traffic redirected by the hosts file
 *   3. Forwards each request to the main Squeezr proxy on http://localhost:<port>
 *      — which compresses, calls api.anthropic.com via direct DNS, returns SSE
 *
 * The worker does NOT call api.anthropic.com directly. It re-injects the
 * request into the same compression pipeline as Claude Code traffic by hitting
 * the main proxy as a localhost HTTP client. This keeps compression behavior
 * consistent across clients and avoids duplicating the pipeline.
 *
 * Spawned by src/index.ts via child_process.fork() when hosts-file detection
 * shows the marker. Receives the main-proxy port via env var SQUEEZR_PROXY_PORT.
 */
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import tls from 'node:tls'
import http from 'node:http'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import forge from 'node-forge'

const CA_DIR       = join(homedir(), '.squeezr', 'mitm-ca')
const CA_KEY_PATH  = join(CA_DIR, 'ca.key')
const CA_CERT_PATH = join(CA_DIR, 'ca.crt')

const PROXY_PORT = Number(process.env.SQUEEZR_PROXY_PORT) || 8080
const MITM_PORT  = Number(process.env.SQUEEZR_MITM_PORT)  || 8443

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

let httpsServer: HttpsServer | null = null

function startWorker(): void {
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
  }, (req, res) => {
    // Forward the request to the main Squeezr proxy on localhost.
    // The main proxy already knows how to compress + call Anthropic via direct DNS.
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue
      // Rewrite host so the main proxy treats it as an anthropic request
      if (k.toLowerCase() === 'host') {
        headers['host'] = 'api.anthropic.com'
        continue
      }
      headers[k] = Array.isArray(v) ? v.join(', ') : String(v)
    }

    const upstream = http.request({
      hostname: '127.0.0.1',
      port: PROXY_PORT,
      path: req.url ?? '/',
      method: req.method ?? 'GET',
      headers,
    }, (upstreamRes) => {
      res.statusCode = upstreamRes.statusCode ?? 200
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (v == null) continue
        try { res.setHeader(k, v as any) } catch { /* invalid header */ }
      }
      upstreamRes.pipe(res)
    })

    upstream.on('error', (err) => {
      console.error(`[claude-desktop-worker] upstream error: ${err.message}`)
      try {
        res.statusCode = 502
        res.end(JSON.stringify({ error: 'squeezr_worker_upstream_error', message: err.message }))
      } catch { /* socket closed */ }
    })

    req.pipe(upstream)
  })

  httpsServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[claude-desktop-worker] port ${MITM_PORT} in use — another worker already running?`)
      process.exit(1)
    }
    if (err.code === 'EACCES') {
      console.error(`[claude-desktop-worker] permission denied on port ${MITM_PORT}`)
      process.exit(1)
    }
    console.error(`[claude-desktop-worker] server error: ${err.message}`)
  })

  httpsServer.listen(MITM_PORT, '127.0.0.1', () => {
    console.log(`[claude-desktop-worker] listening on 127.0.0.1:${MITM_PORT} → proxy localhost:${PROXY_PORT}`)
  })
}

process.on('SIGINT',  () => { httpsServer?.close(); process.exit(0) })
process.on('SIGTERM', () => { httpsServer?.close(); process.exit(0) })
process.on('uncaughtException', (err) => {
  // Worker isolation: log and keep running. Don't take the main proxy down.
  console.error(`[claude-desktop-worker] uncaught: ${err.message}`)
})

try {
  startWorker()
} catch (err) {
  console.error(`[claude-desktop-worker] startup failed: ${(err as Error).message}`)
  process.exit(1)
}
