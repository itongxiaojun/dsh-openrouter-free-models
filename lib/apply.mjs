/**
 * Applying a probe report to the DSH model list.
 *
 * Three rules govern every write here:
 *   1. Never write something the adapter would reject. Validation runs before
 *      the settings service is touched, so a bad report leaves configuration
 *      exactly as it was.
 *   2. Never destroy what the user authored. Probed entries merge into the
 *      existing list; hand-written extras survive, and a backup is taken first.
 *   3. Never assume one harness release's settings API. See {@link settingsApi}.
 */

import { cleanId, mergeModelEntries, validateModelList, summarizeReport } from './core.mjs'

/** Settings namespace and route this feature owns. */
export const SETTINGS_NAMESPACE = 'llm-pi-ai'
export const PROVIDER_ROUTE = 'openrouter'

/**
 * Which settings API the mounted service exposes.
 *
 * DSH 0.1.7 replaced the namespace store with `SettingsForms`. A namespace is
 * now a *profile entry id*, values are read with `describe()`, and writes go
 * through `update(ns, patch, revision)`. DSH 0.1.5 exposed `get(ns)` and
 * `mutate(ns, ops, revision)`, and had no `describe` at all.
 *
 * Reading the shape instead of the version keeps the plugin working across
 * both, and a service exposing neither is reported rather than guessed at —
 * guessing here is how the plugin silently refused every write on 0.1.7.
 *
 * @param settings - the mounted settings service, or a test double.
 * @returns `'forms'` (0.1.7+), `'namespaces'` (0.1.5), or `'none'`.
 */
export function settingsApi(settings) {
  if (settings === null || settings === undefined || typeof settings !== 'object') return 'none'
  if (typeof settings.describe === 'function' && typeof settings.update === 'function') return 'forms'
  if (typeof settings.get === 'function' && typeof settings.mutate === 'function') return 'namespaces'
  return 'none'
}

/** Human-readable reason for a service that cannot be used. */
function unavailableReason(api) {
  return api === 'none'
    ? 'the mounted settings service exposes neither describe()/update() (DSH 0.1.7+) nor get()/mutate() (DSH 0.1.5)'
    : 'settings service is not available in this deployment'
}

/**
 * Read one profile entry's live config through whichever API is mounted.
 *
 * @param settings - the settings service.
 * @param ns - profile entry id (0.1.7) or settings namespace (0.1.5).
 * @returns `{ api, value, revision }`; `value` is `undefined` when absent.
 */
export function readEntry(settings, ns) {
  const api = settingsApi(settings)
  if (api === 'forms') {
    const forms = settings.describe()
    const form = (Array.isArray(forms) ? forms : []).find((row) => row?.ns === ns)
    return { api, value: form?.value, revision: form?.revision }
  }
  if (api === 'namespaces') return { api, value: settings.get(ns), revision: undefined }
  return { api, value: undefined, revision: undefined }
}

/** Read one provider route's config, its model list, and the write revision. */
function readRoute(settings, provider) {
  const { api, value, revision } = readEntry(settings, SETTINGS_NAMESPACE)
  const route = value?.providers?.[provider] ?? {}
  return {
    api,
    present: value !== undefined,
    route,
    models: Array.isArray(route.models) ? route.models : [],
    revision,
  }
}

/**
 * Persist one provider route's model list.
 *
 * On 0.1.7 only the array is sent: `update` merges with `mergeLayers`, which
 * deep-merges plain objects and replaces arrays, so the route's other fields
 * and every sibling provider survive untouched. On 0.1.5 the whole route is set,
 * which is how that API expresses the same intent.
 */
async function writeRoute(settings, provider, route, models, revision) {
  const api = settingsApi(settings)
  if (api === 'forms') {
    await settings.update(SETTINGS_NAMESPACE, { providers: { [provider]: { models } } }, revision)
    return
  }
  if (api === 'namespaces') {
    await settings.mutate(SETTINGS_NAMESPACE, [
      { op: 'set', path: ['providers', provider], value: { ...route, models } },
    ], revision)
    return
  }
  throw new Error(unavailableReason(api))
}

/**
 * Order incoming entries fastest-first, reading speed from the report's models.
 *
 * The report's own `entries` carry no speed — speed lives on `models`, and only
 * in the display name afterwards. Ordering here rather than trusting the array
 * order means a report cached before this ordering existed still writes a
 * speed-ordered list, and the invariant is enforced at the one place that
 * decides the final order. Unmeasured models cannot be ranked and follow the
 * measured ones.
 *
 * @param report - the probe report, whose `models` carry `speed.tps`.
 * @param incoming - the entries about to be merged.
 * @returns a new, ordered array.
 */
function orderBySpeed(report, incoming) {
  const speedOf = new Map()
  for (const model of Array.isArray(report?.models) ? report.models : []) {
    if (Number.isFinite(model?.speed?.tps)) speedOf.set(cleanId(model.id), model.speed.tps)
  }
  const ranked = []
  const unranked = []
  for (const entry of incoming) {
    const tps = speedOf.get(cleanId(entry?.id))
    if (Number.isFinite(tps)) ranked.push({ entry, tps })
    else unranked.push(entry)
  }
  ranked.sort((a, b) => b.tps - a.tps)
  return [...ranked.map((row) => row.entry), ...unranked]
}

/**
 * Write a report's model entries into `llm-pi-ai.providers.openrouter.models`.
 *
 * @param settings - the `ctx.settings` service (or a compatible test double).
 * @param report - a report produced by {@link buildReport}.
 * @param options - merge switches and the revision observed by the caller.
 * @returns a structured outcome; never throws for a validation refusal.
 */
export async function applyReport(settings, report, options = {}) {
  const { keepUnknown = true, expectedRevision, dryRun = false, backup } = options
  const api = settingsApi(settings)
  if (api === 'none') {
    return { ok: false, reason: unavailableReason(api), settingsApi: api }
  }

  const incoming = Array.isArray(report?.entries) ? report.entries : []
  const malformed = validateModelList(incoming)
  if (!malformed.ok) {
    return {
      ok: false,
      reason: 'the probe report contains entries that cannot be written',
      problems: malformed.problems,
    }
  }

  let before
  try {
    before = readRoute(settings, PROVIDER_ROUTE)
  } catch (error) {
    return { ok: false, reason: `could not read the current model list: ${String(error?.message ?? error)}`, settingsApi: api }
  }
  if (api === 'forms' && !before.present) {
    return {
      ok: false,
      reason: `the profile has no configurable "${SETTINGS_NAMESPACE}" entry, so the model list cannot be written`,
      settingsApi: api,
    }
  }

  const ordered = orderBySpeed(report, incoming)
  const { models, added, updated, repaired } = mergeModelEntries(before.models, ordered, { keepUnknown })
  const validation = validateModelList(models)
  if (!validation.ok) {
    return {
      ok: false,
      reason: 'refusing to write a model list the adapter would reject',
      problems: validation.problems,
    }
  }

  const backupRecord = {
    capturedAt: new Date().toISOString(),
    namespace: SETTINGS_NAMESPACE,
    provider: PROVIDER_ROUTE,
    models: before.models,
  }
  if (dryRun) {
    return {
      ok: true,
      written: false,
      dryRun: true,
      settingsApi: api,
      added,
      updated,
      repaired,
      total: models.length,
      models,
      backup: backupRecord,
      summary: summarizeReport(report),
    }
  }

  if (typeof backup === 'function') {
    await backup(backupRecord)
  }

  // The revision read above wins over a caller-supplied one: it is the value
  // the same read produced, so a concurrent edit is still a conflict.
  const revision = expectedRevision ?? before.revision
  await writeRoute(settings, PROVIDER_ROUTE, before.route, models, revision)

  return {
    ok: true,
    written: true,
    dryRun: false,
    settingsApi: api,
    added,
    updated,
    repaired,
    total: models.length,
    models,
    backup: backupRecord,
    summary: summarizeReport(report),
  }
}

/** Restore a previously captured backup record. */
export async function rollback(settings, backupRecord, options = {}) {
  const api = settingsApi(settings)
  if (api === 'none') return { ok: false, reason: unavailableReason(api) }
  if (!backupRecord || !Array.isArray(backupRecord.models)) {
    return { ok: false, reason: 'backup record is missing or malformed' }
  }
  const provider = backupRecord.provider ?? PROVIDER_ROUTE
  const before = readRoute(settings, provider)
  await writeRoute(settings, provider, before.route, backupRecord.models, options.expectedRevision ?? before.revision)
  return { ok: true, restored: backupRecord.models.length, capturedAt: backupRecord.capturedAt }
}

/**
 * Repair runaway default-model selections: a historical settings document
 * pointed `agent-default-model.model` at an id with a trailing tab, which
 * resolves to nothing. Re-pointing it at the cleaned id is the smallest fix.
 */
export function planDefaultModelRepair(defaultSelection, models) {
  const current = typeof defaultSelection?.model === 'string' ? defaultSelection.model : ''
  if (current === '') return null
  const trimmed = current.replace(/[\u0000-\u001F\u007F]/g, '').trim()
  if (trimmed === current) return null
  const exists = models.some((model) => model.id === trimmed)
  if (!exists) return null
  return { from: current, to: trimmed }
}
