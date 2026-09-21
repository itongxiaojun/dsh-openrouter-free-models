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
const CORDIS = '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/cordis/lib/index.js'
const available = existsSync(CORDIS)
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
    await import('/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
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
