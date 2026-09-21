/**
 * Plugin configuration: defaults, normalization, and validation.
 *
 * The plugin keeps its own configuration document rather than registering a
 * harness settings namespace. That is deliberate: a namespace schema must be a
 * `schemastery` schema, and importing that package would make this plugin
 * depend on resolving `@deepseek-ai/schemastery` from wherever it happens to be
 * installed. Staying dependency-free is worth more here than sharing a store
 * with unrelated settings, and the plugin's own Settings section edits this
 * document directly.
 */

/** Where the configuration document lives, under the harness storages root. */
export const CONFIG_FILE = 'openrouter-free-models.config.json'

/** The bridge prefix the browser half talks to. */
export const BRIDGE_PREFIX = '/api/dsh-openrouter-free-models'

/**
 * Field definitions shared by the host validator and the browser form, so the
 * two can never drift: the UI renders from this list and the host validates
 * against the same list.
 */
export const FIELDS = [
  {
    key: 'policy',
    type: 'enum',
    values: ['either', 'suffix', 'zero-price'],
    label: '免费判定策略',
    hint: 'either = “:free” 后缀或零计价（默认）；suffix = 仅 id 以 “:free” 结尾；zero-price = prompt 与 completion 均为 0。',
  },
  {
    key: 'requireTools',
    type: 'boolean',
    label: '仅保留支持工具调用的模型',
    hint: 'Agent 使用需要 function calling；关闭后会纳入不支持工具的模型。',
  },
  {
    key: 'textOnly',
    type: 'boolean',
    label: '仅保留纯文本输出模型',
    hint: '关闭后会纳入音频/图像输出等模型。',
  },
  {
    key: 'excludeIds',
    type: 'stringList',
    label: '排除的模型 id',
    hint: '每行一个完整 id，例如 openrouter/free。',
  },
  {
    key: 'concurrency',
    type: 'integer',
    min: 1,
    max: 10,
    label: '并发探测数',
    hint: '同时对多少个模型发起测速请求。',
  },
  {
    key: 'timeoutMs',
    type: 'integer',
    min: 1000,
    max: 600000,
    label: '单模型超时 (ms)',
    hint: '每个模型探测请求的最长等待时间。',
  },
  {
    key: 'maxTokens',
    type: 'integer',
    min: 8,
    max: 4096,
    label: '探测输出上限 (tokens)',
    hint: '测速时允许模型生成的最大 token 数。太小会导致无法测得生成速度。',
  },
  {
    key: 'samples',
    type: 'integer',
    min: 1,
    max: 5,
    label: '每模型采样次数',
    hint: '重复探测并取中位数，降低抖动；会按倍数增加耗时。',
  },
  {
    key: 'nameTemplate',
    type: 'string',
    label: '显示名模板',
    hint: '占位符：{name} {speed} {tps} {ttft} {ctx} {id}。',
  },
  {
    key: 'reuseCached',
    type: 'boolean',
    label: '复用缓存报告',
    hint: '开启时，尚未过期的上次探测结果会被直接使用而不重新测速。',
  },
  {
    key: 'maxAgeMinutes',
    type: 'integer',
    min: 0,
    max: 10080,
    label: '缓存有效期 (分钟)',
    hint: '超过该时长的报告会被重新探测。',
  },
  {
    key: 'credentialRef',
    type: 'string',
    label: '凭据引用名',
    hint: '解析 API Key 的凭据引用，默认 OPENROUTER_API_KEY。',
  },
]

/** Composition defaults; also the shape `normalizeConfig` always returns. */
export const DEFAULT_CONFIG = Object.freeze({
  policy: 'either',
  requireTools: true,
  textOnly: true,
  excludeIds: [],
  concurrency: 3,
  timeoutMs: 30000,
  maxTokens: 64,
  samples: 1,
  nameTemplate: '{name} · {speed}{ctx}',
  reuseCached: true,
  maxAgeMinutes: 360,
  credentialRef: 'OPENROUTER_API_KEY',
})

/** Field definition for one key, or `undefined` for an unknown key. */
export function fieldOf(key) {
  return FIELDS.find((field) => field.key === key)
}

/** Coerce one value to its declared type, returning `undefined` when invalid. */
function coerce(field, value) {
  if (field === undefined) return undefined
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined
    case 'integer': {
      const parsed = typeof value === 'string' ? Number(value) : value
      if (!Number.isInteger(parsed)) return undefined
      if (field.min !== undefined && parsed < field.min) return undefined
      if (field.max !== undefined && parsed > field.max) return undefined
      return parsed
    }
    case 'enum':
      return field.values.includes(value) ? value : undefined
    case 'string':
      return typeof value === 'string' ? value : undefined
    case 'stringList': {
      if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean)
      if (typeof value === 'string') {
        return value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean)
      }
      return undefined
    }
    default:
      return undefined
  }
}

/**
 * Normalize an untrusted configuration document.
 *
 * Unknown keys are dropped and invalid values fall back to their default, so a
 * hand-edited or partially-written file can never put the probe pipeline into
 * an unserviceable state. Every accepted key is validated by type and range.
 *
 * @param raw - the parsed document, or `undefined`.
 * @returns `{ config, rejected }` where `rejected` names keys that were repaired.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const config = {}
  const rejected = []
  for (const field of FIELDS) {
    if (!Object.hasOwn(source, field.key)) {
      config[field.key] = structuredClone(DEFAULT_CONFIG[field.key])
      continue
    }
    const value = coerce(field, source[field.key])
    if (value === undefined) {
      rejected.push(`${field.key}: falling back to the default`)
      config[field.key] = structuredClone(DEFAULT_CONFIG[field.key])
    } else {
      config[field.key] = value
    }
  }
  return { config, rejected }
}

/**
 * Layer explicit tool arguments over a stored configuration document.
 *
 * Tool arguments win because an agent asking for a one-off probe should not
 * have to rewrite the user's saved preferences to do it.
 */
export function mergeConfig(config, args = {}) {
  const merged = { ...DEFAULT_CONFIG, ...config }
  for (const field of FIELDS) {
    const value = coerce(field, args[field.key])
    if (value !== undefined) merged[field.key] = value
  }
  return merged
}
