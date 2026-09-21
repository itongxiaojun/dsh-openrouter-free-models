/**
 * Applying a probe report to the DSH model list.
 *
 * Two rules govern every write here:
 *   1. Never write something the adapter would reject. Validation runs before
 *      the settings service is touched, so a bad report leaves configuration
 *      exactly as it was.
 *   2. Never destroy what the user authored. Probed entries merge into the
 *      existing list; hand-written extras survive, and a backup is taken first.
 */

import { cleanId, mergeModelEntries, validateModelList, summarizeReport } from './core.mjs'

/** Settings namespace and route this feature owns. */
export const SETTINGS_NAMESPACE = 'llm-pi-ai'
export const PROVIDER_ROUTE = 'openrouter'

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
  if (!settings || typeof settings.get !== 'function') {
    return { ok: false, reason: 'settings service is not available in this deployment' }
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

  const before = settings.get(SETTINGS_NAMESPACE) ?? {}
  const route = before?.providers?.[PROVIDER_ROUTE] ?? {}
  const existingModels = Array.isArray(route.models) ? route.models : []

  const ordered = orderBySpeed(report, incoming)
  const { models, added, updated, repaired } = mergeModelEntries(existingModels, ordered, { keepUnknown })
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
    models: existingModels,
  }
  if (dryRun) {
    return {
      ok: true,
      written: false,
      dryRun: true,
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

  const nextRoute = { ...route, models }
  await settings.mutate(SETTINGS_NAMESPACE, [
    { op: 'set', path: ['providers', PROVIDER_ROUTE], value: nextRoute },
  ], expectedRevision)

  return {
    ok: true,
    written: true,
    dryRun: false,
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
  if (!settings || typeof settings.mutate !== 'function') {
    return { ok: false, reason: 'settings service is not available in this deployment' }
  }
  if (!backupRecord || !Array.isArray(backupRecord.models)) {
    return { ok: false, reason: 'backup record is missing or malformed' }
  }
  const before = settings.get(SETTINGS_NAMESPACE) ?? {}
  const route = before?.providers?.[backupRecord.provider ?? PROVIDER_ROUTE] ?? {}
  const provider = backupRecord.provider ?? PROVIDER_ROUTE
  await settings.mutate(SETTINGS_NAMESPACE, [
    { op: 'set', path: ['providers', provider], value: { ...route, models: backupRecord.models } },
  ], options.expectedRevision)
  return { ok: true, restored: backupRecord.models.length, capturedAt: backupRecord.capturedAt }
}

/**
 * Repair runaway default-model selections: the historical settings document
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
