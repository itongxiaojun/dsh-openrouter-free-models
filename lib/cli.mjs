#!/usr/bin/env node
/**
 * Standalone CLI for dsh-openrouter-free-models.
 *
 * It exists so the pipeline can be exercised and debugged without a running
 * harness: the same modules the plugin uses, driven from a shell. It reads and
 * writes the same settings document the plugin does, and every mutating path
 * requires an explicit flag.
 *
 *   node lib/cli.mjs list
 *   node lib/cli.mjs probe --policy either --limit 8
 *   node lib/cli.mjs apply --yes
 *   node lib/cli.mjs rollback --yes
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { fetchModels } from './or-client.mjs'
import { buildReport } from './probe.mjs'
import { summarizeReport } from './core.mjs'
import { applyReport, rollback, SETTINGS_NAMESPACE, PROVIDER_ROUTE } from './apply.mjs'

const DSH_HOME = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
const SETTINGS_FILE = join(DSH_HOME, 'settings.yaml')
const REPORT_FILE = join(DSH_HOME, 'storages', 'openrouter-free-models.report.json')
const BACKUP_FILE = join(DSH_HOME, 'storages', 'openrouter-free-models.backup.json')

/** Parse \`--key value\` and \`--flag\` arguments into a plain object. */
function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) args[key] = true
    else { args[key] = next; index += 1 }
  }
  return args
}

/** Resolve the OpenRouter key the same way the plugin does. */
async function resolveApiKey() {
  if (process.env.OPENROUTER_API_KEY?.trim()) {
    return { value: process.env.OPENROUTER_API_KEY.trim(), source: 'env' }
  }
  try {
    const text = await readFile(join(DSH_HOME, '.credentials.yaml'), 'utf8')
    const match = text.match(/^\s*OPENROUTER_API_KEY:\s*(.+?)\s*$/m)
    if (match) return { value: match[1].replace(/^["']|["']$/g, ''), source: 'file' }
  } catch {
    /* no credential document */
  }
  return { value: undefined, source: null }
}

/**
 * Read just enough YAML to recover the OpenRouter model list.
 *
 * A full YAML parser is deliberately avoided: this CLI must run with zero
 * dependencies, and the settings document's shape is known and shallow. The
 * reader looks for the models array under \`llm-pi-ai.providers.openrouter\`.
 */
async function readSettingsModels() {
  let text
  try {
    text = await readFile(SETTINGS_FILE, 'utf8')
  } catch {
    return []
  }
  const models = []
  let inBlock = false
  let inModels = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (/^\S/.test(line)) {
      inBlock = /^llm-pi-ai:/.test(line)
      inModels = false
      continue
    }
    if (!inBlock) continue
    if (/models:\s*\[/.test(line)) {
      for (const item of line.slice(line.indexOf('[') + 1, line.lastIndexOf(']')).split('}')) {
        const id = item.match(/id:\s*("[^"]*"|'[^']*'|[^,}\s]+)/)
        if (id) models.push({ id: id[1].replace(/^["']|["']$/g, '').replace(/\\t/g, '\t') })
      }
      continue
    }
    if (/models:\s*$/.test(line)) { inModels = true; continue }
    if (!inModels) continue
    const id = line.match(/^\s+-\s+id:\s*("[^"]*"|'[^']*'|[^,}\s]+)/)
    if (id) models.push({ id: id[1].replace(/^["']|["']$/g, '').replace(/\\t/g, '\t') })
  }
  return models
}

/** Print a report as an aligned table. */
function printTable(report) {
  const rows = report.models.map((model) => [
    model.id,
    model.status,
    model.speed?.tps ? model.speed.tps.toFixed(1) : '-',
    model.speed?.ttftMs ? String(Math.round(model.speed.ttftMs)) : '-',
    model.displayName,
  ])
  const headers = ['id', 'status', 'tok/s', 'ttft', 'name']
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index]).length)))
  const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ')
  console.log(line(headers))
  console.log(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) console.log(line(row))
  const summary = summarizeReport(report)
  console.log('')
  console.log('total=' + summary.total + ' tested=' + summary.tested + ' failed=' + summary.failed + ' skipped=' + summary.skipped)
  if (summary.fastest) console.log('fastest: ' + summary.fastest)
  if (summary.slowest) console.log('slowest: ' + summary.slowest)
  for (const note of report.notes ?? []) console.log('note: ' + note)
}

async function main() {
  const [command = 'list', ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)

  if (command === 'help' || args.help) {
    console.log(await readFile(new URL('./cli.mjs', import.meta.url), 'utf8').then(() => '').catch(() => ''))
    console.log('commands: list | probe | apply | rollback')
    console.log('--policy either|suffix|zero-price   --limit N   --concurrency N')
    console.log('--timeoutMs N   --maxTokens N   --samples N   --yes (required to write)')
    return
  }

  if (command === 'rollback') {
    let backup
    try {
      backup = JSON.parse(await readFile(BACKUP_FILE, 'utf8'))
    } catch {
      console.error('no backup found at ' + BACKUP_FILE)
      process.exitCode = 1
      return
    }
    if (!args.yes) {
      console.log('would restore ' + backup.models.length + ' model(s) captured ' + backup.capturedAt)
      console.log('re-run with --yes to perform the restore')
      return
    }
    await writeSettingsFile(backup.models)
    console.log('restored ' + backup.models.length + ' model(s) from ' + backup.capturedAt)
    return
  }

  const credential = await resolveApiKey()
  console.log('credential: ' + (credential.value ? credential.source : 'not configured (speed will be skipped)'))

  const catalog = await fetchModels({})
  const report = await buildReport(catalog, {
    policy: args.policy ?? 'either',
    requireTools: args.requireTools !== 'false',
    textOnly: args.textOnly !== 'false',
    concurrency: Number(args.concurrency ?? 3),
    timeoutMs: Number(args.timeoutMs ?? 30000),
    maxTokens: Number(args.maxTokens ?? 32),
    samples: Number(args.samples ?? 1),
    nameTemplate: args.nameTemplate,
    apiKey: command === 'list' ? undefined : credential.value,
    apiKeySource: credential.source,
  })

  if (args.limit) report.models = report.models.slice(0, Number(args.limit))
  if (args.limit) report.entries = report.entries.slice(0, Number(args.limit))

  printTable(report)

  await mkdir(dirname(REPORT_FILE), { recursive: true })
  await writeFile(REPORT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8')
  console.log('\nreport written to ' + REPORT_FILE)

  if (command !== 'apply') return

  const existing = await readSettingsModels()
  // `applyReport` reads through the settings namespace, so the double must answer
  // per-namespace. Returning the whole document here made it read zero existing
  // models and plan a write that would have replaced the user's own model list.
  const merged = await applyReport({
    get: (ns) => (ns === SETTINGS_NAMESPACE
      ? { providers: { [PROVIDER_ROUTE]: { models: existing } } }
      : undefined),
    mutate: async () => {},
  }, report, { dryRun: true })

  console.log('\nexisting entries: ' + existing.length)
  console.log('planned entries: ' + merged.models.length + ' (added ' + merged.added.length
    + ', updated ' + merged.updated.length + ', repaired ' + merged.repaired.length + ')')

  // A merge can only ever grow the list. If it shrank, the reader or the merge
  // is wrong — refuse rather than overwrite configuration we failed to parse.
  if (merged.models.length < existing.length) {
    console.error('refusing to write: the merged list is shorter than the existing one ('
      + existing.length + ' -> ' + merged.models.length + '); this means the existing list was not read correctly')
    process.exitCode = 1
    return
  }

  if (!args.yes) {
    console.log('dry run only; re-run with --yes to write ' + SETTINGS_FILE)
    return
  }

  // The CLI edits settings.yaml textually, which cannot faithfully preserve
  // rich entries: an existing model with `maxTokens` or a nested `input:` list
  // would keep those child lines after its `- id:` parent was rewritten, and
  // the file would no longer parse. Writing is therefore limited to the case the
  // textual editor can actually handle — an empty or absent model list.
  if (existing.length > 0) {
    console.error('')
    console.error('refusing to write: this settings file already lists ' + existing.length + ' model(s),')
    console.error('and the CLI edits settings.yaml textually. Entries carrying extra fields')
    console.error('(maxTokens, input, ...) would be left with orphaned child lines.')
    console.error('')
    console.error('Use the plugin instead — it writes through the harness settings service,')
    console.error('which validates and preserves the document:')
    console.error('  - Settings → 免费模型 → 测速并写入   (after restarting DSH Desktop)')
    console.error('  - or ask the agent: "update my OpenRouter free models"')
    console.error('')
    console.error('The probe report above is still current and will be reused by that write.')
    process.exitCode = 2
    return
  }

  await mkdir(dirname(BACKUP_FILE), { recursive: true })
  await writeFile(BACKUP_FILE, JSON.stringify({ capturedAt: new Date().toISOString(), provider: PROVIDER_ROUTE, models: existing }, null, 2) + '\n', 'utf8')
  await writeSettingsFile(merged.models)
  console.log('wrote ' + merged.models.length + ' model(s) to ' + SETTINGS_FILE)
  console.log('backup written to ' + BACKUP_FILE)
}

/**
 * Rewrite the OpenRouter model block inside settings.yaml.
 *
 * The CLI edits the file directly because it runs without a harness; the
 * plugin itself always goes through the settings service. Only the
 * \`llm-pi-ai.providers.openrouter.models\` block is replaced.
 */
async function writeSettingsFile(models) {
  let text = ''
  try {
    text = await readFile(SETTINGS_FILE, 'utf8')
  } catch {
    text = ''
  }
  const block = [
    '    openrouter:',
    '      models:',
    ...models.map((model) => {
      const parts = ['id: ' + JSON.stringify(model.id)]
      if (model.name) parts.push('name: ' + JSON.stringify(model.name))
      if (model.contextWindow) parts.push('contextWindow: ' + model.contextWindow)
      return '        - { ' + parts.join(', ') + ' }'
    }),
  ].join('\n')

  const replaced = replaceModelBlock(text, block)
  await writeFile(SETTINGS_FILE, replaced, 'utf8')
}

/** Replace the openrouter models block, or append one when absent. */
function replaceModelBlock(text, block) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^\s{2,}openrouter:\s*$/.test(line))
  if (start === -1) {
    const anchor = lines.findIndex((line) => /^llm-pi-ai:/.test(line))
    if (anchor === -1) return text.replace(/\s*$/, '\n') + ['llm-pi-ai:', '  providers:', block, ''].join('\n')
    return [...lines.slice(0, anchor + 1), '  providers:', block, ...lines.slice(anchor + 1)].join('\n')
  }
  // Consume the provider's existing children (deeper indent) plus a models block.
  let end = start + 1
  while (end < lines.length && (lines[end].trim() === '' || /^\s{4,}/.test(lines[end]))) {
    if (lines[end].trim() === '') break
    end += 1
  }
  const indent = '    '
  const rebuilt = [indent + 'openrouter:']
  const preserved = lines.slice(start + 1, end).filter((line) => !/^\s+(- )?models:/.test(line) && !/^\s+- \{/.test(line) && !/^\s+id:/.test(line) && !/^\s+name:/.test(line) && !/^\s+contextWindow:/.test(line))
  for (const line of preserved) rebuilt.push(line.replace(/^\s{4}/, '      '))
  rebuilt.push(...block.split('\n').map((line) => line.replace(/^\s{4}/, '      ')))
  return [...lines.slice(0, start), ...rebuilt, ...lines.slice(end)].join('\n')
}

main().catch((error) => {
  console.error('failed: ' + (error?.message ?? error))
  process.exitCode = 1
})
