import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

import { applyReport } from '../lib/apply.mjs'

/**
 * The decisive integration check: whatever this plugin writes must survive the
 * real \`dsh-llm-pi-ai\` configuration schema, and the display name it writes
 * must be the string that adapter hands to the model picker.
 *
 * It runs against the installed harness when one is present and skips cleanly
 * otherwise, so the suite stays portable without weakening the assertion on
 * the machine this feature was built for.
 */
const ADAPTER = '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
const available = existsSync(ADAPTER)

test('the written document is accepted by the real llm-pi-ai adapter', { skip: !available && 'dsh-llm-pi-ai is not installed on this machine' }, async () => {
  process.env.OPENROUTER_API_KEY ??= 'sk-not-used-by-this-test'
  const adapter = await import(ADAPTER)

  const state = {
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
  const settings = {
    get: (ns) => state[ns],
    async mutate(ns, ops) {
      for (const op of ops) state[ns][op.path[0]][op.path[1]] = structuredClone(op.value)
    },
  }

  const report = {
    entries: [
      { id: 'minimax/minimax-m3:free', name: 'MiniMax: MiniMax M3 (free) · ⚡48 tok/s · 1M', contextWindow: 1048576 },
      { id: 'inclusionai/ling-3.0-flash-fin:free', name: 'inclusionAI: Ling 3.0 Flash Fin (free) · ⚡61 tok/s · 256K', contextWindow: 262144 },
    ],
  }

  const outcome = await applyReport(settings, report, { backup: async () => {} })
  assert.equal(outcome.ok, true)

  const resolved = adapter.Config({ providers: state['llm-pi-ai'].providers })
  const models = resolved.providers.openrouter.models ?? []
  assert.equal(models.length, 2)

  // The picker shows \`name\`; speed and context must both be in it.
  const m3 = models.find((model) => model.id === 'minimax/minimax-m3:free')
  assert.equal(m3.name, 'MiniMax: MiniMax M3 (free) · ⚡48 tok/s · 1M')
  assert.equal(m3.contextWindow, 1048576)
  assert.match(m3.name, /tok\/s/)
  assert.match(m3.name, /1M$/)

  // The tab-polluted historical id must be gone, not duplicated.
  assert.ok(!models.some((model) => /[\u0000-\u001F\u007F]/.test(model.id)))

  // Untouched routes stay untouched.
  assert.deepEqual(resolved.providers.deepseek.models, [{ id: 'deepseek-v4-flash', name: 'DSH Flash', input: [], compat: { chatTemplateKwargs: {}, chatTemplateArgs: {} } }])
})
