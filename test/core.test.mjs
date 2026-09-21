import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  hasFreeSuffix,
  freeReasons,
  supportsTools,
  selectFreeModels,
  formatContext,
  cleanId,
  renderDisplayName,
  mergeModelEntries,
  validateModelEntry,
  validateModelList,
  toModelEntry,
  summarizeReport,
  sortModelsBySpeed,
  DEFAULT_NAME_TEMPLATE,
} from '../lib/core.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/models.json', import.meta.url), 'utf8')).data

// ── C1 free-model filtering ────────────────────────────────────────────────

test('C1.1 policy=suffix accepts only :free ids', () => {
  const selected = selectFreeModels(fixture, { policy: 'suffix', requireTools: false, textOnly: false })
  assert.ok(selected.length > 0)
  for (const row of selected) assert.ok(hasFreeSuffix(row.id), row.id)
  assert.equal(selected.length, fixture.filter((m) => hasFreeSuffix(m.id)).length)
})

test('C1.2 policy=zero-price accepts only zero prompt and completion pricing', () => {
  const selected = selectFreeModels(fixture, { policy: 'zero-price', requireTools: false, textOnly: false })
  assert.ok(selected.length > 0)
  for (const row of selected) {
    assert.deepEqual(row.freeBy, ['zero-price'])
    const pricing = fixture.find((m) => m.id === row.id).pricing
    assert.equal(Number(pricing.prompt), 0)
    assert.equal(Number(pricing.completion), 0)
  }
})

test('C1.2b zero-price tolerates numeric 0 and string "0"', () => {
  const catalog = [
    { id: 'a/num', pricing: { prompt: 0, completion: 0 } },
    { id: 'b/str', pricing: { prompt: '0', completion: '0.0' } },
    { id: 'c/paid', pricing: { prompt: '0', completion: '1.5' } },
  ]
  const selected = selectFreeModels(catalog, { policy: 'zero-price', requireTools: false, textOnly: false })
  assert.deepEqual(selected.map((r) => r.id), ['a/num', 'b/str'])
})

test('C1.3 policy=either returns the union with provenance recorded', () => {
  const selected = selectFreeModels(fixture, { policy: 'either', requireTools: false, textOnly: false })
  const suffix = new Set(fixture.filter((m) => hasFreeSuffix(m.id)).map((m) => m.id))
  const zero = new Set(fixture.filter((m) => Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0).map((m) => m.id))
  assert.equal(selected.length, new Set([...suffix, ...zero]).size)
  const both = selected.find((r) => r.freeBy.length === 2)
  assert.ok(both, 'expected at least one model qualifying on both grounds')
  assert.deepEqual(both.freeBy, ['suffix', 'zero-price'])
})

test('C1.4 excludeIds removes exact ids', () => {
  const all = selectFreeModels(fixture, { policy: 'suffix', requireTools: false, textOnly: false })
  const drop = all[0].id
  const kept = selectFreeModels(fixture, { policy: 'suffix', requireTools: false, textOnly: false, excludeIds: [drop] })
  assert.equal(kept.length, all.length - 1)
  assert.ok(!kept.some((r) => r.id === drop))
})

test('C1.5 requireTools drops entries without tool support', () => {
  const withTools = selectFreeModels(fixture, { policy: 'suffix', requireTools: true, textOnly: false })
  for (const row of withTools) assert.ok(supportsTools(row.entry), row.id)
  const without = selectFreeModels(fixture, { policy: 'suffix', requireTools: false, textOnly: false })
  assert.ok(without.length >= withTools.length)
})

test('C1.6 textOnly drops non-text output modalities', () => {
  const catalog = [
    { id: 'x/text:free', architecture: { output_modalities: ['text'] } },
    { id: 'y/audio:free', architecture: { output_modalities: ['text', 'audio'] } },
  ]
  const selected = selectFreeModels(catalog, { policy: 'suffix', requireTools: false, textOnly: true })
  assert.deepEqual(selected.map((r) => r.id), ['x/text:free'])
})

test('C1.7 selection order is stable across repeated runs', () => {
  const runs = Array.from({ length: 100 }, () =>
    selectFreeModels(fixture, { policy: 'either', requireTools: true, textOnly: true }).map((r) => r.id).join(','))
  assert.equal(new Set(runs).size, 1)
})

// ── C2 context rendering ───────────────────────────────────────────────────

test('C2.1-C2.4 context renders with 1024-based floor units', () => {
  assert.equal(formatContext(262144), '256K')
  assert.equal(formatContext(1048576), '1M')
  assert.equal(formatContext(65536), '64K')
  assert.equal(formatContext(200000), '195K')
  assert.equal(formatContext(1024), '1K')
  assert.equal(formatContext(512), '512')
})

test('C2.5 invalid context renders as a dash instead of throwing', () => {
  for (const value of [null, undefined, 0, -1, NaN, 'abc', {}]) {
    assert.equal(formatContext(value), '—')
  }
})

// ── C3 display names ───────────────────────────────────────────────────────

test('C3.1 a measured model names itself with speed and context', () => {
  const name = renderDisplayName({ id: 'minimax/minimax-m3:free', label: 'MiniMax: M3 (free)', contextWindow: 1048576, speed: { tps: 48.4, ttftMs: 900 } })
  assert.equal(name, 'MiniMax: M3 (free) · ⚡48 tok/s · 1M')
})

test('C3.2 an unmeasured model omits the speed segment cleanly', () => {
  const name = renderDisplayName({ id: 'a/b:free', label: 'A: B (free)', contextWindow: 262144, speed: null })
  assert.equal(name, 'A: B (free) · 256K')
  assert.ok(!name.includes('tok/s'))
  assert.ok(!name.includes('··'))
})

test('C3.3 a missing label falls back to the id', () => {
  const name = renderDisplayName({ id: 'a/b:free', label: '', contextWindow: 65536, speed: null })
  assert.equal(name, 'a/b:free · 64K')
})

test('C3.4 custom templates expose every documented placeholder', () => {
  const model = { id: 'a/b:free', label: 'A B', contextWindow: 262144, speed: { tps: 61.7, ttftMs: 412 } }
  assert.equal(renderDisplayName(model, '{name} [{id}]'), 'A B [a/b:free]')
  assert.equal(renderDisplayName(model, '{tps}/{ttft}'), '62/412')
  assert.equal(renderDisplayName(model, '{ctx}'), '256K')
})

test('C3.5 tps is rounded to a whole number', () => {
  const name = renderDisplayName({ id: 'a:free', label: 'A', contextWindow: 1024, speed: { tps: 61.37 } })
  assert.match(name, /⚡61 tok\/s/)
  assert.ok(!name.includes('61.37'))
})

test('C3.6 generated names carry no control characters', () => {
  const name = renderDisplayName({ id: 'a:free', label: 'A\tB', contextWindow: 1024, speed: null })
  assert.ok(!/[\u0000-\u001F\u007F]/.test(name), JSON.stringify(name))
})

test('C3.7 the documented default template is the one used', () => {
  assert.equal(DEFAULT_NAME_TEMPLATE, '{name} · {speed}{ctx}')
})

// ── C4 merge and clean ─────────────────────────────────────────────────────

test('C4.1 mergeModelEntries de-duplicates ids', () => {
  const { models } = mergeModelEntries(
    [{ id: 'a:free', name: 'old' }, { id: 'a:free', name: 'older' }],
    [{ id: 'a:free', name: 'new', contextWindow: 1024 }],
  )
  assert.equal(models.length, 1)
  assert.equal(models[0].name, 'new')
})

test('C4.2 merge repairs ids polluted with control characters', () => {
  const dirty = 'minimax/minimax-m3:free\t'
  const { models, repaired } = mergeModelEntries(
    [{ id: dirty, name: 'legacy' }],
    [{ id: 'minimax/minimax-m3:free', name: 'clean', contextWindow: 1048576 }],
  )
  assert.equal(models.length, 1)
  assert.equal(models[0].id, 'minimax/minimax-m3:free')
  assert.equal(repaired.length, 1)
  assert.equal(repaired[0].from, dirty)
})

test('C4.3 merge preserves hand-authored extra fields', () => {
  const { models } = mergeModelEntries(
    [{ id: 'a:free', name: 'old', maxTokens: 4096, input: ['text', 'image'] }],
    [{ id: 'a:free', name: 'new', contextWindow: 262144 }],
  )
  assert.equal(models[0].maxTokens, 4096)
  assert.deepEqual(models[0].input, ['text', 'image'])
  assert.equal(models[0].contextWindow, 262144)
  assert.equal(models[0].name, 'new')
})

test('C4.4 a refreshed name overwrites the stale one and is reported', () => {
  const { models, updated } = mergeModelEntries(
    [{ id: 'a:free', name: 'A · 10K' }],
    [{ id: 'a:free', name: 'A · ⚡50 tok/s · 256K', contextWindow: 262144 }],
  )
  assert.equal(models[0].name, 'A · ⚡50 tok/s · 256K')
  assert.deepEqual(updated, ['a:free'])
})

test('C4.5 unknown existing entries survive by default and can be dropped', () => {
  const existing = [{ id: 'keep:free', name: 'keep' }, { id: 'gone:free', name: 'gone' }]
  const probed = [{ id: 'keep:free', name: 'keep2', contextWindow: 1024 }]
  assert.deepEqual(mergeModelEntries(existing, probed).models.map((m) => m.id), ['keep:free', 'gone:free'])
  assert.deepEqual(mergeModelEntries(existing, probed, { keepUnknown: false }).models.map((m) => m.id), ['keep:free'])
})

test('C4.8 a preserved entry with no name gets its id as a fallback name', () => {
  // This is the shape a hand-written settings document has — an id with no
  // name — and the adapter rejects a nameless entry, so the merge names it.
  const { models, named } = mergeModelEntries(
    [{ id: 'legacy:free' }],
    [{ id: 'fresh:free', name: 'Fresh · 1K', contextWindow: 1024 }],
  )
  const legacy = models.find((m) => m.id === 'legacy:free')
  assert.equal(legacy.name, 'legacy:free')
  assert.deepEqual(named, ['legacy:free'])
  assert.equal(validateModelList(models).ok, true)
})

test('C4.8 does not rename an entry that already has a name', () => {
  const { named } = mergeModelEntries([{ id: 'a:free', name: 'A · 1K' }], [])
  assert.deepEqual(named, [])
})

test('C4.6 empty inputs yield an empty list, not an exception', () => {
  assert.deepEqual(mergeModelEntries(undefined, undefined).models, [])
  assert.deepEqual(mergeModelEntries([], []).models, [])
})

test('C4.7 probed ids lead in catalog order and unprobed ids follow', () => {
  const { models, added } = mergeModelEntries(
    [{ id: 'z:free', name: 'z' }, { id: 'b:free', name: 'b' }],
    [{ id: 'a:free', name: 'a', contextWindow: 1024 }],
  )
  // "a" was newly probed and leads; the existing-but-unprobed "z" and "b" keep
  // their relative order behind it.
  assert.deepEqual(models.map((m) => m.id), ['a:free', 'z:free', 'b:free'])
  assert.deepEqual(added, ['a:free'])
})

test('cleanId strips tabs, newlines, and surrounding space', () => {
  assert.equal(cleanId('  a:free\t'), 'a:free')
  assert.equal(cleanId('a\n:free'), 'a:free')
  assert.equal(cleanId(undefined), '')
})

// ── C5 validation ──────────────────────────────────────────────────────────

test('C5.1-C5.5 validation names every problem it finds', () => {
  assert.deepEqual(validateModelEntry({ id: '', name: 'x' }), ['id must be a non-empty string'])
  const seen = new Set()
  validateModelEntry({ id: 'a', name: 'a' }, seen)
  assert.ok(validateModelEntry({ id: 'a', name: 'a' }, seen).some((p) => p.includes('duplicate')))
  assert.ok(validateModelEntry({ id: 'b', name: '' }).some((p) => p.includes('non-empty name')))
  assert.ok(validateModelEntry({ id: 'c', name: 'c', contextWindow: 0 }).some((p) => p.includes('contextWindow')))
  assert.ok(validateModelEntry({ id: 'd', name: 'd', maxTokens: -5 }).some((p) => p.includes('maxTokens')))
})

test('C5 accepts a well-formed list and rejects a mixed one', () => {
  assert.equal(validateModelList([{ id: 'a', name: 'A', contextWindow: 1024 }]).ok, true)
  const bad = validateModelList([{ id: 'a', name: 'A' }, { id: 'a', name: 'A' }, { id: '', name: '' }])
  assert.equal(bad.ok, false)
  assert.ok(bad.problems.length >= 3)
})

// ── report shaping ─────────────────────────────────────────────────────────

test('toModelEntry projects a probe into a settings entry', () => {
  const entry = toModelEntry({ id: 'a/b:free', label: 'A: B', contextWindow: 262144, speed: { tps: 30 } })
  assert.deepEqual(entry, { id: 'a/b:free', name: 'A: B · ⚡30 tok/s · 256K', contextWindow: 262144 })
})

test('toModelEntry omits contextWindow when the catalog did not declare one', () => {
  const entry = toModelEntry({ id: 'a/b:free', label: 'A', contextWindow: null, speed: null })
  assert.equal('contextWindow' in entry, false)
})

test('summarizeReport counts tested, failed, and skipped models', () => {
  const summary = summarizeReport({
    models: [
      { id: 'a', status: 'ok', speed: { tps: 10 } },
      { id: 'b', status: 'ok', speed: { tps: 90 } },
      { id: 'c', status: 'error' },
      { id: 'd', status: 'not-tested' },
    ],
  })
  assert.equal(summary.total, 4)
  assert.equal(summary.tested, 2)
  assert.equal(summary.failed, 1)
  assert.equal(summary.skipped, 1)
  assert.match(summary.fastest, /^b \(90 tok\/s\)$/)
  assert.match(summary.slowest, /^a \(10 tok\/s\)$/)
})

test('sortModelsBySpeed orders fastest first', () => {
  const models = [
    { id: 'slow', speed: { tps: 12 } },
    { id: 'fast', speed: { tps: 250 } },
    { id: 'mid', speed: { tps: 60 } },
  ]
  assert.deepEqual(sortModelsBySpeed(models).map((m) => m.id), ['fast', 'mid', 'slow'])
})

test('sortModelsBySpeed leaves unmeasured models last, in catalog order', () => {
  const models = [
    { id: 'untimed-a', speed: null },
    { id: 'measured', speed: { tps: 40 } },
    { id: 'untimed-b', speed: { tps: null } },
    { id: 'failed', status: 'error' },
  ]
  assert.deepEqual(
    sortModelsBySpeed(models).map((m) => m.id),
    ['measured', 'untimed-a', 'untimed-b', 'failed'],
  )
})

test('sortModelsBySpeed is stable for equal speeds', () => {
  const models = [
    { id: 'first', speed: { tps: 50 } },
    { id: 'second', speed: { tps: 50 } },
    { id: 'third', speed: { tps: 50 } },
  ]
  assert.deepEqual(sortModelsBySpeed(models).map((m) => m.id), ['first', 'second', 'third'])
})

test('sortModelsBySpeed does not mutate its input', () => {
  const models = [
    { id: 'a', speed: { tps: 1 } },
    { id: 'b', speed: { tps: 9 } },
  ]
  const before = models.map((m) => m.id)
  sortModelsBySpeed(models)
  assert.deepEqual(models.map((m) => m.id), before)
})

test('sortModelsBySpeed tolerates empty and malformed input', () => {
  assert.deepEqual(sortModelsBySpeed(undefined), [])
  assert.deepEqual(sortModelsBySpeed([]), [])
  assert.equal(sortModelsBySpeed([{ id: 'x' }, {}]).length, 2)
})

test('summarizeReport never ranks an unmeasured model as slowest', () => {
  // A very fast model whose sample was too short to time reports tps: null.
  // It must not take the "slowest" slot, which would read as a real finding.
  const summary = summarizeReport({
    models: [
      { id: 'measured-slow', status: 'ok', speed: { tps: 12 } },
      { id: 'measured-fast', status: 'ok', speed: { tps: 200 } },
      { id: 'untimed', status: 'ok', speed: { tps: null, lowConfidence: true } },
    ],
  })
  assert.equal(summary.tested, 3)
  assert.match(summary.slowest, /^measured-slow/)
  assert.match(summary.fastest, /^measured-fast/)
})

test('summarizeReport omits the rankings when nothing was timed', () => {
  const summary = summarizeReport({ models: [{ id: 'a', status: 'ok', speed: { tps: null } }] })
  assert.equal(summary.fastest, null)
  assert.equal(summary.slowest, null)
})

test('freeReasons reports nothing for a paid model under every policy', () => {
  const paid = { id: 'a/b', pricing: { prompt: '0.5', completion: '1' } }
  assert.deepEqual(freeReasons(paid, 'suffix'), [])
  assert.deepEqual(freeReasons(paid, 'zero-price'), [])
  assert.deepEqual(freeReasons(paid, 'either'), [])
})
