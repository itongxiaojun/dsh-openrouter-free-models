/**
 * dsh-openrouter-free-models — pure core.
 *
 * Everything in this module is deterministic and side-effect free: filtering
 * the OpenRouter catalog down to free models, rendering context sizes and
 * display names, cleaning ids, merging user-authored entries, and validating
 * the result before it is allowed anywhere near the settings document.
 *
 * Keeping these functions free of I/O is what makes every acceptance criterion
 * in docs/CheckList.md testable without a network or a running harness.
 */

// ── model judgment ──────────────────────────────────────────────────────────

/** Is a numeric-or-string price field exactly zero? */
function isZeroPrice(value) {
  if (value === null || value === undefined) return false
  const text = String(value).trim()
  if (text === '') return false
  const parsed = Number(text)
  return Number.isFinite(parsed) && parsed === 0
}

/** Does the id carry OpenRouter's explicit free suffix? */
export function hasFreeSuffix(id) {
  return typeof id === 'string' && /:free$/i.test(id.trim())
}

/** Every reason this catalog entry counts as free, in a stable order. */
export function freeReasons(entry, policy = 'either') {
  const reasons = []
  const suffix = hasFreeSuffix(entry?.id)
  const zero = isZeroPrice(entry?.pricing?.prompt) && isZeroPrice(entry?.pricing?.completion)
  if (policy === 'suffix') return suffix ? ['suffix'] : []
  if (policy === 'zero-price') return zero ? ['zero-price'] : []
  if (suffix) reasons.push('suffix')
  if (zero) reasons.push('zero-price')
  return reasons
}

/** Output modalities, defaulting to text-only when the catalog omits them. */
export function outputModalities(entry) {
  const outputs = entry?.architecture?.output_modalities
  if (Array.isArray(outputs) && outputs.length > 0) return [...outputs]
  return ['text']
}

/** Input modalities, defaulting to text-only when the catalog omits them. */
export function inputModalities(entry) {
  const inputs = entry?.architecture?.input_modalities
  if (Array.isArray(inputs) && inputs.length > 0) return [...inputs]
  return ['text']
}

/** Does this entry advertise function/tool calling? */
export function supportsTools(entry) {
  const params = entry?.supported_parameters
  return Array.isArray(params) && params.includes('tools')
}

/**
 * Filter a catalog to the free models a caller actually wants.
 *
 * @param catalog - rows from GET /api/v1/models.
 * @param options - policy and exclusion switches; all optional.
 * @returns the selected rows, each annotated with how it qualified.
 */
export function selectFreeModels(catalog, options = {}) {
  const {
    policy = 'either',
    excludeIds = [],
    requireTools = true,
    textOnly = true,
  } = options
  const excluded = new Set(excludeIds.map((id) => String(id).trim()))
  const rows = Array.isArray(catalog) ? catalog : []
  const selected = []
  for (const entry of rows) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
    if (id === '') continue
    if (excluded.has(id)) continue
    const freeBy = freeReasons(entry, policy)
    if (freeBy.length === 0) continue
    if (requireTools && !supportsTools(entry)) continue
    if (textOnly) {
      const outputs = outputModalities(entry)
      if (!(outputs.length === 1 && outputs[0] === 'text')) continue
    }
    selected.push({ entry, id, freeBy })
  }
  return selected
}

// ── rendering ───────────────────────────────────────────────────────────────

/**
 * Render a token count the way a person reads it: 262144 -> "256K".
 *
 * Uses 1024-based units with floor rounding so a declared 200000 tokens never
 * reads as a larger number than it is. Sub-1K and non-positive values render
 * as a dash rather than a misleading zero.
 */
export function formatContext(tokens) {
  const value = Number(tokens)
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value >= 1024 * 1024) {
    const millions = Math.floor(value / (1024 * 1024))
    return `${millions}M`
  }
  if (value >= 1024) return `${Math.floor(value / 1024)}K`
  return String(Math.floor(value))
}

/** Strip control characters and surrounding whitespace from an id. */
export function cleanId(id) {
  if (typeof id !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return id.replace(/[\u0000-\u001F\u007F]/g, '').trim()
}

/** Default display-name template: readable label, speed, then context. */
export const DEFAULT_NAME_TEMPLATE = '{name} · {speed}{ctx}'

/**
 * Materialize a display name from a template.
 *
 * Unknown placeholders are left intact so a typo in a user template is visible
 * rather than silently swallowed.
 */
export function renderDisplayName(model, template = DEFAULT_NAME_TEMPLATE) {
  const label = cleanId(model.label) || model.id
  const speed = Number.isFinite(model?.speed?.tps) ? `⚡${Math.round(model.speed.tps)} tok/s · ` : ''
  const values = {
    name: label,
    id: model.id,
    speed,
    tps: Number.isFinite(model?.speed?.tps) ? String(Math.round(model.speed.tps)) : '',
    ttft: Number.isFinite(model?.speed?.ttftMs) ? String(Math.round(model.speed.ttftMs)) : '',
    ctx: formatContext(model.contextWindow),
  }
  const rendered = String(template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match)
  // Collapse the separator artifacts a missing segment leaves behind.
  return rendered
    .replace(/\s*·\s*(?=·)/g, ' · ')
    .replace(/·\s*$/, '')
    .replace(/^\s*·\s*/, '')
    .trim()
}

// ── merging and validation ──────────────────────────────────────────────────

/**
 * Merge freshly probed models into an existing entry list without discarding
 * anything the user authored by hand.
 *
 * Existing entries keep their extra fields (maxTokens, input, compat, …); the
 * probed entry wins only for id, name, and contextWindow — which is exactly
 * the "update the model list" semantics the feature promises. Ids are cleaned
 * first, so the historical `"minimax/minimax-m3:free\\t"` row is repaired in
 * place instead of surviving beside its clean twin.
 *
 * @param existing - the current `providers.openrouter.models` array.
 * @param probed - entries produced by the probe stage.
 * @param options - `keepUnknown` retains existing ids absent from `probed`.
 * @returns the merged array plus a change report.
 */
export function mergeModelEntries(existing, probed, options = {}) {
  const { keepUnknown = true } = options
  const existingRows = Array.isArray(existing) ? existing : []
  const probedRows = Array.isArray(probed) ? probed : []
  const byId = new Map()
  const order = []
  const repaired = []

  for (const raw of existingRows) {
    if (raw === null || typeof raw !== 'object') continue
    const id = cleanId(raw.id)
    if (id === '') continue
    if (id !== raw.id) repaired.push({ from: raw.id, to: id })
    if (byId.has(id)) continue
    byId.set(id, { ...raw, id })
    order.push(id)
  }

  const added = []
  const updated = []
  // Probed ids lead, in the probe's own (catalog) order. An existing entry
  // keeps its extra fields but yields its position: the newest ranking is the
  // ordering a user expects to see in the picker.
  const lead = []
  for (const model of probedRows) {
    const id = cleanId(model.id)
    if (id === '') continue
    const next = { id, name: model.name, contextWindow: model.contextWindow, ...model.extra }
    lead.push(id)
    if (byId.has(id)) {
      const previous = byId.get(id)
      const merged = { ...previous, ...next }
      byId.set(id, merged)
      if (previous.name !== merged.name || previous.contextWindow !== merged.contextWindow) {
        updated.push(id)
      }
    } else {
      byId.set(id, next)
      added.push(id)
    }
  }

  const probedIds = new Set(lead)
  const result = []
  const emitted = new Set()
  const named = []
  for (const id of lead) {
    if (emitted.has(id) || !byId.has(id)) continue
    emitted.add(id)
    result.push(byId.get(id))
  }
  for (const id of order) {
    if (emitted.has(id) || !byId.has(id)) continue
    if (!keepUnknown && !probedIds.has(id)) continue
    emitted.add(id)
    const kept = byId.get(id)
    // A preserved entry the catalog did not describe may predate any name —
    // an id-only row is what a hand-written settings document looks like. The
    // adapter requires a non-empty name, so synthesize the id rather than
    // carrying a row that would make the whole write invalid.
    if (typeof kept.name !== 'string' || kept.name.trim() === '') {
      named.push(id)
      result.push({ ...kept, name: id })
      continue
    }
    result.push(kept)
  }
  return { models: result, added, updated, repaired, named }
}

/** Validate one entry against the rules `llm-pi-ai` enforces on a write. */
export function validateModelEntry(entry, seen = new Set()) {
  const problems = []
  const id = typeof entry?.id === 'string' ? entry.id : ''
  if (id.trim() === '') problems.push('id must be a non-empty string')
  else if (seen.has(id)) problems.push(`duplicate model id "${id}"`)
  else seen.add(id)
  if (typeof entry?.name !== 'string' || entry.name.trim() === '') {
    problems.push(`model "${id}" must declare a non-empty name`)
  }
  if (entry?.contextWindow !== undefined
    && (!Number.isInteger(entry.contextWindow) || entry.contextWindow <= 0)) {
    problems.push(`model "${id}" contextWindow must be a positive integer`)
  }
  if (entry?.maxTokens !== undefined
    && (!Number.isInteger(entry.maxTokens) || entry.maxTokens <= 0)) {
    problems.push(`model "${id}" maxTokens must be a positive integer`)
  }
  return problems
}

/** Validate a whole list, returning every problem found. */
export function validateModelList(models) {
  const seen = new Set()
  const problems = []
  for (const entry of Array.isArray(models) ? models : []) {
    problems.push(...validateModelEntry(entry, seen))
  }
  return { ok: problems.length === 0, problems }
}

// ── report shaping ──────────────────────────────────────────────────────────

/**
 * Order probed models fastest-first, for the order they are written in.
 *
 * The model list is what a person scrolls when picking a model, so the useful
 * arrangement is by measured speed. Only a trustworthy throughput figure earns
 * a rank; models that were never measured, or whose sample was too short to
 * time (`tps: null`), cannot be placed on that scale and follow the measured
 * ones in their original catalog order — ahead of them would claim a speed
 * nobody observed.
 *
 * The sort is stable, so equal speeds keep catalog order rather than shuffling
 * between runs.
 *
 * @param models - probed model records carrying an optional `speed.tps`.
 * @returns a new array; the input is not mutated.
 */
export function sortModelsBySpeed(models) {
  const rows = Array.isArray(models) ? models : []
  const measured = []
  const unmeasured = []
  for (const model of rows) {
    if (Number.isFinite(model?.speed?.tps)) measured.push(model)
    else unmeasured.push(model)
  }
  measured.sort((a, b) => b.speed.tps - a.speed.tps)
  return [...measured, ...unmeasured]
}

/** Build the entry that will be written to settings from a probe result. */
export function toModelEntry(probe, template = DEFAULT_NAME_TEMPLATE) {
  return {
    id: cleanId(probe.id),
    name: renderDisplayName(probe, template),
    ...Number.isFinite(probe.contextWindow) && probe.contextWindow > 0
      ? { contextWindow: probe.contextWindow }
      : {},
  }
}

/** Render a compact human-readable summary of a probe report. */
export function summarizeReport(report) {
  const models = Array.isArray(report?.models) ? report.models : []
  // "Tested" means a latency was observed; a speed *ranking* additionally needs
  // a trustworthy throughput figure. A model whose only sample was too short to
  // time has `tps: null` and must not be ranked as the slowest — that reads as
  // "this model is slow" when the truth is "never measured".
  const tested = models.filter((model) => model.speed !== null && model.speed !== undefined)
  const ranked = tested.filter((model) => Number.isFinite(model.speed.tps))
  const failed = models.filter((model) => model.status === 'error')
  const skipped = models.filter((model) => model.status === 'not-tested')
  const slowest = ranked.length > 0 ? [...ranked].sort((a, b) => a.speed.tps - b.speed.tps)[0] : undefined
  const fastest = ranked.length > 0 ? [...ranked].sort((a, b) => b.speed.tps - a.speed.tps)[0] : undefined
  return {
    total: models.length,
    tested: tested.length,
    failed: failed.length,
    skipped: skipped.length,
    fastest: fastest ? `${fastest.id} (${Math.round(fastest.speed.tps)} tok/s)` : null,
    slowest: slowest ? `${slowest.id} (${Math.round(slowest.speed.tps)} tok/s)` : null,
  }
}
