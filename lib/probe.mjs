/**
 * Probe orchestration: turn a raw catalog into measured model records.
 *
 * The orchestration is deliberately boring — a bounded worker pool, an
 * independent timeout per model, and `allSettled` semantics so one dead free
 * model cannot sink a whole refresh. Credential failures are special-cased:
 * a 401 means the key is bad for every model, so the round stops instead of
 * hammering 24 endpoints to learn the same thing 24 times.
 */

import {
  selectFreeModels,
  sortModelsBySpeed,
  cleanId,
  inputModalities,
  outputModalities,
  supportsTools,
  toModelEntry,
  DEFAULT_NAME_TEMPLATE,
} from './core.mjs'
import { measureCompletion, OpenRouterError } from './or-client.mjs'

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = new Array(Math.max(1, Math.min(limit, items.length)))
  for (let index = 0; index < runners.length; index += 1) {
    runners[index] = (async () => {
      for (;;) {
        const current = cursor
        cursor += 1
        if (current >= items.length) return
        results[current] = await worker(items[current], current)
      }
    })()
  }
  await Promise.all(runners)
  return results
}

/**
 * Probe every selected free model.
 *
 * @param selected - rows from {@link selectFreeModels}.
 * @param options - credentials, transport knobs, and reporting switches.
 * @returns `{ models, apiKeySource, probedAt, notes }`.
 */
export async function probeModels(selected, options = {}) {
  const {
    apiKey,
    apiKeySource = null,
    fetchImpl = globalThis.fetch,
    concurrency = 3,
    timeoutMs = 30_000,
    maxTokens = 32,
    samples = 1,
    prompt,
    nameTemplate = DEFAULT_NAME_TEMPLATE,
    signal,
  } = options

  const base = selected.map((row) => ({
    id: cleanId(row.id),
    label: entryLabel(row.entry),
    contextWindow: declaredContext(row.entry),
    freeBy: row.freeBy,
    toolSupport: supportsTools(row.entry),
    inputModalities: inputModalities(row.entry),
    outputModalities: outputModalities(row.entry),
    speed: null,
    contextProbe: null,
    status: 'not-tested',
    error: undefined,
  }))

  const notes = []
  if (!apiKey) {
    notes.push('no credential resolved for OPENROUTER_API_KEY: speed was not measured (free models still require a key)')
    for (const model of base) {
      model.status = 'not-tested'
      model.error = 'skipped: no credential'
    }
    return {
      apiKeySource,
      probedAt: new Date().toISOString(),
      notes,
      models: base.map((model) => finalizeModel(model, nameTemplate)),
    }
  }

  // One rejected key invalidates every remaining request, so the first 401
  // aborts the in-flight probes instead of letting them all fail the same way.
  const abort = new AbortController()
  if (signal) signal.addEventListener('abort', () => abort.abort(), { once: true })
  let credentialRejected = false
  const measured = await mapWithConcurrency(base, concurrency, async (model) => {
    if (credentialRejected || abort.signal.aborted) {
      model.status = 'not-tested'
      model.error = 'skipped: credential rejected earlier in this round'
      return model
    }
    const runs = []
    for (let attempt = 0; attempt < Math.max(1, samples); attempt += 1) {
      if (abort.signal.aborted) break
      const result = await measureCompletion(
        { id: model.id, apiKey },
        { fetchImpl, timeoutMs, maxTokens, prompt, signal: abort.signal },
      )
      if (result.status === 'error' && result.unauthorized) {
        credentialRejected = true
        abort.abort()
        model.status = 'error'
        model.error = result.error
        return model
      }
      runs.push(result)
    }
    if (runs.length === 0) {
      model.status = 'not-tested'
      model.error = 'skipped: credential rejected earlier in this round'
      return model
    }
    const usable = runs.filter((run) => run.status === 'ok' && Number.isFinite(run.tps))
    if (usable.length > 0) {
      model.status = 'ok'
      model.speed = {
        tps: median(usable.map((run) => run.tps)),
        ttftMs: median(usable.map((run) => run.ttftMs).filter(Number.isFinite)),
        samples: usable.length,
        lowConfidence: runs.every((run) => run.lowConfidence === true),
      }
      return model
    }
    const labeled = runs.filter((run) => run.status === 'ok')
    if (labeled.length > 0) {
      model.status = 'ok'
      model.speed = {
        tps: null,
        ttftMs: median(labeled.map((run) => run.ttftMs).filter(Number.isFinite)),
        samples: labeled.length,
        lowConfidence: true,
      }
      model.error = labeled[0].note ?? 'latency measured, throughput unavailable'
      return model
    }
    model.status = 'error'
    model.error = runs[0]?.error ?? 'probe failed'
    if (runs[0]?.rateLimited) notes.push(`${model.id} was rate limited during probing`)
    return model
  })

  if (credentialRejected) {
    notes.push('OPENROUTER_API_KEY was rejected with HTTP 401/403: replace it on the Models settings page, then re-run')
  }
  const unmeasured = measured.filter((model) => model.status === 'not-tested').length
  if (unmeasured > 0 && !credentialRejected) {
    notes.push(`${unmeasured} model(s) were not measured (run was aborted or skipped)`)
  }
  return {
    apiKeySource,
    probedAt: new Date().toISOString(),
    notes,
    models: measured.map((model) => finalizeModel(model, nameTemplate)),
  }
}

/** Attach the display name every consumer reads. */
function finalizeModel(model, template) {
  return { ...model, displayName: toModelEntry(model, template).name }
}

/** The human label the catalog ships, falling back to a de-suffixed id. */
function entryLabel(entry) {
  const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
  if (name !== '') return name
  const id = typeof entry?.id === 'string' ? entry.id.replace(/:free$/i, '') : ''
  return id
}

/** Declared context length, preferring the per-request provider figure. */
function declaredContext(entry) {
  const top = Number(entry?.top_provider?.context_length)
  const outer = Number(entry?.context_length)
  if (Number.isInteger(top) && top > 0) return Math.min(Number.isInteger(outer) && outer > 0 ? outer : top, top)
  if (Number.isInteger(outer) && outer > 0) return outer
  return null
}

/** Median of a numeric list; NaN-free input assumed. */
function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * Build a complete report from a catalog: filter, probe, name, and record the
 * settings payload that an `apply` would write. Performs no writes.
 */
export async function buildReport(catalog, options = {}) {
  const {
    policy = 'either',
    excludeIds = [],
    requireTools = true,
    textOnly = true,
    nameTemplate = DEFAULT_NAME_TEMPLATE,
    extraEntryFields = {},
    ...probeOptions
  } = options
  const selected = selectFreeModels(catalog, { policy, excludeIds, requireTools, textOnly })
  const probe = await probeModels(selected, { ...probeOptions, nameTemplate })
  // Fastest first. `mergeModelEntries` writes probed ids in the order it
  // receives them, and leads with them, so ordering here is what decides the
  // order of the model list in Settings.
  const ordered = sortModelsBySpeed(probe.models)
  const entries = ordered.map((model) => ({
    ...toModelEntry(model, nameTemplate),
    ...extraEntryFields,
  }))
  return {
    version: 1,
    source: 'openrouter',
    policy,
    catalogSize: Array.isArray(catalog) ? catalog.length : 0,
    selectedCount: selected.length,
    apiKeySource: probe.apiKeySource,
    probedAt: probe.probedAt,
    notes: probe.notes,
    models: ordered,
    entries,
  }
}

export { OpenRouterError }
