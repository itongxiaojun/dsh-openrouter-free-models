/**
 * dsh-openrouter-free-models — browser half.
 *
 * Registers a Settings section (设置 → 免费模型) that edits the plugin's own
 * configuration document and runs its pipeline, talking to the host half over
 * the loopback bridge in lib/bridge.mjs.
 *
 * This file is a prebuilt bundle in the harness's ModuleLoader format, the same
 * shape the installed dsh-free-search package ships. It is plain ES2020 with no
 * JSX and no template literals, so it needs no build step: client-modules reads
 * exports["./client"] from package.json and serves these bytes verbatim.
 *
 * The section is registered rather than a settings-namespace card because the
 * Plugins page only dispatches cards for namespaces registered through the
 * settings service, and a namespace schema must be a schemastery schema — which
 * would cost this plugin its zero-dependency guarantee.
 */

window.__ModuleLoader__.load({
  id: 'dsh-openrouter-free-models',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var react = require('react')

    var BRIDGE_PREFIX = '/api/dsh-openrouter-free-models'
    var CSS_ID = 'dsh-openrouter-free-models-css'

    var CSS = [
      '.dshofm{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}',
      '.dshofm-title{margin:0;font-size:18px;font-weight:600}',
      '.dshofm-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:1.6}',
      '.dshofm-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px}',
      '.dshofm-row{display:flex;align-items:center;gap:14px}',
      '.dshofm-label{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dshofm-name{font-size:13px;font-weight:500}',
      '.dshofm-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}',
      '.dshofm-control{flex:none;width:220px;display:flex;justify-content:flex-end}',
      '.dshofm-input,.dshofm-select{box-sizing:border-box;width:220px;height:32px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;padding:0 10px}',
      '.dshofm-textarea{box-sizing:border-box;width:220px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;padding:6px 10px;resize:vertical;min-height:56px}',
      '.dshofm-input:focus,.dshofm-select:focus,.dshofm-textarea:focus{border-color:var(--dsw-alias-brand-primary);outline:none}',
      '.dshofm-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.dshofm-btn{box-sizing:border-box;height:32px;font:inherit;font-size:13px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);background:0 0;border-radius:16px;padding:0 14px}',
      '.dshofm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshofm-btn:disabled{opacity:.45;cursor:default}',
      '.dshofm-btnPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}',
      '.dshofm-status{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;margin:0}',
      '.dshofm-statusError{color:var(--dsw-alias-state-error-primary)}',
      '.dshofm-table{width:100%;border-collapse:collapse;font-size:12px}',
      '.dshofm-table th,.dshofm-table td{text-align:left;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);vertical-align:top}',
      '.dshofm-table th{color:var(--dsw-alias-label-tertiary);font-weight:500}',
      '.dshofm-mono{font-family:var(--ds-font-family-code);word-break:break-all}',
      '.dshofm-scroll{max-height:340px;overflow:auto;border:.5px solid var(--dsw-alias-border-l4);border-radius:10px}',
      '.dshofm-tag{border:.5px solid var(--dsw-alias-border-l3);border-radius:4px;padding:0 5px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
    ].join('')

    // Inject the stylesheet once per document.
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') === null) {
      var tag = document.createElement('style')
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** One bridge call; every route is POST with a JSON body. */
    function call(name, payload) {
      return fetch(BRIDGE_PREFIX + '/' + name, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload === undefined ? {} : payload),
      }).then((response) => response.json())
    }

    /** Human sentence for one finished action. */
    function describeResult(data) {
      if (!data.ok) return data.error || '执行失败'
      var summary = data.summary || {}
      var lines = []
      if (data.action === 'rollback') return '已恢复模型列表（' + (data.restored || 0) + ' 条）。'
      lines.push('扫描 ' + (data.catalogSize || 0) + ' 个模型，免费 ' + (data.selectedCount || 0) + ' 个，已测速 ' + (summary.tested || 0) + ' 个。')
      if (summary.failed) lines.push('探测失败 ' + summary.failed + ' 个。')
      if (summary.fastest) lines.push('最快：' + summary.fastest)
      if (data.written) lines.push('已写入 ' + (data.added ? data.added.length : 0) + ' 条新增、' + (data.updated ? data.updated.length : 0) + ' 条更新。')
      if (data.action === 'apply' && !data.written) lines.push('未写入（试运行或校验未通过）。')
      if (data.notes && data.notes.length) lines.push(data.notes.join('\n'))
      if (data.problems && data.problems.length) lines.push(data.problems.join('\n'))
      return lines.join('\n')
    }

    /** One labelled form control. */
    function Field(props) {
      var field = props.field
      var value = props.value
      var onChange = props.onChange

      function control() {
        if (field.type === 'boolean') {
          return react.createElement('input', {
            type: 'checkbox',
            checked: value === true,
            onChange: function (event) { onChange(field.key, event.target.checked) },
          })
        }
        if (field.type === 'enum') {
          return react.createElement('select', {
            className: 'dshofm-select',
            value: value,
            onChange: function (event) { onChange(field.key, event.target.value) },
          }, field.values.map((option) => react.createElement('option', { key: option, value: option }, option)))
        }
        if (field.type === 'stringList') {
          return react.createElement('textarea', {
            className: 'dshofm-textarea',
            value: Array.isArray(value) ? value.join('\n') : '',
            onChange: function (event) { onChange(field.key, event.target.value.split('\n').map((s) => s.trim()).filter(Boolean)) },
          })
        }
        return react.createElement('input', {
          className: 'dshofm-input',
          type: field.type === 'integer' ? 'number' : 'text',
          value: value === undefined || value === null ? '' : String(value),
          onChange: function (event) {
            var raw = event.target.value
            onChange(field.key, field.type === 'integer' ? (raw === '' ? '' : Number(raw)) : raw)
          },
        })
      }

      return react.createElement('div', { className: 'dshofm-row' },
        react.createElement('div', { className: 'dshofm-label' },
          react.createElement('span', { className: 'dshofm-name' }, field.label),
          react.createElement('span', { className: 'dshofm-hint' }, field.hint)),
        react.createElement('div', { className: 'dshofm-control' }, control()))
    }

    /** The Settings section. */
    function Section() {
      var configState = react.useState(null)
      var config = configState[0]
      var setConfig = configState[1]

      var fieldsState = react.useState([])
      var fields = fieldsState[0]
      var setFields = fieldsState[1]

      var reportState = react.useState(null)
      var report = reportState[0]
      var setReport = reportState[1]

      var busyState = react.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      var dirtyState = react.useState(false)
      var dirty = dirtyState[0]
      var setDirty = dirtyState[1]

      var statusState = react.useState('')
      var status = statusState[0]
      var setStatus = statusState[1]

      var failedState = react.useState(false)
      var failed = failedState[0]
      var setFailed = failedState[1]

      function ingest(data) {
        if (data.report) {
          setReport(data.report)
        } else if (data.models) {
          setReport({
            catalogSize: data.catalogSize,
            selectedCount: data.selectedCount,
            summary: data.summary,
            models: data.models,
            notes: data.notes,
            probedAt: data.probedAt,
          })
        }
      }

      function refresh() {
        setBusy(true)
        setFailed(false)
        setStatus('')
        call('config').then(function (data) {
          if (data.ok) {
            setConfig(data.config)
            setFields(data.fields || [])
          } else {
            setFailed(true)
            setStatus(data.error || '无法读取配置')
          }
          return call('report')
        }).then(function (data) {
          if (data && data.ok) ingest(data)
        }).catch(function (error) {
          setFailed(true)
          setStatus(String((error && error.message) || error))
        }).then(function () {
          setBusy(false)
        })
      }

      react.useEffect(refresh, [])

      function update(key, value) {
        setDirty(true)
        setConfig(function (previous) {
          var next = Object.assign({}, previous)
          next[key] = value
          return next
        })
      }

      function save() {
        setBusy(true)
        setFailed(false)
        setStatus('')
        call('save', config).then(function (data) {
          if (data.ok) {
            setConfig(data.config)
            setDirty(false)
            setStatus('已保存' + (data.rejected && data.rejected.length ? '（已修正：' + data.rejected.join('；') + '）' : ''))
          } else {
            setFailed(true)
            setStatus(data.error || '保存失败')
          }
        }).catch(function (error) {
          setFailed(true)
          setStatus(String((error && error.message) || error))
        }).then(function () {
          setBusy(false)
        })
      }

      function run(action) {
        setBusy(true)
        setFailed(false)
        setStatus('正在执行 ' + action + ' …')
        call('run', { action: action }).then(function (data) {
          ingest(data)
          setFailed(data.ok !== true)
          setStatus(describeResult(data))
        }).catch(function (error) {
          setFailed(true)
          setStatus(String((error && error.message) || error))
        }).then(function () {
          setBusy(false)
        })
      }

      if (config === null) {
        return react.createElement('div', { className: 'dshofm' },
          react.createElement('h2', { className: 'dshofm-title' }, '免费模型'),
          react.createElement('p', { className: failed ? 'dshofm-status dshofm-statusError' : 'dshofm-status' },
            status || '正在加载配置…'))
      }

      var models = (report && report.models) || []

      return react.createElement('div', { className: 'dshofm' },
        react.createElement('h2', { className: 'dshofm-title' }, 'OpenRouter 免费模型'),
        react.createElement('p', { className: 'dshofm-intro' },
          '筛选 OpenRouter 上的免费模型，实测速度与上下文，并把结果写入 '
          + 'llm-pi-ai.providers.openrouter.models，模型名中带上速度与上下文。'
          + '注意：免费模型仍需 API Key，未配置时会跳过测速。'),

        react.createElement('div', { className: 'dshofm-card' },
          fields.map(function (field) {
            return react.createElement(Field, {
              key: field.key,
              field: field,
              value: config[field.key],
              onChange: update,
            })
          }),
          react.createElement('div', { className: 'dshofm-actions' },
            react.createElement('button', {
              className: 'dshofm-btn dshofm-btnPrimary',
              type: 'button',
              disabled: busy || !dirty,
              onClick: save,
            }, busy ? '处理中…' : '保存配置'),
            react.createElement('button', {
              className: 'dshofm-btn',
              type: 'button',
              disabled: busy,
              onClick: refresh,
            }, '重新加载'))),

        react.createElement('div', { className: 'dshofm-card' },
          react.createElement('div', { className: 'dshofm-actions' },
            react.createElement('button', { className: 'dshofm-btn', type: 'button', disabled: busy, onClick: function () { run('list') } }, '列出免费模型'),
            react.createElement('button', { className: 'dshofm-btn', type: 'button', disabled: busy, onClick: function () { run('probe') } }, '测速（不写入）'),
            react.createElement('button', { className: 'dshofm-btn dshofm-btnPrimary', type: 'button', disabled: busy, onClick: function () { run('apply') } }, '测速并写入'),
            react.createElement('button', { className: 'dshofm-btn', type: 'button', disabled: busy, onClick: function () { run('rollback') } }, '回滚上次写入')),
          status ? react.createElement('p', { className: failed ? 'dshofm-status dshofm-statusError' : 'dshofm-status' }, status) : null),

        models.length > 0 ? react.createElement('div', { className: 'dshofm-card' },
          react.createElement('p', { className: 'dshofm-intro' },
            '最近一次结果' + (report.probedAt ? '（' + report.probedAt + '）' : '') + '，共 ' + models.length + ' 个模型。'),
          react.createElement('div', { className: 'dshofm-scroll' },
            react.createElement('table', { className: 'dshofm-table' },
              react.createElement('thead', null,
                react.createElement('tr', null,
                  react.createElement('th', null, '模型'),
                  react.createElement('th', null, '速度'),
                  react.createElement('th', null, '上下文'),
                  react.createElement('th', null, '状态'))),
              react.createElement('tbody', null,
                models.map(function (model) {
                  return react.createElement('tr', { key: model.id },
                    react.createElement('td', { className: 'dshofm-mono' }, model.name || model.id),
                    react.createElement('td', null, model.tps ? model.tps + ' tok/s' : '—'),
                    react.createElement('td', null, model.contextWindow ? String(model.contextWindow) : '—'),
                    react.createElement('td', null,
                      react.createElement('span', { className: 'dshofm-tag' }, model.status || '')))
                }))))
        ) : null)
    }

    var inject = ['slots']

    function apply(ctx) {
      // 挂官方插槽 settings.section（设置左侧导航），order 排在插件市场之后。
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'openrouter-free-models',
          order: 30,
          label: function () { return '免费模型' },
        }, Section)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
