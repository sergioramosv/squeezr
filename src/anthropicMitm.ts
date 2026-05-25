/**
 * Anthropic API MITM interceptor for Claude Desktop (and other GUI clients
 * that ignore ANTHROPIC_BASE_URL).
 *
 * How it works:
 * 1. Hosts file redirects `api.anthropic.com` → `127.0.0.1` (set by `squeezr setup`)
 * 2. This module listens on port 443 (or fallback) with TLS
 * 3. Presents a certificate for api.anthropic.com signed by Squeezr's local CA
 *    (the CA is already trusted by Windows after `squeezr setup` runs certutil)
 * 4. Terminates TLS, parses HTTP request, routes through the existing Hono app
 * 5. The Hono `/v1/messages` handler does compression and forwards to upstream
 * 6. CRITICAL: outgoing requests to api.anthropic.com use direct DNS (dns.resolve4)
 *    to bypass the hosts file redirect — otherwise we'd loop back to ourselves
 *
 * Admin required for:
 * - First-time: hosts file write + firewall rule
 * - Each startup: binding to port 443 (privileged port on Windows)
 */
import https, { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import tls from 'node:tls'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import dns from 'node:dns/promises'
import forge from 'node-forge'

const CA_DIR       = join(homedir(), '.squeezr', 'mitm-ca')
const CA_KEY_PATH  = join(CA_DIR, 'ca.key')
const CA_CERT_PATH = join(CA_DIR, 'ca.crt')

const certCache = new Map<string, { key: string; cert: string }>()

/**
 * Generate (or fetch from cache) a TLS cert for a given hostname, signed by
 * Squeezr's local CA. The CA must already exist (created by codexMitm or setup).
 */
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

/**
 * DNS resolver that bypasses /etc/hosts (which we've modified to redirect to 127.0.0.1).
 * Uses `dns.resolve4` (direct DNS query) instead of `dns.lookup` (system resolver).
 *
 * Cached for the lifetime of the proxy — Anthropic's IPs are stable enough.
 */
const dnsCache = new Map<string, { addrs: string[]; expiresAt: number }>()
const DNS_TTL = 5 * 60 * 1000  // 5 minutes

async function resolveBypassingHosts(hostname: string): Promise<string[]> {
  const cached = dnsCache.get(hostname)
  if (cached && cached.expiresAt > Date.now()) return cached.addrs

  // Try multiple resolvers — Google DNS, Cloudflare, then default
  const resolvers = [
    ['8.8.8.8', '8.8.4.4'],
    ['1.1.1.1', '1.0.0.1'],
  ]
  for (const r of resolvers) {
    try {
      const resolver = new dns.Resolver()
      resolver.setServers(r)
      const addrs = await resolver.resolve4(hostname)
      if (addrs.length > 0) {
        dnsCache.set(hostname, { addrs, expiresAt: Date.now() + DNS_TTL })
        return addrs
      }
    } catch { /* try next resolver */ }
  }
  throw new Error(`Failed to resolve ${hostname} via direct DNS`)
}

/**
 * Returns a custom `lookup` function that resolves hostnames via direct DNS,
 * bypassing the local hosts file. Use this for outgoing HTTPS requests from
 * Squeezr to api.anthropic.com (or anywhere else we don't want hosts override).
 */
export function makeDirectDnsLookup() {
  return async (
    hostname: string,
    options: unknown,
    callback?: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ) => {
    // Normalize signature: lookup may be called with (host, callback) or (host, options, callback)
    const cb = (typeof options === 'function' ? options : callback) as
      (err: NodeJS.ErrnoException | null, address: string, family: number) => void
    try {
      const addrs = await resolveBypassingHosts(hostname)
      cb(null, addrs[0], 4)
    } catch (err) {
      cb(err as NodeJS.ErrnoException, '', 4)
    }
  }
}

/**
 * The hostnames we intercept. Currently only api.anthropic.com (Claude Desktop).
 * Could extend to chatgpt.com / api.openai.com / generativelanguage.googleapis.com
 * if we want to intercept other GUI clients via the same mechanism.
 */
const INTERCEPTED_HOSTS = new Set([
  'api.anthropic.com',
])

const HOSTS_MARKER = '# squeezr-claude-desktop BEGIN'
const HOSTS_FILE = process.platform === 'win32'
  ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
  : '/etc/hosts'

/**
 * Reliable detection of claude-desktop mode: checks the actual hosts file for
 * Squeezr's marker. More robust than a separate flag file (which can get out of
 * sync if the user manually edits hosts, or if UAC interrupts the setup script).
 *
 * Result is cached for 30s — the hosts file rarely changes and reading it every
 * request would be wasteful. 30s window is short enough that enable/disable
 * commands take effect quickly after running.
 */
let _hostsModifiedCache: { value: boolean; checkedAt: number } | null = null
const HOSTS_CHECK_TTL = 30_000

export function isClaudeDesktopInterceptActive(): boolean {
  if (_hostsModifiedCache && Date.now() - _hostsModifiedCache.checkedAt < HOSTS_CHECK_TTL) {
    return _hostsModifiedCache.value
  }
  let value = false
  try {
    const content = fs.readFileSync(HOSTS_FILE, 'utf-8')
    value = content.includes(HOSTS_MARKER)
  } catch { /* hosts unreadable */ }
  _hostsModifiedCache = { value, checkedAt: Date.now() }
  return value
}

export function invalidateClaudeDesktopCache(): void {
  _hostsModifiedCache = null
}

let httpsServer: HttpsServer | null = null

/**
 * Start the HTTPS server that intercepts traffic destined to api.anthropic.com.
 *
 * Defaults to port 8443 (non-privileged). A `netsh portproxy` rule (set by
 * `squeezr enable-claude-desktop`) forwards inbound :443 → :8443 so we never
 * need to bind to a privileged port at runtime.
 *
 * @param fetchHandler  the Hono `app.fetch` — same as the HTTP proxy uses
 * @param port          port to listen on (default 8443)
 */
export async function startAnthropicMitm(
  fetchHandler: (req: Request) => Promise<Response> | Response,
  port = 8443,
): Promise<void> {
  // SNI callback — return the right cert based on which hostname the client asked for
  const sniCallback = (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void): void => {
    try {
      const host = INTERCEPTED_HOSTS.has(servername) ? servername : 'api.anthropic.com'
      const { key, cert } = getCert(host)
      cb(null, tls.createSecureContext({ key, cert }))
    } catch (e) {
      cb(e as Error)
    }
  }

  // Default cert for the initial handshake (overridden by SNI)
  const defaultCert = getCert('api.anthropic.com')

  httpsServer = createHttpsServer({
    key: defaultCert.key,
    cert: defaultCert.cert,
    SNICallback: sniCallback,
  }, async (req, res) => {
    // Bridge Node IncomingMessage → Web Request, call Hono handler, bridge Response → IncomingMessage
    try {
      const host = req.headers.host ?? 'api.anthropic.com'
      const url = `https://${host}${req.url ?? '/'}`

      // Collect body
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = chunks.length ? Buffer.concat(chunks) : null

      // Build Web Request
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) for (const vv of v) headers.append(k, vv)
        else if (v != null) headers.set(k, String(v))
      }
      const webReq = new Request(url, {
        method: req.method ?? 'GET',
        headers,
        body: body && ['GET', 'HEAD'].includes(req.method ?? '') ? null : (body as any),
        // @ts-expect-error duplex required for Node fetch with body
        duplex: 'half',
      })

      // Hono handles it (uses the same routes as port 8080)
      const webRes = await fetchHandler(webReq)

      res.statusCode = webRes.status
      webRes.headers.forEach((v, k) => {
        // Skip hop-by-hop headers
        const lk = k.toLowerCase()
        if (lk === 'content-length' || lk === 'transfer-encoding' || lk === 'connection') return
        res.setHeader(k, v)
      })

      if (webRes.body) {
        // Stream body chunks
        const reader = webRes.body.getReader()
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          res.write(value as Buffer)
        }
      }
      res.end()
    } catch (e: any) {
      console.error(`[squeezr/anthropic-mitm] handler error:`, e?.message ?? e)
      try {
        res.statusCode = 502
        res.end(JSON.stringify({ error: 'squeezr_anthropic_mitm_error', message: String(e?.message ?? e) }))
      } catch { /* socket already closed */ }
    }
  })

  return new Promise((resolve, reject) => {
    httpsServer!.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
        console.error(`[squeezr/anthropic-mitm] cannot bind to port ${port}: ${err.code}`)
        console.error(`[squeezr/anthropic-mitm] Run with admin or use \`squeezr enable-claude-desktop\``)
        resolve()  // don't crash the whole proxy, just disable this feature
      } else {
        reject(err)
      }
    })
    httpsServer!.listen(port, '127.0.0.1', () => {
      console.log(`[squeezr/anthropic-mitm] HTTPS intercept on 127.0.0.1:${port} for api.anthropic.com`)
      resolve()
    })
  })
}

/**
 * Drop-in `fetch()` replacement that bypasses the local hosts file for outgoing
 * requests. Critical when Squeezr modifies hosts file (claude-desktop mode) —
 * without this, our outbound calls to api.anthropic.com would loop back into us.
 *
 * Uses `https.request` with a custom `lookup` that queries 1.1.1.1 / 8.8.8.8
 * directly via dns.resolve4. Returns a Web Response with a STREAMING body so
 * SSE (Server-Sent Events) work correctly — critical for Claude Code streaming.
 *
 * The response is resolved as soon as headers arrive; body is a ReadableStream
 * that pipes chunks from the underlying http.ClientResponse as they come in.
 */
export async function fetchBypassHosts(
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const u = typeof url === 'string' ? new URL(url) : url
  if (u.protocol !== 'https:') {
    // Non-HTTPS: fall through to native fetch (no hosts-file concern)
    return fetch(url, init)
  }

  return new Promise<Response>((resolve, reject) => {
    const headersInit: Record<string, string> = {}
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => { headersInit[k] = v })
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headersInit[k] = String(v)
      } else {
        Object.assign(headersInit, init.headers as Record<string, string>)
      }
    }

    // CRITICAL: Node's https.request does NOT auto-decompress responses (unlike
    // global fetch). If we keep accept-encoding, Anthropic sends gzip/brotli and
    // the caller gets garbled bytes — SSE parsers see nothing, Claude Code retries
    // forever ("Retrying in 5s · attempt 4/10"). Force-disable encoding here.
    for (const k of Object.keys(headersInit)) {
      if (k.toLowerCase() === 'accept-encoding') delete headersInit[k]
    }
    headersInit['accept-encoding'] = 'identity'

    const req = https.request({
      hostname: u.hostname,
      port: u.port ? Number(u.port) : 443,
      path: `${u.pathname}${u.search}`,
      method: init.method ?? 'GET',
      headers: headersInit,
      servername: u.hostname,
      lookup: (host: string, _opts: any, cb: any) => {
        resolveBypassingHosts(host)
          .then(addrs => cb(null, addrs[0], 4))
          .catch(err => cb(err, '', 4))
      },
    }, (res) => {
      // Build a ReadableStream that pipes chunks from the IncomingMessage as they arrive.
      // This is CRITICAL for SSE — buffering the entire response breaks streaming.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          res.on('data', (chunk: Buffer) => {
            try { controller.enqueue(new Uint8Array(chunk)) } catch { /* closed */ }
          })
          res.on('end', () => {
            try { controller.close() } catch { /* already closed */ }
          })
          res.on('error', (err) => {
            try { controller.error(err) } catch { /* already errored */ }
          })
        },
        cancel() {
          res.destroy()
        },
      })

      const respHeaders = new Headers()
      for (const [k, v] of Object.entries(res.headers)) {
        // Skip hop-by-hop headers that confuse the receiver (we already streamed)
        const lk = k.toLowerCase()
        if (lk === 'transfer-encoding' || lk === 'connection') continue
        if (Array.isArray(v)) for (const vv of v) respHeaders.append(k, vv)
        else if (v != null) respHeaders.set(k, String(v))
      }

      resolve(new Response(stream, {
        status: res.statusCode ?? 200,
        statusText: res.statusMessage ?? '',
        headers: respHeaders,
      }))
    })

    req.on('error', reject)

    if (init.body) {
      const b = init.body
      if (typeof b === 'string' || Buffer.isBuffer(b)) {
        req.write(b)
        req.end()
      } else if (b instanceof Uint8Array) {
        req.write(Buffer.from(b))
        req.end()
      } else if (typeof (b as ReadableStream).getReader === 'function') {
        // ReadableStream — drain it asynchronously
        ;(async () => {
          try {
            const reader = (b as ReadableStream).getReader()
            while (true) {
              const { value, done } = await reader.read()
              if (done) break
              req.write(Buffer.from(value as Uint8Array))
            }
            req.end()
          } catch (err) { reject(err); req.destroy() }
        })()
      } else {
        // Unknown body type — best effort
        req.end()
      }
    } else {
      req.end()
    }
  })
}

export function stopAnthropicMitm(): void {
  if (httpsServer) {
    httpsServer.close()
    httpsServer = null
  }
}
