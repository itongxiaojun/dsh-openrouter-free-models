import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG, FIELDS, mergeConfig, normalizeConfig } from '../lib/config.mjs'
import { makeRoutes, isLoopbackRequest } from '../lib/bridge.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

// ── configuration normalization ────────────────────────────────────────────

test('normalizeConfig fills every declared field from the defaults', () => {
  const { config, rejected } = normalizeConfig(undefined)
  assert.deepEqual(rejected, [])
  assert.deepEqual(Object.keys(config).sort(), FIELDS.map((field) => field.key).sort())
  assert.deepEqual(config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)))
})

test('normalizeConfig repairs out-of-range and mistyped values', () => {
  const { config, rejected } = normalizeConfig({
    policy: 'nonsense',
    concurrency: 99,
    timeoutMs: 'soon',
    samples: 0,
    requireTools: 'yes',
  })
  assert.equal(config.policy, DEFAULT_CONFIG.policy)
  assert.equal(config.concurrency, DEFAULT_CONFIG.concurrency)
  assert.equal(config.timeoutMs, DEFAULT_CONFIG.timeoutMs)
  assert.equal(config.samples, DEFAULT_CONFIG.samples)
  assert.equal(config.requireTools, DEFAULT_CONFIG.requireTools)
  assert.equal(rejected.length, 5)
  for (const entry of rejected) assert.match(entry, /falling back to the default/)
})

test('normalizeConfig accepts the boundary values each field declares', () => {
  const config = normalizeConfig({ concurrency: 1, timeoutMs: 1000, samples: 5, maxAgeMinutes: 0 }).config
  assert.equal(config.concurrency, 1)
  assert.equal(config.timeoutMs, 1000)
  assert.equal(config.samples, 5)
  assert.equal(config.maxAgeMinutes, 0)
})

test('normalizeConfig drops unknown keys', () => {
  const { config } = normalizeConfig({ policy: 'suffix', somethingElse: true })
  assert.equal('somethingElse' in config, false)
  assert.equal(config.policy, 'suffix')
})

test('excludeIds accepts a newline string, a comma string, and an array', () => {
  assert.deepEqual(normalizeConfig({ excludeIds: 'a\nb\n\nc' }).config.excludeIds, ['a', 'b', 'c'])
  assert.deepEqual(normalizeConfig({ excludeIds: 'a, b' }).config.excludeIds, ['a', 'b'])
  assert.deepEqual(normalizeConfig({ excludeIds: ['x', ' y '] }).config.excludeIds, ['x', 'y'])
})

test('a non-object document resolves to the defaults rather than throwing', () => {
  for (const raw of [null, 42, 'text', []]) {
    const { config } = normalizeConfig(raw)
    assert.equal(config.policy, DEFAULT_CONFIG.policy)
  }
})

test('mergeConfig lets explicit arguments win over stored configuration', () => {
  const stored = normalizeConfig({ policy: 'suffix', concurrency: 2 }).config
  const merged = mergeConfig(stored, { policy: 'zero-price', concurrency: 7 })
  assert.equal(merged.policy, 'zero-price')
  assert.equal(merged.concurrency, 7)
  assert.equal(merged.nameTemplate, stored.nameTemplate)
})

test('mergeConfig ignores invalid overrides instead of corrupting the run', () => {
  const stored = normalizeConfig({ concurrency: 4 }).config
  assert.equal(mergeConfig(stored, { concurrency: 999 }).concurrency, 4)
  assert.equal(mergeConfig(stored, { policy: 'bogus' }).policy, stored.policy)
})

test('every declared field is renderable by the browser form', () => {
  const kinds = new Set(['boolean', 'enum', 'integer', 'string', 'stringList'])
  for (const field of FIELDS) {
    assert.ok(kinds.has(field.type), `field ${field.key} has unknown type ${field.type}`)
    assert.equal(typeof field.label, 'string')
    assert.equal(typeof field.hint, 'string')
    assert.ok(Object.hasOwn(DEFAULT_CONFIG, field.key), `field ${field.key} has no default`)
    if (field.type === 'enum') assert.ok(field.values.length > 0)
  }
})

// ── bridge routes ──────────────────────────────────────────────────────────

/** A minimal request double with the fields the routes read. */
function fakeRequest({ method = 'POST', address = '127.0.0.1', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  return {
    method,
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** A minimal response double capturing status and JSON body. */
function fakeResponse() {
  return {
    status: 0,
    headers: null,
    payload: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(text) { this.payload = text === undefined ? undefined : JSON.parse(text) },
  }
}

const HANDLERS = {
  config: async () => ({ ok: true, config: DEFAULT_CONFIG, fields: FIELDS }),
  save: async (body) => ({ ok: true, saved: Object.keys(body).length }),
  report: async () => ({ ok: true, report: null }),
  run: async (body) => ({ ok: true, action: body.action }),
}

/** The route whose path ends with the given bridge call. */
function routeFor(routes, name) {
  const route = routes.find((entry) => entry.path.endsWith('/' + name))
  assert.ok(route, 'no route for ' + name)
  return route
}

test('the bridge exposes config, save, report, and run', () => {
  const routes = makeRoutes(HANDLERS)
  assert.deepEqual(routes.map((r) => r.path.split('/').pop()).sort(), ['config', 'report', 'run', 'save'])
  for (const route of routes) assert.equal(route.kind, 'exact')
})

test('the bridge answers a well-formed POST', async () => {
  const routes = makeRoutes(HANDLERS)
  const res = fakeResponse()
  await routeFor(routes, 'config').handler(fakeRequest({ body: {} }), res)
  assert.equal(res.status, 200)
  assert.equal(res.payload.ok, true)
  assert.equal(res.payload.fields.length, FIELDS.length)
})

test('the bridge forwards a run action', async () => {
  const routes = makeRoutes(HANDLERS)
  const res = fakeResponse()
  await routeFor(routes, 'run').handler(fakeRequest({ body: { action: 'probe' } }), res)
  assert.equal(res.payload.action, 'probe')
})

test('the bridge refuses non-loopback requests', async () => {
  const routes = makeRoutes(HANDLERS)
  const res = fakeResponse()
  await routeFor(routes, 'config').handler(fakeRequest({ address: '10.0.0.7', body: {} }), res)
  assert.equal(res.status, 403)
  assert.match(res.payload.error, /loopback/)
})

test('the bridge refuses non-POST verbs', async () => {
  const routes = makeRoutes(HANDLERS)
  const res = fakeResponse()
  await routeFor(routes, 'config').handler(fakeRequest({ method: 'GET' }), res)
  assert.equal(res.status, 405)
})

test('the bridge rejects a malformed JSON body', async () => {
  const routes = makeRoutes(HANDLERS)
  const res = fakeResponse()
  await routeFor(routes, 'save').handler(fakeRequest({ body: '{not json' }), res)
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /malformed/)
})

test('the bridge converts a handler throw into a JSON 500', async () => {
  const routes = makeRoutes({ ...HANDLERS, run: async () => { throw new Error('boom') } })
  const res = fakeResponse()
  await routeFor(routes, 'run').handler(fakeRequest({ body: {} }), res)
  assert.equal(res.status, 500)
  assert.equal(res.payload.error, 'boom')
})

test('loopback detection accepts the IPv4, IPv6, and mapped forms', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackRequest({ socket: { remoteAddress: address } }), true, address)
  }
  for (const address of ['192.168.1.4', '', undefined]) {
    assert.equal(isLoopbackRequest({ socket: { remoteAddress: address } }), false, String(address))
  }
})

test('the bridge never advertises a cacheable response', async () => {
  const routes = makeRoutes(HANDLERS)
  const res = fakeResponse()
  await routeFor(routes, 'config').handler(fakeRequest({ body: {} }), res)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.match(res.headers['content-type'], /application\/json/)
})

// ── the browser bundle ─────────────────────────────────────────────────────

/** Evaluate lib/client.js the way the browser's module loader would. */
function loadClientBundle() {
  let registration = null
  const windowStub = { __ModuleLoader__: { load(spec) { registration = spec } } }
  const reactStub = { useState: (value) => [value, () => {}], useEffect: () => {}, createElement: () => null }
  const requireStub = (id) => {
    if (id === 'react') return reactStub
    if (id === 'react/jsx-runtime') return {}
    throw new Error('unexpected require: ' + id)
  }
  const source = readFileSync(ROOT + 'lib/client.js', 'utf8')
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(windowStub, undefined)
  assert.ok(registration, 'the bundle must register itself with __ModuleLoader__')
  return registration.factory(requireStub)
}

test('the client bundle registers under the plugin id and exports a plugin', () => {
  const mod = loadClientBundle()
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots'])
})

test('the client bundle mounts a Settings section for this plugin', () => {
  const mod = loadClientBundle()
  let options = null
  let component = null
  const ctx = {
    slots: {
      inject(name, factory) {
        assert.equal(name, 'settings.section')
        factory()
      },
      register(registrationOptions, registrationComponent) {
        options = registrationOptions
        component = registrationComponent
        return () => {}
      },
    },
  }
  mod.apply(ctx)
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'openrouter-free-models')
  assert.equal(typeof options.label(), 'string')
  assert.equal(typeof component, 'function')
  // A list slot requires an id, and ordering after the built-in sections puts
  // it where a plugin section belongs.
  assert.ok(Number.isFinite(options.order))
  assert.ok(options.order > 20, 'the section must sort after the built-in sections')
})

test('the client bundle avoids constructs that would need a build step', () => {
  const source = readFileSync(ROOT + 'lib/client.js', 'utf8')
  // It is served verbatim to the browser, so it must already be plain browser
  // JS: no static module syntax and no JSX runtime left to resolve.
  assert.equal(/\bimport\s/.test(source), false, 'the bundle must not use static import')
  assert.equal(source.includes('export '), false, 'the bundle must not use static export')
  assert.equal(source.includes('jsx-runtime'), false, 'the bundle must not need a JSX runtime')
})

// ── package manifest ───────────────────────────────────────────────────────

test('the package declares a browser half the loader can discover', () => {
  const pkg = JSON.parse(readFileSync(ROOT + 'package.json', 'utf8'))
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-runtime'])
})

test('the package name is a bare specifier so client-modules sees the entry', () => {
  const pkg = JSON.parse(readFileSync(ROOT + 'package.json', 'utf8'))
  assert.equal(pkg.name, 'dsh-openrouter-free-models')
  assert.equal(pkg.name.includes('/'), false, 'a scoped or path-like name is not discovered')
})

test('the client bundle id matches the package name', () => {
  const pkg = JSON.parse(readFileSync(ROOT + 'package.json', 'utf8'))
  const source = readFileSync(ROOT + 'lib/client.js', 'utf8')
  assert.ok(source.includes("id: '" + pkg.name + "'"), "the bundle id must equal the package name")
})
