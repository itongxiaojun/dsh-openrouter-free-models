/**
 * HTTP bridge between the browser half and the plugin's host half.
 *
 * The harness serves the client bundle, but a client bundle has no direct
 * handle on host services, so configuration and actions cross an ordinary HTTP
 * route registry. This mirrors the approach the installed dsh-free-search
 * plugin uses.
 *
 * Every route is POST-only and loopback-only: the bridge mutates harness state
 * and spends API credits, so it must not be reachable from anything but the
 * machine running the harness.
 */

import { BRIDGE_PREFIX } from './config.mjs'

/** Bodies are configuration, not payloads; refuse anything implausibly large. */
const MAX_BODY_BYTES = 256 * 1024

/** Write one JSON response. */
export function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Whether a request came from the loopback interface. */
export function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Read and parse a JSON request body, or `undefined` when unusable. */
export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) return undefined
      chunks.push(chunk)
    }
  } catch {
    return undefined
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Build every bridge route for one host.
 *
 * @param handlers - host callbacks: `config`, `save`, `report`, `run`.
 * @returns route objects for `webServer.register`.
 */
export function makeRoutes(handlers) {
  /** Shared admission check: loopback origin and POST verb. */
  const guard = (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, error: 'loopback requests only' })
      return false
    }
    if ((req.method ?? '').toUpperCase() !== 'POST') {
      writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method ?? ''}` })
      return false
    }
    return true
  }

  /** Wrap a handler so a thrown error is a JSON 500 instead of a dropped socket. */
  const route = (name, handler) => ({
    kind: 'exact',
    path: `${BRIDGE_PREFIX}/${name}`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const body = await readJsonBody(req)
      if (body === undefined) {
        writeJson(res, 400, { ok: false, error: 'malformed JSON body' })
        return
      }
      try {
        writeJson(res, 200, await handler(body))
      } catch (error) {
        writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  return [
    route('config', () => handlers.config()),
    route('save', (body) => handlers.save(body)),
    route('report', () => handlers.report()),
    route('run', (body) => handlers.run(body)),
  ]
}
