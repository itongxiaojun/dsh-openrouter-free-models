import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Lifecycle tests against the harness's real Cordis runtime.
 *
 * The plugin's tool registration must be owned by its fiber: a registration
 * that outlives the plugin is a leak the harness would carry until restart,
 * and it is invisible to any test that only checks "a tool got registered".
 */
import { harnessPath } from './harness-path.mjs'

const CORDIS = harnessPath('node_modules/@deepseek-ai/cordis/lib/index.js')
const available = CORDIS !== undefined
const PLUGIN = fileURLToPath(new URL('../lib/index.mjs', import.meta.url))

/** Mount the plugin against a stubbed \`tools\` service. */
async function mount() {
  const { Context } = await import(CORDIS)
  const ctx = new Context()
  const state = { registered: [], disposed: 0 }
  ctx.provide('dshHomePath', (segment) => '/tmp/dsh-test/' + segment)
  ctx.plugin({
    name: 'test-tools',
    apply(c) {
      c.provide('tools', {
        defineTool: (definition) => definition,
        register(definition) {
          state.registered.push(definition)
          return () => { state.disposed += 1 }
        },
      })
    },
  })
  const plugin = await import(PLUGIN)
  await ctx.plugin(plugin)
  return { ctx, state, plugin }
}

/** Mount the plugin into an existing context and return the tool it registers. */
async function mountIntoSibling(ctx) {
  let registered
  ctx.plugin({
    name: 'sibling-tools',
    apply(c) {
      c.provide('tools', { register(definition) { registered = definition; return () => {} } })
    },
  })
  await ctx.plugin(await import(PLUGIN))
  return registered
}

test('the plugin exports the Cordis plugin surface', { skip: !available && 'cordis is not installed here' }, async () => {
  const plugin = await import(PLUGIN)
  assert.equal(plugin.name, 'openrouter-free-models')
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(Array.isArray(plugin.inject))
  assert.deepEqual(plugin.inject, [], 'a required inject list would stop apply from running at all')
})

test('mounting registers exactly one tool with the declared arguments', { skip: !available && 'cordis is not installed here' }, async () => {
  const { state } = await mount()
  assert.equal(state.registered.length, 1)
  const tool = state.registered[0]
  assert.equal(tool.name, 'openrouter_free_models')

  // `register()` consumes normalized JSON Schema: object-level `required`
  // arrays, never `required: true` on a property.
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.deepEqual(tool.parameters.properties.action.enum, ['list', 'probe', 'apply', 'rollback'])
  assert.equal(typeof tool.output.render, 'function')
  assert.deepEqual(tool.output.schema.required, ['action', 'ok'])
})

test('every declared schema passes the harness JSON-Schema validator', { skip: !available && 'cordis is not installed here' }, async () => {
  // The validator ToolRuntime.register() runs. A schema that violates it makes
  // the whole tool disappear at load, which is exactly how this plugin broke
  // the first time it was installed, so it is asserted rather than assumed.
  const { assertSupportedJsonSchema, assertObjectJsonSchema } =
    await import(harnessPath('node_modules/@deepseek-ai/dsh-tools/lib/index.js'))
  const { state } = await mount()
  const tool = state.registered[0]
  assert.doesNotThrow(() => assertSupportedJsonSchema(tool.parameters))
  assertObjectJsonSchema(tool.output.schema)
})

test('the schema declares no per-property required shorthand', { skip: !available && 'cordis is not installed here' }, async () => {
  const { state } = await mount()
  const schema = state.registered[0].output.schema
  for (const [key, node] of Object.entries(schema.properties)) {
    assert.equal(Object.hasOwn(node, 'required'), false, `output property "${key}" must not carry required: true`)
  }
})

test('unloading the plugin disposes its tool registration', { skip: !available && 'cordis is not installed here' }, async () => {
  const { ctx, state } = await mount()
  assert.equal(state.disposed, 0)
  await ctx.fiber.dispose()
  assert.equal(state.disposed, 1, 'the tool must not outlive the plugin that registered it')
})

test('the tool reaches a settings service provided by a sibling layer', { skip: !available && 'cordis is not installed here' }, async () => {
  // Regression: the tool's execute used to rebuild the shared paths bundle
  // field by field, silently dropping the settings accessor, so every write
  // failed with "paths.settings is not a function". The settings provider is
  // also a *sibling* here, which is how the real profile composes it.
  const { Context } = await import(CORDIS)
  const { mkdirSync, rmSync, writeFileSync } = await import('node:fs')

  const home = '/tmp/dsh-plugin-settings-path'
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home + '/storages', { recursive: true })

  const ctx = new Context()
  ctx.provide('dshHomePath', (segment) => home + '/' + segment)
  const writes = []
  ctx.plugin({
    name: 'sibling-settings',
    apply(c) {
      c.provide('settings', {
        describe: () => [{ ns: 'llm-pi-ai', revision: 3, value: { providers: { openrouter: { models: [] } } } }],
        async update(ns, patch, revision) {
          writes.push({ ns, revision, ids: patch.providers.openrouter.models.map((m) => m.id) })
        },
      })
    },
  })
  const tool = await mountIntoSibling(ctx)
  await new Promise((resolve) => setTimeout(resolve, 40))

  writeFileSync(home + '/storages/openrouter-free-models.backup.json', JSON.stringify({
    capturedAt: '2026-01-01T00:00:00Z',
    provider: 'openrouter',
    models: [{ id: 'restored:free', name: 'Restored' }],
  }))

  const result = await tool.execute({ action: 'rollback' })
  assert.equal(result.ok, true, 'the write path must reach the sibling settings service')
  assert.equal(result.restored, 1)
  assert.deepEqual(writes, [{ ns: 'llm-pi-ai', revision: 3, ids: ['restored:free'] }])
  await ctx.fiber.dispose()
})

test('the plugin mounts without a tools service and disposes cleanly', { skip: !available && 'cordis is not installed here' }, async () => {
  const { Context } = await import(CORDIS)
  const ctx = new Context()
  ctx.provide('dshHomePath', (segment) => '/tmp/dsh-test/' + segment)
  const plugin = await import(PLUGIN)
  // No `tools` service exists: activation must still succeed, and teardown must
  // not throw. This is the degrade path a headless deployment takes.
  await ctx.plugin(plugin)
  assert.equal(ctx.get('tools'), undefined)
  await ctx.fiber.dispose()
})

test('a tool registered later is picked up when the service appears', { skip: !available && 'cordis is not installed here' }, async () => {
  const { Context } = await import(CORDIS)
  const ctx = new Context()
  const state = { registered: [], disposed: 0 }
  ctx.provide('dshHomePath', (segment) => '/tmp/dsh-test/' + segment)
  const plugin = await import(PLUGIN)
  await ctx.plugin(plugin)
  assert.equal(state.registered.length, 0, 'nothing to register before the service exists')

  // Late-mounting the service is the ordering a real profile can produce.
  ctx.plugin({
    name: 'late-tools',
    apply(c) {
      c.provide('tools', {
        defineTool: (definition) => definition,
        register(definition) {
          state.registered.push(definition)
          return () => { state.disposed += 1 }
        },
      })
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(state.registered.length, 1, 'the deferred injection should have fired')
  await ctx.fiber.dispose()
  assert.equal(state.disposed, 1)
})
