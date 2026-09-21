/**
 * OpenRouter HTTP client.
 *
 * Two endpoints matter here, and they behave differently:
 *   - `GET /api/v1/models`  is public: no key, and it is the authority on the
 *     free/non-free split and on declared context length.
 *   - `POST /api/v1/chat/completions` needs a key even for `:free` models —
 *     "free" means zero-priced, not anonymous.
 *
 * Everything takes an injectable `fetch` so unit tests never touch the network.
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/** Build the attribution headers OpenRouter asks integrations to send. */
function attributionHeaders() {
  return {
    'HTTP-Referer': 'https://github.com/deepseek-ai/deepseek-harness',
    'X-Title': 'DSH OpenRouter Free Models',
  }
}

/** An error carrying the HTTP status and a body excerpt for diagnosis. */
export class OpenRouterError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'OpenRouterError'
    this.status = options.status
    this.retryable = options.retryable === true
    this.body = options.body
  }
}

/** Sleep helper honoring an abort signal. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OpenRouterError('aborted', { status: 0 }))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new OpenRouterError('aborted', { status: 0 }))
    }, { once: true })
  })
}

/**
 * Fetch the public model catalog.
 *
 * @param options - fetch override, abort signal, timeout, retry count, base URL.
 * @returns the raw `data` array from the catalog response.
 */
export async function fetchModels(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    signal,
    timeoutMs = 20_000,
    retries = 2,
    baseUrl = OPENROUTER_BASE_URL,
  } = options
  let attempt = 0
  for (;;) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    try {
      const response = await fetchImpl(`${baseUrl}/models`, {
        method: 'GET',
        headers: { accept: 'application/json', ...attributionHeaders() },
        signal: combined,
      })
      if (!response.ok) {
        const body = await safeText(response)
        const retryable = response.status === 429 || response.status >= 500
        if (retryable && attempt < retries) {
          attempt += 1
          await delay(500 * 2 ** (attempt - 1), signal)
          continue
        }
        throw new OpenRouterError(
          `GET /models failed with HTTP ${response.status}: ${truncate(body)}`,
          { status: response.status, retryable, body },
        )
      }
      const payload = await response.json().catch((error) => {
        throw new OpenRouterError(`GET /models returned unparseable JSON: ${error.message}`, { status: response.status })
      })
      if (!payload || !Array.isArray(payload.data)) {
        throw new OpenRouterError('GET /models response has no "data" array', { status: response.status })
      }
      return payload.data
    } catch (error) {
      if (error instanceof OpenRouterError) {
        if (error.retryable && attempt < retries && error.status !== 0) {
          attempt += 1
          await delay(500 * 2 ** (attempt - 1), signal)
          continue
        }
        throw error
      }
      const aborted = controller.signal.aborted
      if (aborted && attempt < retries && !signal?.aborted) {
        attempt += 1
        await delay(500 * 2 ** (attempt - 1), signal)
        continue
      }
      throw new OpenRouterError(
        aborted ? `GET /models timed out after ${timeoutMs}ms` : `GET /models failed: ${error.message}`,
        { status: 0, retryable: aborted },
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Read a response body as text, tolerating a stream that already errored. */
async function safeText(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/** Keep an error body excerpt short enough for a log line. */
function truncate(text, limit = 300) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/**
 * Run one streaming chat completion and measure it.
 *
 * Timing contract (see docs/CheckList.md D8):
 *   - TTFT is measured from just before the request is issued to the first
 *     delta that carries visible text — reasoning-only deltas do not count.
 *   - Throughput uses only visible output tokens, divided by the span between
 *     the first and last visible delta, so it describes generation speed
 *     rather than round-trip latency.
 *
 * @returns a measurement record; never throws for a provider-side failure,
 *          which is reported through `status`.
 */
export async function measureCompletion(details, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
    maxTokens = 64,
    // A probe must elicit enough visible output to time. Asking for one word
    // measures first-token latency and nothing else — with the old default every
    // model reported `tps: null`, so the speed column was permanently empty. The
    // counted list is cheap for the provider and long enough to time.
    prompt = 'Count from 1 to 24, one number per line. Output only the numbers.',
    baseUrl = OPENROUTER_BASE_URL,
    signal,
  } = options

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const started = Date.now()
  let firstTokenAt = null
  let lastTokenAt = null
  let visibleTokens = 0
  let sawDone = false
  let sawReasoning = false

  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${details.apiKey}`,
        ...attributionHeaders(),
      },
      body: JSON.stringify({
        model: details.id,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        stream: true,
        // Reasoning models otherwise spend the entire token budget thinking and
        // never emit visible text, which is indistinguishable from a failed
        // probe. OpenRouter honours this on providers that gate thinking behind
        // a request parameter.
        reasoning: { enabled: false },
      }),
      signal: combined,
    })

    if (!response.ok) {
      const body = await safeText(response)
      return {
        status: 'error',
        error: `HTTP ${response.status}: ${truncate(body, 200)}`,
        status_code: response.status,
        unauthorized: response.status === 401 || response.status === 403,
        rateLimited: response.status === 429,
      }
    }

    if (!response.body || typeof response.body.getReader !== 'function') {
      const text = await safeText(response)
      return parseSseText(text, started, maxTokens)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        const event = consumeSseLine(line)
        if (event === 'done') sawDone = true
        if (event === 'reasoning') sawReasoning = true
        if (event === 'text') {
          const now = Date.now()
          if (firstTokenAt === null) firstTokenAt = now
          lastTokenAt = now
          visibleTokens += 1
        }
        newline = buffer.indexOf('\n')
      }
    }
    // A stream may end without a trailing newline; the residual is a real event.
    const tail = buffer.trim()
    if (tail !== '') {
      const event = consumeSseLine(tail)
      if (event === 'done') sawDone = true
      if (event === 'reasoning') sawReasoning = true
      if (event === 'text') {
        const now = Date.now()
        if (firstTokenAt === null) firstTokenAt = now
        lastTokenAt = now
        visibleTokens += 1
      }
    }
    return finalize(started, firstTokenAt, lastTokenAt, visibleTokens, sawDone, sawReasoning)
  } catch (error) {
    const aborted = controller.signal.aborted
    return {
      status: 'error',
      error: aborted ? `timed out after ${timeoutMs}ms` : String(error?.message ?? error),
      timedOut: aborted,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Count the visible text carried by one SSE line. */
function consumeSseLine(line) {
  if (line === '' || line.startsWith(':')) return 'ignore'
  if (!line.startsWith('data:')) return 'ignore'
  const payload = line.slice(5).trim()
  if (payload === '[DONE]') return 'done'
  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    return 'ignore'
  }
  const delta = parsed?.choices?.[0]?.delta
  if (!delta) return 'ignore'
  const text = typeof delta.content === 'string' ? delta.content : ''
  // Reasoning deltas are model-internal and would inflate throughput, but they
  // are worth noticing: a stream that carried only reasoning spent its budget
  // thinking, which is a different verdict from an empty response.
  if (text.length > 0) return 'text'
  const reasoning = typeof delta.reasoning === 'string' ? delta.reasoning : ''
  return reasoning.length > 0 ? 'reasoning' : 'ignore'
}

/** Parse a buffered (non-streaming-capable) response body the same way. */
function parseSseText(text, started, maxTokens) {
  let firstTokenAt = null
  let lastTokenAt = null
  let visibleTokens = 0
  let sawDone = false
  let sawReasoning = false
  for (const line of String(text).split('\n')) {
    const event = consumeSseLine(line.replace(/\r$/, ''))
    if (event === 'done') sawDone = true
    if (event === 'reasoning') sawReasoning = true
    if (event === 'text') {
      const now = Date.now()
      if (firstTokenAt === null) firstTokenAt = now
      lastTokenAt = now
      visibleTokens += 1
    }
  }
  if (visibleTokens === 0 && String(text).trim() !== '') {
    // Some gateways ignore `stream` and answer with a single JSON object.
    try {
      const parsed = JSON.parse(text)
      const content = parsed?.choices?.[0]?.message?.content
      if (typeof content === 'string' && content.length > 0) {
        const now = Date.now()
        return {
          status: 'ok',
          ttftMs: now - started,
          tps: null,
          tokens: 0,
          lowConfidence: true,
          note: 'gateway ignored stream=true; no token timing available',
        }
      }
    } catch {
      /* fall through to the empty-response verdict */
    }
  }
  return finalize(started, firstTokenAt, lastTokenAt, visibleTokens, sawDone, sawReasoning, maxTokens)
}

/** Turn raw counters into a measurement verdict. */
function finalize(started, firstTokenAt, lastTokenAt, visibleTokens, sawDone, sawReasoning = false, _maxTokens = 64) {
  if (visibleTokens === 0) {
    if (sawReasoning) {
      return {
        status: 'error',
        error: 'only reasoning tokens arrived: the model spent its whole budget thinking (raise 探测输出上限 or pick a non-reasoning model)',
      }
    }
    return { status: 'error', error: sawDone ? 'model produced no visible text' : 'stream ended without content' }
  }
  const ttftMs = firstTokenAt === null ? null : firstTokenAt - started
  const span = firstTokenAt !== null && lastTokenAt !== null ? lastTokenAt - firstTokenAt : 0
  const tps = span >= 50 && visibleTokens >= 5 ? (visibleTokens / span) * 1000 : null
  return {
    status: 'ok',
    ttftMs,
    tps,
    tokens: visibleTokens,
    lowConfidence: tps === null,
  }
}
