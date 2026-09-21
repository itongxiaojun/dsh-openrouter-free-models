import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchModels, measureCompletion, OpenRouterError } from '../lib/or-client.mjs'
import { buildReport, probeModels } from '../lib/probe.mjs'
import { selectFreeModels } from '../lib/core.mjs'
import { applyReport, rollback, planDefaultModelRepair, SETTINGS_NAMESPACE } from '../lib/apply.mjs'

// ── helpers ────────────────────────────────────────────────────────────────

/** Build a fake Response whose body streams the given SSE lines. */
function sseResponse(lines, { status = 200, delayMs = 0 } = {}) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    async start(controller) {
      for (const line of lines) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
        controller.enqueue(encoder.encode(line + '\n'))
      }
      controller.close()
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

/** SSE chunk carrying visible text. */
function textChunk(text) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n'
}

const FREE_MODEL = { id: 'a/b:free', name: 'A: B (free)', context_length: 262144, pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'], input_modalities: ['text'] }, supported_parameters: ['tools'] }

// ── D: fetchModels ─────────────────────────────────────────────────────────

test('D1 fetchModels returns the data array and validates its shape', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ data: [FREE_MODEL] }), { status: 200 })
  assert.deepEqual(await fetchModels({ fetchImpl }), [FREE_MODEL])
})

test('D2 fetchModels reports a timeout with the configured budget', async () => {
  const fetchImpl = (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  await assert.rejects(() => fetchModels({ fetchImpl, timeoutMs: 20, retries: 0 }), (error) => {
    assert.ok(error instanceof OpenRouterError)
    assert.match(error.message, /timed out after 20ms/)
    return true
  })
})

test('D3-D4 a catalog HTTP failure surfaces status and body, and sends no authorization', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push(init)
    return new Response('nope', { status: 418 })
  }
  await assert.rejects(() => fetchModels({ fetchImpl, retries: 0 }), (error) => {
    assert.equal(error.status, 418)
    assert.match(error.message, /HTTP 418/)
    return true
  })
  assert.equal(seen[0].headers.authorization, undefined)
})

test('D5-D6 a 429 is retried and then reported', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response('slow down', { status: 429 })
  }
  await assert.rejects(() => fetchModels({ fetchImpl, retries: 1 }), (error) => {
    assert.equal(error.status, 429)
    return true
  })
  assert.equal(calls, 2)
})

test('D7-D8.1 malformed catalog JSON is a diagnosable error', async () => {
  const fetchImpl = async () => new Response('{not json', { status: 200 })
  await assert.rejects(() => fetchModels({ fetchImpl, retries: 0 }), /unparseable JSON/)
})

// ── D8 probe timing ────────────────────────────────────────────────────────

test('D8.1-D8.4 a streaming reply yields TTFT and throughput from visible text only', async () => {
  const lines = [
    'data: ' + JSON.stringify({ choices: [{ delta: { reasoning: 'thinking' } }] }),
    ...Array.from({ length: 12 }, (_, i) => textChunk('tok' + i).trim()),
    'data: [DONE]',
  ]
  let now = 0
  const originalNow = Date.now
  Date.now = () => (now += 60)
  try {
    const result = await measureCompletion(
      { id: 'a/b:free', apiKey: 'k' },
      { fetchImpl: async () => sseResponse(lines) },
    )
    assert.equal(result.status, 'ok')
    assert.equal(result.tokens, 12)
    assert.ok(result.ttftMs > 0)
    assert.ok(result.tps > 0)
    assert.equal(result.lowConfidence, false)
  } finally {
    Date.now = originalNow
  }
})

test('D8.5 a final event without a trailing newline is still counted', async () => {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'last' } }] })))
      controller.close()
    },
  })
  const result = await measureCompletion({ id: 'a:free', apiKey: 'k' }, { fetchImpl: async () => new Response(body, { status: 200 }) })
  assert.equal(result.status, 'ok')
  assert.equal(result.tokens, 1)
})

test('D8.3 a short reply is flagged low confidence rather than reported as a speed', async () => {
  const result = await measureCompletion({ id: 'a:free', apiKey: 'k' }, { fetchImpl: async () => sseResponse([textChunk('hi').trim(), 'data: [DONE]']) })
  assert.equal(result.status, 'ok')
  assert.equal(result.tps, null)
  assert.equal(result.lowConfidence, true)
})

test('D8.6 the probe request authenticates and asks for a stream', async () => {
  let captured
  const fetchImpl = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) }
    return sseResponse(['data: [DONE]'])
  }
  await measureCompletion({ id: 'a/b:free', apiKey: 'secret' }, { fetchImpl, maxTokens: 7 })
  assert.match(captured.url, /\/chat\/completions$/)
  assert.equal(captured.init.headers.authorization, 'Bearer secret')
  assert.equal(captured.body.stream, true)
  assert.equal(captured.body.max_tokens, 7)
  assert.equal(captured.body.model, 'a/b:free')
})

test('D8.7 an empty stream is an error, not a zero-speed model', async () => {
  const result = await measureCompletion({ id: 'a:free', apiKey: 'k' }, { fetchImpl: async () => sseResponse(['data: [DONE]']) })
  assert.equal(result.status, 'error')
  assert.match(result.error, /no visible text/)
})

test('D8 an HTTP failure is classified without throwing', async () => {
  const result = await measureCompletion({ id: 'a:free', apiKey: 'k' }, { fetchImpl: async () => new Response('denied', { status: 401 }) })
  assert.equal(result.status, 'error')
  assert.equal(result.unauthorized, true)
  assert.equal(result.status_code, 401)

  const limited = await measureCompletion({ id: 'a:free', apiKey: 'k' }, { fetchImpl: async () => new Response('slow', { status: 429 }) })
  assert.equal(limited.rateLimited, true)
})

// ── D9 probe orchestration ─────────────────────────────────────────────────

function catalogOf(ids) {
  return ids.map((id, index) => ({
    id,
    name: 'Model ' + index,
    context_length: 1024 * (index + 1),
    pricing: { prompt: '0', completion: '0' },
    architecture: { output_modalities: ['text'], input_modalities: ['text'] },
    supported_parameters: ['tools'],
  }))
}

test('D9.3-D9.4 an unauthorized credential stops the round instead of hammering every model', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response('bad key', { status: 401 })
  }
  const ids = ['a:free', 'b:free', 'c:free', 'd:free', 'e:free', 'f:free']
  const selected = selectFreeModels(catalogOf(ids), {})
  const report = await probeModels(selected, { apiKey: 'bad', fetchImpl, concurrency: 2 })
  // The two workers already in flight when the 401 lands finish; the rest are
  // skipped rather than each rediscovering the same rejection.
  assert.ok(calls <= 2, 'expected at most one in-flight request per worker, saw ' + calls)
  const skipped = report.models.filter((model) => model.status === 'not-tested')
  assert.equal(skipped.length, ids.length - calls)
  for (const model of skipped) assert.match(model.error, /credential rejected/)
  assert.ok(report.notes.some((note) => /401|403/.test(note)))
})

test('D9.2 one failing model does not sink the rest', async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.model === 'b:free') return new Response('boom', { status: 500 })
    return sseResponse([textChunk('x').trim(), 'data: [DONE]'])
  }
  const selected = selectFreeModels(catalogOf(['a:free', 'b:free', 'c:free']), {})
  const report = await probeModels(selected, { apiKey: 'k', fetchImpl, concurrency: 2 })
  const byId = Object.fromEntries(report.models.map((m) => [m.id, m.status]))
  assert.equal(byId['a:free'], 'ok')
  assert.equal(byId['b:free'], 'error')
  assert.equal(byId['c:free'], 'ok')
})

test('D9.5 no credential skips probing and says why', async () => {
  const selected = selectFreeModels(catalogOf(['a:free']), {})
  const report = await probeModels(selected, { apiKey: undefined, fetchImpl: async () => { throw new Error('must not be called') } })
  assert.equal(report.models[0].status, 'not-tested')
  assert.match(report.models[0].error, /no credential/)
  assert.ok(report.notes.some((note) => /require a key/.test(note)))
})

test('D9.1 concurrency is respected', async () => {
  let inFlight = 0
  let peak = 0
  const fetchImpl = async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, 5))
    inFlight -= 1
    return sseResponse([textChunk('x').trim(), 'data: [DONE]'])
  }
  const selected = selectFreeModels(catalogOf(['a:free', 'b:free', 'c:free', 'd:free', 'e:free', 'f:free']), {})
  await probeModels(selected, { apiKey: 'k', fetchImpl, concurrency: 2 })
  assert.ok(peak <= 2, 'peak concurrency was ' + peak)
})

test('samples takes the median of repeated probes', async () => {
  const speeds = [10, 30, 20]
  let index = 0
  const fetchImpl = async () => {
    const count = speeds[index++ % speeds.length]
    const lines = Array.from({ length: count }, (_, i) => textChunk('t' + i).trim())
    return sseResponse([...lines, 'data: [DONE]', ''], { delayMs: 20 })
  }
  const selected = selectFreeModels(catalogOf(['a:free']), {})
  const report = await probeModels(selected, { apiKey: 'k', fetchImpl, samples: 3, concurrency: 1 })
  assert.equal(report.models[0].speed.samples, 3)
  assert.ok(report.models[0].speed.tps > 0, 'expected a throughput figure with a paced stream')
  assert.equal(report.models[0].speed.lowConfidence, false)
})

test('a reply too short or too fast to time is flagged, not scored', async () => {
  const fetchImpl = async () => sseResponse([textChunk('hi').trim(), 'data: [DONE]'])
  const selected = selectFreeModels(catalogOf(['a:free']), {})
  const report = await probeModels(selected, { apiKey: 'k', fetchImpl })
  assert.equal(report.models[0].speed.tps, null)
  assert.equal(report.models[0].speed.lowConfidence, true)
})

test('buildReport orders the entries fastest-first', async () => {
  // Pace each model differently so their throughputs genuinely differ: the
  // token spacing decides tok/s, so a is fastest, c middle, b slowest.
  const spacing = { 'a:free': 5, 'b:free': 50, 'c:free': 20 }
  const fetchImpl = async (_url, init) => {
    const model = JSON.parse(init.body).model
    const lines = Array.from({ length: 12 }, (_, i) => textChunk('t' + i).trim())
    return sseResponse([...lines, 'data: [DONE]'], { delayMs: spacing[model] })
  }
  const catalog = catalogOf(['a:free', 'b:free', 'c:free'])
  const report = await buildReport(catalog, { apiKey: 'k', fetchImpl, concurrency: 1 })

  const speeds = Object.fromEntries(report.models.map((m) => [m.id, m.speed?.tps]))
  assert.ok(speeds['a:free'] > speeds['c:free'], 'fixture should differ in speed')
  assert.ok(speeds['c:free'] > speeds['b:free'], 'fixture should differ in speed')

  assert.deepEqual(report.models.map((m) => m.id), ['a:free', 'c:free', 'b:free'])
  // The written payload must follow the same order as the report.
  assert.deepEqual(report.entries.map((entry) => entry.id), ['a:free', 'c:free', 'b:free'])
})

test('buildReport puts unmeasured models after the measured ones', async () => {
  // 'b:free' fails outright, so it has no speed and must not be ranked.
  const fetchImpl = async (_url, init) => {
    const model = JSON.parse(init.body).model
    if (model === 'b:free') return new Response('boom', { status: 500 })
    const lines = Array.from({ length: 12 }, (_, i) => textChunk('t' + i).trim())
    return sseResponse([...lines, 'data: [DONE]'], { delayMs: 10 })
  }
  const catalog = catalogOf(['a:free', 'b:free', 'c:free'])
  const report = await buildReport(catalog, { apiKey: 'k', fetchImpl, concurrency: 1 })
  assert.equal(report.models.at(-1).id, 'b:free', 'the unmeasured model belongs last')
  assert.equal(report.entries.at(-1).id, 'b:free')
})

test('buildReport files the settings payload alongside the probe report', async () => {
  const fetchImpl = async () => sseResponse([textChunk('x').trim(), 'data: [DONE]'])
  const report = await buildReport(catalogOf(['a:free']), { apiKey: 'k', fetchImpl, policy: 'suffix' })
  assert.equal(report.selectedCount, 1)
  assert.equal(report.entries[0].id, 'a:free')
  assert.equal(report.entries[0].contextWindow, 1024)
  assert.match(report.entries[0].name, /1K$/)
})

// ── E: apply ───────────────────────────────────────────────────────────────

/** Minimal settings double mirroring the harness surface this plugin uses. */
function fakeSettings(initial = {}) {
  const state = structuredClone(initial)
  const calls = { mutate: 0, lastOps: null }
  return {
    calls,
    get(ns) { return state[ns] },
    async mutate(ns, ops, revision) {
      calls.mutate += 1
      calls.lastOps = ops
      const next = structuredClone(state[ns] ?? {})
      for (const op of ops) {
        const path = [...op.path]
        let cursor = next
        while (path.length > 1) {
          const key = path.shift()
          cursor[key] ??= {}
          cursor = cursor[key]
        }
        if (op.op === 'set') cursor[path[0]] = structuredClone(op.value)
        else delete cursor[path[0]]
      }
      state[ns] = next
      return next
    },
    snapshot() { return structuredClone(state) },
  }
}

const USER_SETTINGS = {
  'llm-pi-ai': {
    providers: {
      deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-v4-flash', name: 'DSH Flash' }] },
      openrouter: {
        apiKeyEnv: 'OPENROUTER_API_KEY',
        models: [
          { id: 'inclusionai/ling-3.0-flash-fin:free' },
          { id: 'minimax/minimax-m3:free\t' },
        ],
      },
    },
  },
}

const REPORT = {
  models: [],
  entries: [
    { id: 'minimax/minimax-m3:free', name: 'M3 · ⚡48 tok/s · 1M', contextWindow: 1048576 },
    { id: 'inclusionai/ling-3.0-flash-fin:free', name: 'Ling Fin · ⚡61 tok/s · 256K', contextWindow: 262144 },
  ],
}

test('E1 a dry run never touches settings', async () => {
  const settings = fakeSettings(USER_SETTINGS)
  const result = await applyReport(settings, REPORT, { dryRun: true })
  assert.equal(settings.calls.mutate, 0)
  assert.equal(result.written, false)
  assert.equal(result.dryRun, true)
  assert.ok(Array.isArray(result.models))
})

test('E5 a write leaves other providers untouched', async () => {
  const settings = fakeSettings(USER_SETTINGS)
  await applyReport(settings, REPORT)
  const after = settings.snapshot()
  assert.deepEqual(after['llm-pi-ai'].providers.deepseek, USER_SETTINGS['llm-pi-ai'].providers.deepseek)
  assert.equal(after['llm-pi-ai'].providers.openrouter.apiKeyEnv, 'OPENROUTER_API_KEY')
})

test('E9 a write repairs the tab-polluted id instead of duplicating it', async () => {
  const settings = fakeSettings(USER_SETTINGS)
  const result = await applyReport(settings, REPORT)
  const ids = settings.snapshot()['llm-pi-ai'].providers.openrouter.models.map((m) => m.id)
  // Probed ids lead in catalog order; the polluted row was repaired in place
  // rather than duplicated or dropped.
  assert.deepEqual(ids, ['minimax/minimax-m3:free', 'inclusionai/ling-3.0-flash-fin:free'])
  assert.equal(ids.length, 2)
  assert.equal(result.repaired.length, 1)
  for (const id of ids) assert.ok(!/[\u0000-\u001F\u007F]/.test(id))
})

test('E6-E7 a write produces named entries and never mutates on refusal', async () => {
  const settings = fakeSettings(USER_SETTINGS)
  const result = await applyReport(settings, REPORT)
  assert.equal(result.written, true)
  for (const model of result.models) {
    assert.ok(typeof model.name === 'string' && model.name.length > 0)
    assert.ok(Number.isInteger(model.contextWindow))
  }

  const before = settings.snapshot()
  const broken = { entries: [{ id: '', name: 'nope', contextWindow: 0 }] }
  const refused = await applyReport(settings, broken)
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /cannot be written/)
  assert.ok(refused.problems.length > 0)
  assert.equal(settings.calls.mutate, 1, 'the refused write must not reach settings')
  const kept = settings.snapshot()['llm-pi-ai'].providers.openrouter.models
  assert.deepEqual(kept.map((m) => m.id), before['llm-pi-ai'].providers.openrouter.models.map((m) => m.id))
})

test('E4 a first write succeeds without any prior backup', async () => {
  const settings = fakeSettings({ 'llm-pi-ai': { providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' } } } })
  const result = await applyReport(settings, REPORT, { backup: async () => {} })
  assert.equal(result.written, true)
  assert.equal(result.backup.models.length, 0)
  assert.equal(settings.snapshot()['llm-pi-ai'].providers.openrouter.models.length, 2)
})

test('E3 a backup of the previous list is produced before writing', async () => {
  const settings = fakeSettings(USER_SETTINGS)
  let captured
  await applyReport(settings, REPORT, { backup: async (record) => { captured = record } })
  assert.equal(captured.provider, 'openrouter')
  assert.equal(captured.models.length, 2)
  assert.equal(captured.models[1].id, 'minimax/minimax-m3:free\t')
})

test('E8 rollback restores a captured backup', async () => {
  const settings = fakeSettings(USER_SETTINGS)
  const backup = { capturedAt: new Date().toISOString(), provider: 'openrouter', models: [{ id: 'original:free', name: 'original' }] }
  const result = await rollback(settings, backup)
  assert.equal(result.ok, true)
  assert.equal(settings.snapshot()['llm-pi-ai'].providers.openrouter.models[0].id, 'original:free')
})

test('E an unavailable settings service is reported, not thrown', async () => {
  const result = await applyReport(undefined, REPORT)
  assert.equal(result.ok, false)
  assert.match(result.reason, /settings service/)
})

test('E2 the namespace constant is the adapter namespace', () => {
  assert.equal(SETTINGS_NAMESPACE, 'llm-pi-ai')
})

test('E12 applyReport reads through the namespace, not the whole document', async () => {
  // A settings double answering for the wrong key makes applyReport see zero
  // existing models and plan a write that replaces the user's own list. The CLI
  // shipped exactly that bug, so the per-namespace contract is pinned here.
  const existing = [
    { id: 'deepseek/deepseek-v4-flash', name: 'DSH Flash' },
    { id: 'deepseek/deepseek-v4-pro', name: 'DSH Pro' },
  ]
  const asked = []
  const settings = {
    get(ns) {
      asked.push(ns)
      return ns === SETTINGS_NAMESPACE ? { providers: { openrouter: { models: existing } } } : undefined
    },
    async mutate() {},
  }

  const result = await applyReport(settings, {
    entries: [{ id: 'fresh:free', name: 'Fresh · 1K', contextWindow: 1024 }],
  }, { dryRun: true })

  assert.deepEqual(asked, [SETTINGS_NAMESPACE])
  assert.equal(result.models.length, 3, 'existing entries must be preserved')
  for (const model of existing) {
    assert.ok(result.models.some((entry) => entry.id === model.id), model.id + ' was dropped')
  }
})

test('E14 a report written out of order still lands speed-ordered', async () => {
  // Models a report cached before speed ordering existed: `entries` in catalog
  // order, speeds present only on `models`.
  const report = {
    entries: [
      { id: 'slow:free', name: 'Slow · ⚡10 tok/s · 1K', contextWindow: 1024 },
      { id: 'fast:free', name: 'Fast · ⚡200 tok/s · 1K', contextWindow: 1024 },
      { id: 'untimed:free', name: 'Untimed · 1K', contextWindow: 1024 },
    ],
    models: [
      { id: 'slow:free', speed: { tps: 10 } },
      { id: 'fast:free', speed: { tps: 200 } },
      { id: 'untimed:free', speed: { tps: null } },
    ],
  }
  const settings = { get: () => undefined, async mutate() {} }
  const result = await applyReport(settings, report, { dryRun: true })
  assert.deepEqual(result.models.map((m) => m.id), ['fast:free', 'slow:free', 'untimed:free'])
})

test('E15 existing user entries keep their order behind the ranked free models', async () => {
  const report = {
    entries: [
      { id: 'mid:free', name: 'Mid · ⚡50 tok/s · 1K', contextWindow: 1024 },
      { id: 'fast:free', name: 'Fast · ⚡200 tok/s · 1K', contextWindow: 1024 },
    ],
    models: [
      { id: 'mid:free', speed: { tps: 50 } },
      { id: 'fast:free', speed: { tps: 200 } },
    ],
  }
  const settings = {
    get: () => ({
      providers: {
        openrouter: {
          models: [
            { id: 'user/one', name: 'User One' },
            { id: 'user/two', name: 'User Two' },
          ],
        },
      },
    }),
    async mutate() {},
  }
  const result = await applyReport(settings, report, { dryRun: true })
  assert.deepEqual(
    result.models.map((m) => m.id),
    ['fast:free', 'mid:free', 'user/one', 'user/two'],
  )
})

test('E13 a merge never shrinks the list it was given', async () => {
  const existing = [
    { id: 'a:free', name: 'A' },
    { id: 'b:free', name: 'B' },
    { id: 'c:free', name: 'C' },
  ]
  const settings = {
    get: () => ({ providers: { openrouter: { models: existing } } }),
    async mutate() {},
  }
  const result = await applyReport(settings, {
    entries: [{ id: 'd:free', name: 'D · 1K', contextWindow: 1024 }],
  }, { dryRun: true })
  assert.ok(result.models.length >= existing.length, 'a merge must not lose entries')
})

test('default-model repair targets only a clean id that actually exists', () => {
  const models = [{ id: 'minimax/minimax-m3:free', name: 'x' }]
  assert.deepEqual(
    planDefaultModelRepair({ provider: 'openrouter', model: 'minimax/minimax-m3:free\t' }, models),
    { from: 'minimax/minimax-m3:free\t', to: 'minimax/minimax-m3:free' },
  )
  assert.equal(planDefaultModelRepair({ model: 'minimax/minimax-m3:free\t' }, []), null)
  assert.equal(planDefaultModelRepair({ model: 'clean:free' }, models), null)
  assert.equal(planDefaultModelRepair(undefined, models), null)
})
