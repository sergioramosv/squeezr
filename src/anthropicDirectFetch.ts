/**
 * Direct-DNS outbound fetch for api.anthropic.com.
 *
 * The Squeezr `enable-claude-desktop` flow points `api.anthropic.com` to
 * 127.0.0.1 in the system hosts file so that GUI clients (which ignore
 * ANTHROPIC_BASE_URL) get intercepted by the desktop proxy on port 443/8443.
 * That redirect is global, so the MAIN Squeezr proxy on 8080 — which also
 * needs to call api.anthropic.com to forward compressed requests upstream —
 * would loop back to itself (or to the desktop proxy with a self-signed
 * cert) and break Claude Code in the terminal.
 *
 * This module gives both proxies a way to reach the *real* api.anthropic.com
 * regardless of what the hosts file says, by:
 *
 *   - Resolving the hostname directly via 1.1.1.1 / 8.8.8.8 instead of the
 *     system resolver (which honours the hosts file).
 *   - Forcing `accept-encoding: identity` because Node's `https.request`
 *     does not auto-decompress gzip/brotli (unlike global `fetch`), so a
 *     gzipped Anthropic SSE response would arrive at the downstream parser
 *     as garbled bytes and freeze the client into infinite "Retrying" loops.
 *   - Honouring `options.all` in the custom `lookup` callback. Node's
 *     `https.Agent` flips this to `true` for keep-alive connection pools,
 *     and a callback that always returns a single string crashes with
 *     `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`.
 *
 * It is intentionally NOT a general "bypass hosts" tool. Only this exact
 * hostname goes through here; everything else uses plain global fetch.
 */
import https from 'node:https'
import dns from 'node:dns/promises'

const DNS_TTL = 5 * 60 * 1000
const dnsCache = new Map<string, { addrs: string[]; expiresAt: number }>()

async function resolveDirect(hostname: string): Promise<string[]> {
  const cached = dnsCache.get(hostname)
  if (cached && cached.expiresAt > Date.now()) return cached.addrs

  const servers = [
    ['1.1.1.1', '1.0.0.1'],
    ['8.8.8.8', '8.8.4.4'],
  ]
  for (const set of servers) {
    try {
      const r = new dns.Resolver()
      r.setServers(set)
      const addrs = await r.resolve4(hostname)
      if (addrs.length > 0) {
        dnsCache.set(hostname, { addrs, expiresAt: Date.now() + DNS_TTL })
        return addrs
      }
    } catch { /* try next */ }
  }
  throw new Error(`Failed to resolve ${hostname} via direct DNS`)
}

function makeLookup(hostname: string) {
  // Returns a Node-compatible `lookup` callback that pulls from direct DNS.
  // Honours both signatures: with `opts.all` it produces an array, otherwise
  // a single address + family int.
  return (host: string, opts: any, cb: any) => {
    resolveDirect(host)
      .then(addrs => {
        if (opts && opts.all) {
          cb(null, addrs.map(a => ({ address: a, family: 4 })))
        } else {
          if (!addrs[0]) { cb(new Error(`No A records for ${host}`)); return }
          cb(null, addrs[0], 4)
        }
      })
      .catch(err => cb(err))
  }
}

export function isAnthropicUrl(url: string): boolean {
  return url.startsWith('https://api.anthropic.com') || url.startsWith('http://api.anthropic.com')
}

/**
 * Drop-in replacement for `fetch(url, init)` that targets api.anthropic.com
 * via direct DNS, immune to the system hosts file. Returns a streaming
 * Response — SSE responses are not buffered.
 */
export function anthropicDirectFetch(urlStr: string, init: RequestInit = {}): Promise<Response> {
  const u = new URL(urlStr)
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
      lookup: makeLookup(u.hostname),
    }, (res) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          res.on('data',  (c: Buffer) => { try { controller.enqueue(new Uint8Array(c)) } catch {} })
          res.on('end',   ()          => { try { controller.close() } catch {} })
          res.on('error', (e)         => { try { controller.error(e) } catch {} })
        },
        cancel() { res.destroy() },
      })
      const respHeaders = new Headers()
      for (const [k, v] of Object.entries(res.headers)) {
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
      if (typeof b === 'string' || Buffer.isBuffer(b)) { req.write(b); req.end() }
      else if (b instanceof Uint8Array) { req.write(Buffer.from(b)); req.end() }
      else if (typeof (b as ReadableStream).getReader === 'function') {
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
      } else { req.end() }
    } else { req.end() }
  })
}
