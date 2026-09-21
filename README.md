# dsh-openrouter-free-models

A [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) plugin that keeps
your OpenRouter model list current and honest:

1. **Filters** OpenRouter's catalog down to the free models.
2. **Measures** each one — real time-to-first-token and tokens/second, plus declared context size.
3. **Publishes** the survivors into the harness OpenRouter model list, with speed and context
   written into the display name:

```
MiniMax: MiniMax M3 (free) · ⚡48 tok/s · 1M
inclusionAI: Ling 3.0 Flash Fin (free) · ⚡61 tok/s · 256K
```

Design documents: [`docs/PRD.md`](docs/PRD.md) · [`docs/CheckList.md`](docs/CheckList.md)

---

## One important fact up front

**"Free" on OpenRouter means zero-priced, not anonymous.** The catalog endpoint is public, but
every inference call — including `:free` models — requires an API key. Without one this plugin
still lists and sizes the models; it simply cannot measure their speed, and it says so instead
of inventing a number.

## Requirements

- DSH with the `llm-pi-ai` adapter mounted (every standard profile has it).
- An `OPENROUTER_API_KEY` in the harness credential store or the environment.
- Node 20+ (for the standalone CLI).

## Install

### First: find the harness home the app actually boots

DSH Desktop does **not** use `~/.dsh`; it sets its own harness home. Installing
into the wrong one produces a plugin that never loads. Read it from the log:

```bash
grep 'DSH_HOME=' ~/Library/Logs/DSH\ Desktop/harness.log | tail -1
# [stdout] [harness-node] DSH_HOME=/Users/<you>/Library/Application Support/dsh-desktop/harness
```

The profile name is on the `[desktop] profile <name>` line just above. The
examples below use `$DSH_HOME/profiles/web`.

### Install it as a package, not as a loose file

```bash
DSH_HOME="$HOME/Library/Application Support/dsh-desktop/harness"
ln -s "$(pwd)" "$DSH_HOME/profiles/web/node_modules/dsh-openrouter-free-models"
```

The entry has to be a **bare package name**. The harness discovers a plugin's
browser half by resolving `exports["./client"]` from the package named in the
loader entry, and client-modules only recognises entries that are exact package
specifiers. Pointing the entry at a relative `.mjs` path loads the host half
and silently drops the Settings section.

### Register the entry

Append to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: openrouter-free-models
      name: dsh-openrouter-free-models
```

### Restart, then confirm

Quit and reopen DSH Desktop. The harness log must show both lines:

```
openrouter-free-models: mounted (tool=openrouter_free_models)
openrouter-free-models: settings bridge mounted on /api/dsh-openrouter-free-models
```

```bash
grep openrouter-free-models ~/Library/Logs/DSH\ Desktop/harness.log | tail
```

Nothing after a restart means the entry did not resolve — check the path above
and that the symlink target exists.

## Use

### From the agent

One tool is registered:

| action | what it does |
| --- | --- |
| `list` | Fetch the catalog and report which models are free. No probing, no writes. |
| `probe` | Also call each free model once to measure TTFT and tok/s. Still no writes. |
| `apply` | Probe (or reuse a fresh cached report), validate, and **write** to the model list. |
| `rollback` | Restore the model list captured before the last apply. |

> "Update my OpenRouter free models, then show me which is fastest."

Useful arguments: `policy` (`either` | `suffix` | `zero-price`), `requireTools`, `textOnly`,
`excludeIds`, `concurrency`, `timeoutMs`, `maxTokens`, `samples`, `nameTemplate`,
`reuseCached`, `maxAgeMinutes`, `dryRun`, `keepUnknown`.

### From the shell

The CLI runs the same pipeline without a harness:

```bash
node lib/cli.mjs list                          # what is free, right now
node lib/cli.mjs probe --limit 8               # measure the first eight
node lib/cli.mjs apply                         # dry run: show the planned write
node lib/cli.mjs rollback --yes                # undo it (CLI writes a plain list)
```

## Settings UI

Once installed as a package, the plugin adds a section to the Settings dialog
(设置 → **免费模型**), listed after the built-in sections.

It gives you:

- **Every tunable in one form** — free-model policy, tool/text filters, excluded
  ids, probe concurrency, timeouts, sample count, display-name template, cache
  window, and the credential reference. Invalid values are repaired to their
  defaults on save, and the response names what was repaired.
- **Manual runs** — 列出免费模型, 测速（不写入）, 测速并写入, and 回滚上次写入,
  the same four actions the agent tool exposes.
- **The last result as a table** — model name (with speed and context baked in),
  tokens/second, context size, and probe status.

The browser half is `lib/client.js`, a prebuilt bundle in the harness's
ModuleLoader format. It holds no state: it reads and writes through the loopback
bridge below, so the section and the agent tool always agree.

### The config document

The UI edits the plugin's **own** configuration file, not a settings namespace:

```
$DSH_HOME/storages/openrouter-free-models.config.json
```

It is deliberately separate. A harness settings namespace requires a
schemastery schema, which would make this plugin depend on resolving
`@deepseek-ai/schemastery` from wherever it happens to be installed; keeping
its own document preserves the zero-dependency guarantee. The trade-off is that
these values do not appear in `settings.yaml` — see `lib/config.mjs` for the
complete field list and defaults.

### The bridge

`lib/client.js` talks to `/api/dsh-openrouter-free-models/*` on the harness
web server. Every route is **POST-only and loopback-only**: the bridge mutates
harness state and spends API credits, so it must not be reachable off-machine.
Malformed bodies are a 400 and a handler throw is a JSON 500, so the browser
form always receives a parseable answer.

## How the model list is decided

- `suffix` — id ends with `:free`.
- `zero-price` — both prompt and completion priced `0`.
- `either` (default) — the union. As of this writing that is 24 models from a 446-model
  catalog: 21 with the suffix, plus `openrouter/free` and two zero-priced audio models. The
  audio models are then dropped by the default `textOnly` filter.

By default only models advertising the `tools` parameter are kept, because agent use needs
function calling.

## What gets written

Into `llm-pi-ai.providers.openrouter.models`, one entry per model:

```yaml
- { id: "minimax/minimax-m3:free", name: "MiniMax: MiniMax M3 (free) · ⚡48 tok/s · 1M", contextWindow: 1048576 }
```

### Order: fastest first

The free models are written **sorted by measured speed, fastest to slowest**, so
the picker opens on the models most likely to feel responsive.

Only a trustworthy throughput figure earns a rank. Models that were never
measured, or whose single sample was too short to time (`tps: null`), cannot be
placed on that scale and follow the measured ones in catalog order — putting
them first would advertise a speed nobody observed. The sort is stable, so equal
speeds keep their catalog order instead of shuffling between runs.

Your own entries keep their relative order behind the ranked free models. The
ordering is applied at write time from the report's measurements, so a report
cached before this behaviour existed still produces a correctly ordered list.

Writing is subject to four safeguards:

1. **Merge, never clobber.** Ranked free models lead; your own entries and any extra
   fields you set by hand (`maxTokens`, `input`, `compat`) survive.
2. **Validate before touching anything.** A report the adapter would reject is refused whole, and
   settings are left exactly as they were.
3. **Back up first.** The previous list lands in
   `~/.dsh/storages/openrouter-free-models.backup.json` before each write.
4. **Revision-checked.** The write carries the settings revision it read, so a concurrent edit
   from the settings page is a conflict, not a silent loss.

## Name template

Default: `{name} · {speed}{ctx}`. Placeholders: `{name}` `{speed}` `{tps}` `{ttft}` `{ctx}` `{id}`.
A model that was not measured simply omits its speed segment.

> Writing the model list is done through the harness settings service, by the
> agent tool or the Settings section. The standalone CLI deliberately refuses to
> write when the settings file already lists models, because it edits YAML
> textually and would orphan the child fields (`maxTokens`, `input`) on entries
> it cannot faithfully reproduce.

## Probe behaviour

Two things the probe does deliberately, both of which the first live run against
a real key proved necessary:

- **Thinking is disabled per request** (`reasoning: { enabled: false }`). Reasoning
  models otherwise spend the whole token budget thinking and never emit visible
  text, which is indistinguishable from a broken model. Models whose provider
  ignores the directive are reported distinctly — `only reasoning tokens
  arrived` — rather than as an empty response.
- **The probe asks for a counted list**, not a single word. A one-word answer
  measures first-token latency and nothing else: every model would report
  `tps: null`, so the speed column would always be empty. The default budget is
  64 tokens, and 探测输出上限 is clamped to a minimum of 8.

A model whose reply is too short to time is marked low-confidence and excluded
from the fastest/slowest ranking — reporting it as "slowest" would state a
finding that was never measured.

### Free-tier rate limiting

Free models are rate limited, and it shows. Probing all 20 at concurrency 4
drew HTTP 429 on 7 of them; at concurrency 2 it drew 4. Speed readings also vary
a lot between runs for the same model (one model measured 127 tok/s, then 55).

Treat a failed probe as "try again later", not as a verdict, and lower
并发探测数 if you are seeing many 429s.

## Speed numbers: read them with care

Free tiers are rate limited, so absolute figures move around. The value here is **relative**: it
tells you that one free model answers three times faster than another on this machine, right now.
A reply too short or too fast to time is marked low-confidence rather than reported as a speed.

## Files

| Path | Purpose |
| --- | --- |
| `~/.dsh/storages/openrouter-free-models.report.json` | Last probe result (reused by `probe`/`apply`) |
| `~/.dsh/storages/openrouter-free-models.backup.json` | Pre-write model list, for `rollback` |
| `<DSH_HOME>/storages/openrouter-free-models.config.json` | Settings UI configuration document |

## Development

```bash
npm test                # 93 tests, no network required
node lib/cli.mjs list   # the one command that does hit the network
```

The suite includes an integration test that feeds the plugin's output through the **real**
`@deepseek-ai/dsh-llm-pi-ai` configuration schema, so the written document is checked against
the adapter that will actually consume it. That test skips cleanly where the harness is absent.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Speed column reads `not-tested` | No `OPENROUTER_API_KEY`. Add it on the Models settings page. |
| `OPENROUTER_API_KEY was rejected with HTTP 401/403` | The stored key is invalid. Replace it, then re-run. |
| Most models fail with HTTP 429 | Free-tier rate limiting. Lower `concurrency`, raise `timeoutMs`, retry later. |
| `llm-pi-ai.providers.openrouter.models` looks stale | The report cache is reused for 6h by default. Pass `reuseCached: false` or delete the report file. |
| Plugin does not appear | You are probably in the wrong harness home — see "First: find the harness home the app actually boots". |
| Tool loads but there is no Settings section | The entry names a relative path. client-modules only discovers a browser half for an exact package specifier. |
| Settings section renders but every call fails | The bridge did not mount; check the log for `settings bridge mounted`. |
| Section shows "无法读取配置" | The bridge refused the call. Routes are loopback-only and POST-only by design. |

## License

MIT
