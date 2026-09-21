/**
 * dsh-openrouter-free-models — a DSH (DeepSeek Harness) Cordis plugin.
 *
 * It discovers OpenRouter's free models, measures how fast they actually
 * answer and how much context they really take, and writes the survivors into
 * this harness's OpenRouter model list with speed and context in the display
 * name.
 *
 * Why it writes to settings rather than registering an adapter: the harness
 * already ships `@deepseek-ai/dsh-llm-pi-ai`, and the OpenRouter route's model
 * list lives in the `llm-pi-ai` settings namespace. A second adapter would
 * fork a second source of truth for one route. `resolveRouteModels()` in that
 * adapter makes an entry's `name` the picker's display string, which is
 * exactly the hook this feature needs.
 *
 * The plugin has no UI of its own; it exposes one model tool, so it works
 * identically in the agent loop and in a headless deployment.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { fetchModels, OpenRouterError } from './or-client.mjs'
import { buildReport } from './probe.mjs'
import { sortModelsBySpeed, summarizeReport } from './core.mjs'
import { applyReport, rollback, planDefaultModelRepair, SETTINGS_NAMESPACE, PROVIDER_ROUTE } from './apply.mjs'
import { BRIDGE_PREFIX, CONFIG_FILE, DEFAULT_CONFIG, FIELDS, normalizeConfig, mergeConfig } from './config.mjs'
import { makeRoutes } from './bridge.mjs'

/** Stable Cordis plugin name; prefixes every log line this plugin emits. */
export const name = 'openrouter-free-models'

/**
 * No required services. In Cordis, `inject` is a gate: `apply` does not run
 * until every name listed there is present. Every service this plugin uses is
 * genuinely optional — a deployment without `tools` still loads the plugin and
 * simply logs that the tool was not registered — so listing them would turn a
 * degrade into a failure to activate.
 */
export const inject = []

/** Tool name exposed to the model. */
const TOOL_NAME = 'openrouter_free_models'

/** Cache and backup file names under the harness storages directory. */
const REPORT_FILE = 'openrouter-free-models.report.json'
const BACKUP_FILE = 'openrouter-free-models.backup.json'

/** Defaults matching docs/PRD.md section 4. */
const DEFAULTS = {
  policy: 'either',
  requireTools: true,
  textOnly: true,
  concurrency: 3,
  timeoutMs: 30000,
  maxTokens: 32,
  samples: 1,
  credentialRef: 'OPENROUTER_API_KEY',
}

/** Resolve the harness storage directory, tolerating a missing helper. */
function storageDir(ctx) {
  const helper = ctx.get('dshHomePath')
  if (typeof helper === 'function') {
    try {
      return join(helper('storages'), '')
    } catch {
      /* fall through to the conventional path */
    }
  }
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
  return join(home, 'storages')
}

/** Read a JSON file, returning \`undefined\` for absence or malformed content. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write a JSON file, creating its directory first. */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/** Absolute path of the plugin's own configuration document. */
function configPath(ctx) {
  return join(storageDir(ctx), CONFIG_FILE)
}

/**
 * Read the stored configuration, repaired through {@link normalizeConfig}.
 *
 * A missing or corrupt document resolves to the composition defaults rather
 * than failing: the plugin must stay usable before its Settings page has ever
 * been opened, and a hand-edited file must not be able to wedge the pipeline.
 */
async function loadConfig(ctx) {
  const raw = await readJson(configPath(ctx))
  return normalizeConfig(raw)
}

/** Persist one configuration document, returning the normalized result. */
async function saveConfig(ctx, patch) {
  const normalized = normalizeConfig(patch)
  await writeJson(configPath(ctx), normalized.config)
  return normalized
}

/** Resolve the OpenRouter credential through whichever seam exists. */
async function resolveCredential(ctx, ref) {
  const credentials = ctx.get('credentials')
  if (credentials && typeof credentials.resolve === 'function') {
    const resolved = await credentials.resolve(ref)
    if (resolved && typeof resolved.value === 'string' && resolved.value.trim() !== '') {
      return { value: resolved.value.trim(), source: resolved.source ?? 'credentials' }
    }
  }
  const inherited = process.env[ref]
  if (typeof inherited === 'string' && inherited.trim() !== '') {
    return { value: inherited.trim(), source: 'env' }
  }
  return { value: undefined, source: null }
}

/** Fetch the catalog with a short retry ladder. */
async function loadCatalog(options) {
  return fetchModels({ timeoutMs: 20000, retries: 2, ...options })
}

/**
 * Run the discover -> probe -> name pipeline.
 * @returns the report plus the credential facts behind it.
 */
async function buildForRun(ctx, options) {
  const credential = await resolveCredential(ctx, options.credentialRef ?? DEFAULTS.credentialRef)
  const catalog = await loadCatalog({ signal: options.signal })
  const report = await buildReport(catalog, {
    policy: options.policy ?? DEFAULTS.policy,
    requireTools: options.requireTools ?? DEFAULTS.requireTools,
    textOnly: options.textOnly ?? DEFAULTS.textOnly,
    excludeIds: options.excludeIds ?? [],
    concurrency: options.concurrency ?? DEFAULTS.concurrency,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    maxTokens: options.maxTokens ?? DEFAULTS.maxTokens,
    samples: options.samples ?? DEFAULTS.samples,
    nameTemplate: options.nameTemplate,
    apiKey: credential.value,
    apiKeySource: credential.source,
  })
  return { report, credential, catalog }
}

/** The file paths and logger every entry point shares. */
function pathsFor(ctx) {
  return {
    logger: ctx.logger,
    reportPath: () => join(storageDir(ctx), REPORT_FILE),
    backupPath: () => join(storageDir(ctx), BACKUP_FILE),
  }
}

/** Mount the plugin: one model tool, plus the Settings bridge. */
export function apply(ctx) {
  const logger = ctx.logger
  const paths = pathsFor(ctx)

  // The tool registration is deferred until `tools` exists, and adopted by an
  // effect so Cordis disposes it with this plugin's fiber. Registering inside
  // the effect (rather than beside one) is what makes unload leak-free: a bare
  // `tools.register(...)` return value is discarded, and the tool would
  // outlive the plugin that owns it.
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() => {
      logger.info('%s: mounted (tool=%s)', name, TOOL_NAME)
      const disposal = registerTool(toolsCtx, paths)
      return () => {
        disposal?.()
        logger.info('%s: unloaded', name)
      }
    }, name + ': tool')
  })

  // The browser half reaches the host through these routes. Absent a web
  // server the plugin still works from the agent loop and the CLI, so this is
  // a degrade rather than a failure.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposers = makeRoutes({
        config: () => bridgeConfig(ctx),
        save: (body) => bridgeSave(ctx, body),
        report: () => bridgeReport(ctx, paths),
        run: (body) => bridgeRun(ctx, body, paths),
      }).map((route) => webCtx.webServer.register(route))
      logger.info('%s: settings bridge mounted on %s', name, BRIDGE_PREFIX)
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, name + ': bridge')
  })
}

/** `config` bridge call: current values, defaults, and the field list. */
async function bridgeConfig(ctx) {
  const { config, rejected } = await loadConfig(ctx)
  return { ok: true, config, defaults: DEFAULT_CONFIG, fields: FIELDS, rejected }
}

/** `save` bridge call: persist a partial configuration document. */
async function bridgeSave(ctx, body) {
  const patch = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const { config, rejected } = await saveConfig(ctx, patch)
  ctx.logger.info('%s: configuration saved', name)
  return { ok: true, config, rejected }
}

/** `report` bridge call: the cached probe report, summarized for the table. */
async function bridgeReport(ctx, paths) {
  const report = await readJson(paths.reportPath())
  if (report === undefined) return { ok: true, report: null }
  // Order for display too, so a report cached before the ordering existed still
  // reads fastest-first in Settings.
  return { ok: true, report: projectReport({ ...report, models: sortModelsBySpeed(report.models) }) }
}

/** `run` bridge call: execute one action with stored config plus overrides. */
async function bridgeRun(ctx, body, paths) {
  const request = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const action = typeof request.action === 'string' ? request.action : 'list'
  const result = await runAction(ctx, { ...request, action }, paths)
  paths.logger.info('%s: bridge action %s -> ok=%s', name, action, result.ok)
  return result
}

/**
 * Build and register the plugin's single tool.
 *
 * Split out of {@link apply} so the registration sits plainly inside the
 * lifecycle effect that owns it.
 */
function registerTool(ctx, paths) {
  const { logger, reportPath, backupPath } = paths

  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.register !== 'function') {
    logger.warn('%s: ctx.tools is unavailable; the %s tool is not registered', name, TOOL_NAME)
    return undefined
  }

  const description = [
    'Discover OpenRouter free models, measure their speed and context size, and optionally write them into the harness OpenRouter model list with speed and context in the display name.',
    ' action="list": fetch the catalog and report which models are free (no probing, no writes).',
    ' action="probe": also call each free model once to measure TTFT and tok/s, returning the planned entries without writing.',
    ' action="apply": probe, then merge the entries into ' + SETTINGS_NAMESPACE + '.providers.' + PROVIDER_ROUTE + '.models after validating them; this is the only mutating action.',
    ' action="rollback": restore the model list captured before the last apply.',
    ' OpenRouter free models still require an API key; without one speed is skipped and reported as "not-tested".',
    ' A report is cached under the harness storages directory so repeated calls do not re-probe unnecessarily.',
  ].join('')

  // `tools.register()` takes already-normalized JSON Schema: `required` is an
  // array of names on an object node, never `true` on a property. The shorthand
  // form only exists in the `defineTool` spec DSL, which is a module-level
  // export of @deepseek-ai/dsh-tools rather than a method on ctx.tools — so this
  // plugin builds the normalized form directly and keeps its zero-dependency
  // guarantee. test/plugin.test.mjs asserts every schema here against the
  // harness's own validator.
  const parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'probe', 'apply', 'rollback'],
        description: 'list = free models only; probe = measure speed; apply = measure and write; rollback = restore the pre-apply list.',
      },
    policy: {
      type: 'string',
      enum: ['either', 'suffix', 'zero-price'],
      description: 'How "free" is decided. either = ":free" suffix or zero pricing (default); suffix = id ends with ":free"; zero-price = prompt and completion both priced 0.',
    },
    requireTools: {
      type: 'boolean',
      description: 'Keep only models that advertise tool calling (default true). Agent use needs tools.',
    },
    textOnly: {
      type: 'boolean',
      description: 'Keep only models whose output modality is text (default true).',
    },
    excludeIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Exact model ids to skip.',
    },
    concurrency: { type: 'integer', description: 'How many models may be probed at once (default 3).' },
    timeoutMs: { type: 'integer', description: 'Per-model probe timeout in milliseconds (default 30000).' },
    maxTokens: { type: 'integer', description: 'Token budget for each probe completion (default 32).' },
    samples: { type: 'integer', description: 'Probe repeats per model; the median is reported (default 1).' },
    nameTemplate: {
      type: 'string',
      description: 'Display-name template. Placeholders: {name} {speed} {tps} {ttft} {ctx} {id}.',
    },
    reuseCached: { type: 'boolean', description: 'For probe/apply, reuse a cached report younger than maxAgeMinutes (default true).' },
    maxAgeMinutes: { type: 'integer', description: 'Cache freshness window in minutes (default 360).' },
    dryRun: { type: 'boolean', description: 'With action="apply", compute and report the write without performing it.' },
      keepUnknown: { type: 'boolean', description: 'Keep existing model entries absent from this probe (default true).' },
    },
  }

  const outputSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'ok'],
    properties: {
      action: { type: 'string' },
      ok: { type: 'boolean' },
      catalogSize: { type: 'integer' },
      selectedCount: { type: 'integer' },
      apiKeySource: { type: 'string' },
      probedAt: { type: 'string' },
      cached: { type: 'boolean' },
      written: { type: 'boolean' },
      summary: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer' },
          tested: { type: 'integer' },
          failed: { type: 'integer' },
          skipped: { type: 'integer' },
          fastest: { type: 'string' },
          slowest: { type: 'string' },
        },
      },
      models: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            contextWindow: { type: 'integer' },
            tps: { type: 'number' },
            ttftMs: { type: 'number' },
            status: { type: 'string' },
            error: { type: 'string' },
            freeBy: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      added: { type: 'array', items: { type: 'string' } },
      updated: { type: 'array', items: { type: 'string' } },
      repaired: { type: 'array', items: { type: 'string' } },
      named: { type: 'array', items: { type: 'string' } },
      notes: { type: 'array', items: { type: 'string' } },
      problems: { type: 'array', items: { type: 'string' } },
      restored: { type: 'integer' },
      capturedAt: { type: 'string' },
      error: { type: 'string' },
    },
  }

  const definition = {
    name: TOOL_NAME,
    description,
    parameters,
    output: {
      schema: outputSchema,
      render: (_args, value) => [{ type: 'text', text: renderToolResult(value) }],
    },
    timeoutMs: 15 * 60000,
    execute(args) {
      return runAction(ctx, args, { reportPath, backupPath, logger })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.action === 'apply' ? 'Update OpenRouter free models'
        : args.action === 'probe' ? 'Probe OpenRouter free models'
          : args.action === 'rollback' ? 'Restore OpenRouter model list'
            : 'List OpenRouter free models',
      kind: 'other',
      rawInput: args.action,
    }),
  }

  return tools.register(definition)
}

/** Execute one action, converting every failure into a structured result. */
async function runAction(ctx, args, paths) {
  const action = args?.action ?? 'list'
  try {
    if (action === 'rollback') {
      const backup = await readJson(paths.backupPath())
      if (backup === undefined) {
        return { action, ok: false, error: 'no backup found; nothing to roll back' }
      }
      const result = await rollback(ctx.get('settings'), backup)
      return { action, ok: result.ok, ...result }
    }

    // Stored configuration is the baseline; explicit arguments win, so a
    // one-off probe never has to rewrite the user's saved preferences.
    const stored = await loadConfig(ctx)
    const resolved = mergeConfig(stored.config, args)
    const options = {
      policy: resolved.policy,
      requireTools: resolved.requireTools,
      textOnly: resolved.textOnly,
      excludeIds: resolved.excludeIds,
      concurrency: resolved.concurrency,
      timeoutMs: resolved.timeoutMs,
      maxTokens: resolved.maxTokens,
      samples: resolved.samples,
      nameTemplate: resolved.nameTemplate,
      credentialRef: resolved.credentialRef,
    }

    if (action === 'list') {
      const credential = await resolveCredential(ctx, resolved.credentialRef)
      const catalog = await loadCatalog({})
      const report = await buildReport(catalog, {
        ...options,
        apiKey: undefined,
        apiKeySource: credential.source,
      })
      return shape({ action, report, written: false, cached: false, credential })
    }

    const reuse = resolved.reuseCached === true
    const maxAgeMs = resolved.maxAgeMinutes * 60000
    let report
    let cached = false
    if (reuse) {
      const previous = await readJson(paths.reportPath())
      const age = previous?.probedAt ? Date.now() - Date.parse(previous.probedAt) : Number.NaN
      if (previous?.models && Number.isFinite(age) && age >= 0 && age <= maxAgeMs) {
        report = previous
        cached = true
      }
    }
    if (report === undefined) {
      const built = await buildForRun(ctx, options)
      report = built.report
      try {
        await writeJson(paths.reportPath(), report)
      } catch (error) {
        paths.logger.warn('%s: could not cache report: %s', name, String(error?.message ?? error))
      }
    }

    if (action === 'probe') return shape({ action, report, written: false, cached })

    const settings = ctx.get('settings')
    const outcome = await applyReport(settings, report, {
      keepUnknown: args?.keepUnknown !== false,
      dryRun: args?.dryRun === true,
      backup: (record) => writeJson(paths.backupPath(), record),
    })
    const defaultRepair = planDefaultModelRepair(settings?.get?.('agent-default-model'), outcome.models ?? [])
    return shape({ action, report, cached, outcome, defaultRepair })
  } catch (error) {
    const detail = error instanceof OpenRouterError ? error.message : String(error?.message ?? error)
    paths.logger.warn('%s: action %s failed: %s', name, action, detail)
    return { action, ok: false, error: detail }
  }
}

/**
 * Project a probe report into the compact shape shared by the tool result and
 * the Settings bridge, so the transcript and the settings table can never show
 * different numbers for the same report.
 */
function projectReport(report) {
  return {
    catalogSize: report.catalogSize,
    selectedCount: report.selectedCount,
    apiKeySource: report.apiKeySource,
    probedAt: report.probedAt,
    summary: summarizeReport(report),
    models: (report.models ?? []).map((model) => ({
      id: model.id,
      name: model.displayName,
      contextWindow: Number.isInteger(model.contextWindow) ? model.contextWindow : undefined,
      tps: Number.isFinite(model.speed?.tps) ? Math.round(model.speed.tps * 100) / 100 : undefined,
      ttftMs: Number.isFinite(model.speed?.ttftMs) ? Math.round(model.speed.ttftMs) : undefined,
      status: model.status,
      error: model.error,
      freeBy: Array.isArray(model.freeBy) ? model.freeBy : undefined,
    })),
    notes: (report.notes ?? []).length > 0 ? report.notes : undefined,
  }
}

/** Project a report into the tool's declared output shape. */
function shape(input) {
  const { action, report, written, cached, outcome, defaultRepair, credential } = input
  const result = {
    action,
    ok: outcome ? outcome.ok === true : true,
    ...projectReport(report),
    apiKeySource: report.apiKeySource ?? credential?.source ?? undefined,
    cached,
    written: outcome ? outcome.written === true : written,
  }
  if (outcome) {
    result.added = outcome.added
    result.updated = outcome.updated
    result.repaired = outcome.repaired
    if (outcome.named?.length) result.named = outcome.named
    if (outcome.problems) result.problems = outcome.problems
    if (outcome.reason) result.error = outcome.reason
  }
  if (defaultRepair) {
    result.notes = [
      ...(result.notes ?? []),
      'agent-default-model points at "' + defaultRepair.from + '"; the cleaned id is "' + defaultRepair.to + '"',
    ]
  }
  return result
}

/** One-screen human-readable summary for the transcript. */
function renderToolResult(value) {
  if (!value.ok && value.error) {
    return 'openrouter_free_models (' + value.action + ') failed: ' + value.error
  }
  if (value.action === 'rollback') {
    return 'Restored the OpenRouter model list from the backup captured ' + (value.capturedAt ?? 'earlier')
      + ' (' + (value.restored ?? 0) + ' model(s)).'
  }
  const lines = []
  const summary = value.summary ?? {}
  const cached = value.cached ? ' (cached report)' : ''
  lines.push('OpenRouter free models - ' + (value.catalogSize ?? 0) + ' models scanned, '
    + (value.selectedCount ?? 0) + ' free, ' + (summary.tested ?? 0) + ' probed' + cached + '.')
  if (summary.failed) lines.push(summary.failed + ' model(s) failed probing.')
  if (summary.skipped) lines.push(summary.skipped + ' model(s) were not tested.')
  if (summary.fastest) lines.push('Fastest: ' + summary.fastest)
  if (summary.slowest) lines.push('Slowest: ' + summary.slowest)
  const models = value.models ?? []
  for (const model of models.slice(0, 12)) {
    lines.push('  - ' + (model.name ?? model.id) + ' [' + model.status + ']')
  }
  if (models.length > 12) lines.push('  ... and ' + (models.length - 12) + ' more.')
  if (value.written) {
    lines.push('Wrote ' + (value.added?.length ?? 0) + ' new, updated ' + (value.updated?.length ?? 0)
      + ', repaired ' + (value.repaired?.length ?? 0) + ' in llm-pi-ai.providers.openrouter.models.')
  } else if (value.action === 'apply') {
    lines.push('Nothing was written (dry run or validation refusal).')
  }
  for (const note of value.notes ?? []) lines.push('Note: ' + note)
  for (const problem of value.problems ?? []) lines.push('Problem: ' + problem)
  return lines.join('\n')
}
