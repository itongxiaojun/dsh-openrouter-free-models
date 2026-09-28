import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyReport, readEntry, rollback, settingsApi, SETTINGS_NAMESPACE, PROVIDER_ROUTE } from '../lib/apply.mjs'

/**
 * Coverage for the settings service as DSH 0.1.7 ships it.
 *
 * 0.1.7 replaced the namespace store with SettingsForms: a namespace is a
 * *profile entry id*, values are read with describe(), and writes go through
 * update(ns, patch, revision). The old get()/mutate() pair is gone entirely,
 * which is what made every write fail with "settings service is not available"
 * even though the service was mounted.
 */

/** A double shaped like the 0.1.7 SettingsForms service. */
function formsSettings({ models = [], extraProviders = {}, revision = 7, present = true } = {}) {
  const state = {
    [SETTINGS_NAMESPACE]: {
      providers: {
        ...extraProviders,
        [PROVIDER_ROUTE]: { apiKeyEnv: 'OPENROUTER_API_KEY', api: 'openai-completions', models },
      },
    },
  }
  const calls = { describe: 0, update: [] }
  return {
    calls,
    state,
    describe() {
      calls.describe += 1
      if (!present) return []
      return [{
        ns: SETTINGS_NAMESPACE,
        revision,
        value: structuredClone(state[SETTINGS_NAMESPACE]),
      }]
    },
    async update(ns, patch, expectedRevision) {
      calls.update.push({ ns, patch, expectedRevision })
      assert.equal(ns, SETTINGS_NAMESPACE)
      assert.equal(expectedRevision, revision)
      // Mirror mergeLayers: deep-merge plain objects, arrays replace.
      const current = state[ns]
      for (const [provider, route] of Object.entries(patch.providers ?? {})) {
        current.providers[provider] = { ...(current.providers[provider] ?? {}), ...route }
      }
    },
  }
}

/** A 0.1.7-shaped service whose write always fails with a given message. */
function settingsWithFailingUpdate(message) {
  const settings = formsSettings({ models: [] })
  settings.update = async () => { throw new Error(message) }
  return settings
}

const REPORT = {
  entries: [
    { id: 'slow:free', name: 'Slow · ⚡10 tok/s · 1K', contextWindow: 1024 },
    { id: 'fast:free', name: 'Fast · ⚡200 tok/s · 1K', contextWindow: 1024 },
  ],
  models: [
    { id: 'slow:free', speed: { tps: 10 } },
    { id: 'fast:free', speed: { tps: 200 } },
  ],
}

// ── API detection ──────────────────────────────────────────────────────────

test('settingsApi distinguishes the 0.1.7, 0.1.5, and unusable shapes', () => {
  assert.equal(settingsApi({ describe() {}, update() {} }), 'forms')
  assert.equal(settingsApi({ get() {}, mutate() {} }), 'namespaces')
  assert.equal(settingsApi({}), 'none')
  assert.equal(settingsApi(undefined), 'none')
  assert.equal(settingsApi(null), 'none')
})

test('a service with only get() is not mistaken for a writable one', () => {
  // 0.1.7 has describe() but the guard needs BOTH halves to call it usable.
  assert.equal(settingsApi({ describe() {} }), 'none')
  assert.equal(settingsApi({ get() {} }), 'none')
})

test('an unusable service is reported with the API shape that was found', () => {
  return applyReport({}, REPORT).then((result) => {
    assert.equal(result.ok, false)
    assert.equal(result.settingsApi, 'none')
    assert.match(result.reason, /describe\(\)\/update\(\)/)
  })
})

// ── reading ────────────────────────────────────────────────────────────────

test('readEntry reads a value and revision through describe()', () => {
  const settings = formsSettings({ models: [{ id: 'a:free', name: 'A' }] })
  const entry = readEntry(settings, SETTINGS_NAMESPACE)
  assert.equal(entry.api, 'forms')
  assert.equal(entry.revision, 7)
  assert.equal(entry.value.providers[PROVIDER_ROUTE].models.length, 1)
})

test('readEntry answers undefined for an entry the profile does not configure', () => {
  const entry = readEntry(formsSettings({ present: false }), 'agent-default-model')
  assert.equal(entry.api, 'forms')
  assert.equal(entry.value, undefined)
})

// ── writing ────────────────────────────────────────────────────────────────

test('applyReport writes through update() with the describe() revision', async () => {
  const settings = formsSettings({ models: [{ id: 'old:free', name: 'Old' }] })
  const result = await applyReport(settings, REPORT, { backup: async () => {} })

  assert.equal(result.ok, true)
  assert.equal(result.written, true)
  assert.equal(result.settingsApi, 'forms')
  assert.equal(settings.calls.update.length, 1)
  assert.equal(settings.calls.update[0].expectedRevision, 7)

  // Fastest first, and the pre-existing entry preserved.
  const written = settings.state[SETTINGS_NAMESPACE].providers[PROVIDER_ROUTE].models.map((m) => m.id)
  assert.deepEqual(written, ['fast:free', 'slow:free', 'old:free'])
})

test('the write sends only the models array, leaving siblings alone', async () => {
  const settings = formsSettings({ extraProviders: { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' } } })
  await applyReport(settings, REPORT, { backup: async () => {} })
  const patch = settings.calls.update[0].patch
  assert.deepEqual(Object.keys(patch), ['providers'])
  assert.deepEqual(Object.keys(patch.providers), [PROVIDER_ROUTE])
  assert.deepEqual(Object.keys(patch.providers[PROVIDER_ROUTE]), ['models'])
  // The sibling provider is untouched in state.
  assert.deepEqual(settings.state[SETTINGS_NAMESPACE].providers.deepseek, { apiKeyEnv: 'DEEPSEEK_API_KEY' })
})

test('route fields the plugin does not own survive the merge', async () => {
  const settings = formsSettings({ models: [] })
  await applyReport(settings, REPORT, { backup: async () => {} })
  const route = settings.state[SETTINGS_NAMESPACE].providers[PROVIDER_ROUTE]
  assert.equal(route.apiKeyEnv, 'OPENROUTER_API_KEY')
  assert.equal(route.api, 'openai-completions')
})

test('a profile without the entry refuses instead of inventing one', async () => {
  const settings = formsSettings({ present: false })
  const result = await applyReport(settings, REPORT, { backup: async () => {} })
  assert.equal(result.ok, false)
  assert.match(result.reason, /no configurable/)
  assert.equal(settings.calls.update.length, 0)
})

test('a dry run on 0.1.7 never calls update()', async () => {
  const settings = formsSettings()
  const result = await applyReport(settings, REPORT, { dryRun: true })
  assert.equal(result.dryRun, true)
  assert.equal(result.settingsApi, 'forms')
  assert.equal(settings.calls.update.length, 0)
  assert.ok(result.models.length > 0)
})

test('rollback restores through update() on 0.1.7', async () => {
  const settings = formsSettings({ models: [{ id: 'current:free', name: 'Current' }] })
  const result = await rollback(settings, {
    capturedAt: '2026-01-01T00:00:00Z',
    provider: PROVIDER_ROUTE,
    models: [{ id: 'restored:free', name: 'Restored' }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.restored, 1)
  const written = settings.state[SETTINGS_NAMESPACE].providers[PROVIDER_ROUTE].models.map((m) => m.id)
  assert.deepEqual(written, ['restored:free'])
})

// ── the wire-protocol fallback ─────────────────────────────────────────────

/**
 * A 0.1.7 service that rejects the first write the way the real adapter does
 * when a model is missing from the installed pi-ai catalog.
 */
function pickySettings({ failTimes = 1 } = {}) {
  const settings = formsSettings({ models: [] })
  // The failing scenario is a route with NO declared protocol: that is exactly
  // when the adapter refuses, and exactly when the fallback applies.
  delete settings.state[SETTINGS_NAMESPACE].providers[PROVIDER_ROUTE].api
  const message = 'llm-pi-ai: provider "openrouter" model "stealth/space-bunny-alpha" needs an api; '
    + "the installed catalog does not describe it, so set the route's api to the wire protocol its endpoint speaks"
  let failures = 0
  // Record every attempt, including the rejected one: the whole point is that
  // the first attempt is refused and the second carries the protocol.
  settings.attempts = []
  const originalUpdate = settings.update
  settings.update = async (ns, patch, revision) => {
    const route = patch.providers?.[PROVIDER_ROUTE]
    settings.attempts.push(structuredClone(route))
    if (route?.api === undefined && failures < failTimes) {
      failures += 1
      throw new Error(message)
    }
    return originalUpdate(ns, patch, revision)
  }
  return settings
}

test('a model the catalog cannot describe triggers the wire-protocol fallback', async () => {
  const settings = pickySettings()
  const result = await applyReport(settings, REPORT, { backup: async () => {} })

  assert.equal(result.ok, true, 'the retry must make the write succeed')
  assert.equal(result.apiAdded, true)
  assert.equal(settings.attempts.length, 2, 'one rejected attempt, one retry')

  // The first attempt sent nothing but the array; the retry added the protocol.
  assert.deepEqual(Object.keys(settings.attempts[0]), ['models'])
  assert.equal(settings.attempts[1].api, 'openai-completions')

  // And it landed.
  const route = settings.state[SETTINGS_NAMESPACE].providers[PROVIDER_ROUTE]
  assert.equal(route.api, 'openai-completions')
  assert.equal(route.models.length, 2)
})

test('a successful write reports apiAdded false and never retries', async () => {
  const settings = pickySettings({ failTimes: 0 })
  const result = await applyReport(settings, REPORT, { backup: async () => {} })
  assert.equal(result.ok, true)
  assert.equal(result.apiAdded, false)
  assert.equal(settings.calls.update.length, 1)
})

test('an unrelated write failure is not swallowed by the retry', async () => {
  const settings = settingsWithFailingUpdate('settings namespace "llm-pi-ai" changed since it was read')
  await assert.rejects(
    () => applyReport(settings, REPORT, { backup: async () => {} }),
    /changed since it was read/,
  )
})

test('a route carrying its own api is not quietly rewritten onto ours', async () => {
  const settings = formsSettings({ models: [] })
  settings.state[SETTINGS_NAMESPACE].providers[PROVIDER_ROUTE].api = 'anthropic-messages'
  settings.update = async () => { throw new Error('model "x" needs an api') }
  await assert.rejects(
    () => applyReport(settings, REPORT, { backup: async () => {} }),
    /needs an api/,
  )
})

// ── the 0.1.5 path still works ─────────────────────────────────────────────

test('the 0.1.5 get()/mutate() service keeps working', async () => {
  const state = { [SETTINGS_NAMESPACE]: { providers: { [PROVIDER_ROUTE]: { models: [] } } } }
  const calls = { mutate: 0 }
  const settings = {
    get: (ns) => state[ns],
    async mutate(ns, ops, revision) {
      calls.mutate += 1
      for (const op of ops) {
        const path = [...op.path]
        let cursor = state[ns]
        while (path.length > 1) cursor = cursor[path.shift()]
        cursor[path[0]] = structuredClone(op.value)
      }
    },
  }
  const result = await applyReport(settings, REPORT, { backup: async () => {} })
  assert.equal(result.ok, true)
  assert.equal(result.settingsApi, 'namespaces')
  assert.equal(calls.mutate, 1)
  const written = state[SETTINGS_NAMESPACE].providers[PROVIDER_ROUTE].models.map((m) => m.id)
  assert.deepEqual(written, ['fast:free', 'slow:free'])
})
