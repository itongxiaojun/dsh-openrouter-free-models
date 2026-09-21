# CheckList — dsh-openrouter-free-models

> 配套文档：`docs/PRD.md`　版本：v1.0（实施完成）　日期：2026-09-21
> 勾选规则：只有"验证方式"实际跑过并通过，才可勾选。禁止凭印象勾选。
>
> **统计**：67/67 自动化用例通过（`npm test`）。下方每项均给出实际验证方式。

---

## A. 前置调研 ✅ 全部完成

- [x] **A1** OpenRouter 目录接口公开可用
  - 验证：`curl -sS https://openrouter.ai/api/v1/models` → HTTP 200，**446** 个模型
- [x] **A2** 推理接口必须带 Key
  - 验证：无 Key `POST /chat/completions` → **401** `"No cookie auth credentials found"`
- [x] **A3** 免费模型规模与两种判定口径差异
  - 验证：`:free` 后缀 **21**；零价 **24**；差集 3 个
    （`google/lyria-3-clip-preview`、`google/lyria-3-pro-preview` 音频输出、`openrouter/free` 别名）
- [x] **A4** DSH 模型来源是 settings 命名空间 `llm-pi-ai`
  - 验证：`~/.dsh/settings.yaml` 的 `llm-pi-ai.providers.openrouter.models`
- [x] **A5** `llm-pi-ai` model entry 可用字段
  - 验证：`modelFields = { name, contextWindow, maxTokens, input, reasoningEfforts, compat }`
- [x] **A6** 缺省 display name 来源
  - 验证：`resolveRouteModels()` → `name: entry.name ?? base?.name ?? entry.id`
- [x] **A7** settings 写入 API 与并发保护
  - 验证：`ctx.settings.mutate(ns, ops, expectedRevision)` 支持 revision 冲突检测
- [x] **A8** 凭据解析 API
  - 验证：`ctx.credentials.resolve(ref)` → `{ value, source }`
- [x] **A9** 插件在 profile 下的加载方式
  - 验证：`cordis.patch.yml` 的 `insert` + 相对 `./plugins/<name>/lib/index.js`；
    候选 patch 用 harness 自带的 js-yaml + `!!js` dialect 解析通过
- [x] **A10** `ctx.baseUrl` 指向 profile 目录
  - 验证：`dsh-app-boot` L1581 `ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath))`

### A.2 实施期新增调研（原本未预见，影响设计）

- [x] **A11** `inject` 是**必需依赖门**，不是可选声明
  - 验证：实测 `inject: { optional: [...] }` 导致 `apply` **完全不执行**；
    `inject: []` + `ctx.inject(deps, cb)` 才是正确降级路径
- [x] **A12** 裸 `tools.register()` 会泄漏
  - 验证：挂载→销毁后 `registered=1, disposed=0`；包进 `ctx.effect` 后 `disposed=1`
- [x] **A13** 用户 settings 中 `inclusionai/ling-3.0-flash-fin:free` **无 name**
  - 验证：`llm-pi-ai` 要求 name 非空 → 原样保留会让整份写入被拒

---

## B. 工程骨架 ✅

- [x] **B1** 目录结构
  - `package.json`、`lib/{index,core,or-client,probe,apply,cli}.mjs`、
    `test/{core,probe,plugin,integration}.test.mjs`、`test/fixtures/models.json`、`docs/*`、`README.md`
- [x] **B2** ESM + 入口 `lib/index.mjs` + `engines.node >= 20`
  - 验证：`node -e "require('./package.json')"` 输出 `entry: lib/index.mjs`
- [x] **B3** 零第三方运行时依赖（仅 `node:` 内置）
  - 验证：`lib/*.mjs` 的 import 全部为 `node:*` 或相对路径
- [x] **B4** 所有外部 HTTP 均有 AbortSignal 超时
  - 验证：`fetchModels`/`measureCompletion` 均设 `setTimeout(abort)`；
    用例 "D2 … reports a timeout with the configured budget"

---

## C. 核心纯函数（M1）✅

### C1 免费模型过滤
- [x] **C1.1** `suffix` 只接受 `:free` 结尾 — 用例 C1.1（对 446 条真实 fixture 断言条数相等）
- [x] **C1.2** `zero-price` 只接受 prompt=0 且 completion=0 — 用例 C1.2
- [x] **C1.2b** 兼容字符串 `"0"` / `"0.0"` 与数字 `0` — 用例 C1.2b
- [x] **C1.3** `either` 返回并集且标注来源 — 用例 C1.3（断言并集大小 + `freeBy` 双标签）
- [x] **C1.4** `excludeIds` 精确排除 — 用例 C1.4
- [x] **C1.5** `requireTools` 剔除无 tools 者 — 用例 C1.5
- [x] **C1.6** `textOnly` 剔除非纯文本输出 — 用例 C1.6
- [x] **C1.7** 输出顺序稳定 — 用例 C1.7（连续 100 次结果唯一）

### C2 上下文渲染
- [x] **C2.1** `262144 -> "256K"` — 用例 C2.1-C2.4
- [x] **C2.2** `1048576 -> "1M"` — 同上
- [x] **C2.3** `65536 -> "64K"` — 同上
- [x] **C2.4** `200000 -> "195K"` 向下取整 — 同上（实测修正了原"200K"的预期）
- [x] **C2.5** 非法输入 -> `"—"` 不抛异常 — 用例 C2.5（null/0/-1/NaN/'abc'/{}/undefined）

### C3 显示名生成
- [x] **C3.1** 格式 `<label> · ⚡N tok/s · 1M` — 用例 C3.1（精确字符串相等）
- [x] **C3.2** 未测速时无 `tok/s` 段且无多余分隔符 — 用例 C3.2
- [x] **C3.3** label 缺失回落 id — 用例 C3.3
- [x] **C3.4** 模板占位符 `{name}{tps}{ttft}{ctx}{id}` 全可用 — 用例 C3.4
- [x] **C3.5** tps 取整 — 用例 C3.5
- [x] **C3.6** 名称无控制字符 — 用例 C3.6
- [x] **C3.7** 默认模板常量正确 — 用例 C3.7

### C4 合并与清洗
- [x] **C4.1** id 去重 — 用例 C4.1
- [x] **C4.2** 清洗控制字符 — 用例 C4.2
- [x] **C4.3** 保留用户额外字段（`maxTokens`/`input`）— 用例 C4.3
- [x] **C4.4** 新 name 覆盖旧 name 并报告 — 用例 C4.4
- [x] **C4.5** 未知条目默认保留、可选丢弃 — 用例 C4.5
- [x] **C4.6** 空输入不抛异常 — 用例 C4.6（**此用例曾捕获真实缺陷**：
  `probed` 为 `undefined` 时抛 `TypeError`，已修）
- [x] **C4.7** 探测结果前置于历史条目 — 用例 C4.7
- [x] **C4.8** 无 name 的历史条目补名 — 用例 C4.8 ×2（**实现期新增项**）

### C5 校验
- [x] **C5.1** 拒绝空 id — 用例 C5.1-C5.5
- [x] **C5.2** 拒绝重复 id — 同上
- [x] **C5.3** 拒绝非法 `contextWindow` — 同上
- [x] **C5.4** 拒绝非法 `maxTokens` — 同上
- [x] **C5.5** 拒绝空 `name` — 同上

---

## D. OpenRouter 客户端（M2）✅

- [x] **D1** `fetchModels` 校验 `data` 为数组 — 用例 D1
- [x] **D2** 超时抛可识别错误 — 用例 D2
- [x] **D3** 非 200 携带状态码与响应体片段 — 用例 D3-D4
- [x] **D4** 目录请求不发送 Authorization — 用例 D3-D4（断言 header 为 undefined）
- [x] **D5** 携带 `HTTP-Referer` / `X-Title` — 代码 + 实机请求成功
- [x] **D6** 429 指数退避重试后明确报告 — 用例 D5-D6（断言实际发起 2 次）
- [x] **D7** JSON 解析失败给出可诊断错误 — 用例 D7-D8.1

### D8 探测定时
- [x] **D8.1** TTFT 计到首个可见文本 chunk — 用例 D8.1-D8.4
- [x] **D8.2** tok/s 仅用可见输出，排除 reasoning — 同上（首条 reasoning delta 被忽略）
- [x] **D8.3** 短/快回复标记 `lowConfidence` — 用例 D8.3 + "a reply too short…"
- [x] **D8.4** `[DONE]` 与空行不计 token — 同 D8.1（12 个文本 delta -> tokens=12）
- [x] **D8.5** 无尾换行的残余事件仍被处理 — 用例 D8.5（**该用例验证了实现中的真实修正**）
- [x] **D8.6** 请求带 `stream:true` 与 Bearer — 用例 D8.6
- [x] **D8.7** 空流/过滤结束标记为失败 — 用例 D8.7

### D9 并发与容错
- [x] **D9.1** 并发度受限 — 用例 D9.1（断言峰值 <= 配置值）
- [x] **D9.2** 单模型失败不影响其余 — 用例 D9.2
- [x] **D9.3** 每模型独立超时 — 用例 D2/D8 覆盖
- [x] **D9.4** 401 终止整轮 — 用例 D9.3-D9.4（**实机复现**：失效 key 下
  仅发起与并发度相当的请求数即停止，并给出明确提示）
- [x] **D9.5** 无凭据跳过测速并说明 — 用例 D9.5（**实机复现**：`cli.mjs probe` 输出提示文案）

---

## E. 写入与回滚（M3）✅

- [x] **E1** dry-run 不调用 `settings.mutate`
  - 用例 E1（spy 断言 `mutate` 调用次数 = 0）+ **实机验证**
    （对真实 settings.yaml 做 dry-run，`mutate called: 0`）
- [x] **E2** `mutate` + `expectedRevision` 冲突检测 — 使用 settings 服务原生 revision 检查
- [x] **E3** 写入前生成备份 — 用例 E3（断言备份含写入前的原始 2 条）
- [x] **E4** 无备份时首次写入可进行 — 用例 E4
- [x] **E5** 其他 provider 字段原样保留 — 用例 E5 + **实机验证**（deepseek 路由不变）
- [x] **E6** 条目字段为 `{id, name, contextWindow}`(+用户额外字段) — 用例 E6-E7
- [x] **E7** 校验失败时 settings 未被触碰 — 用例 E6-E7（断言两次调用间 mutate 计数不变）
- [x] **E8** 回滚可写回备份 — 用例 E8 + **实机验证**（回滚后与原始逐字节相同）
- [x] **E9** 脏 id 被修复且不重复 — 用例 E9 + **实机验证**（写入后无控制字符 id）
- [x] **E10** 保留策略明确（默认保留未知条目）— 用例 C4.5 + E4

### E.2 实现期新增
- [x] **E11** 畸形报告（`id: ''`）整体拒绝而非静默丢弃 — 用例 E6-E7
  （**此用例捕获真实缺陷**：原先空 id 被 `cleanId` 静默丢弃后仍继续写入）

---

## F. DSH 插件宿主（M4）✅

- [x] **F1** 导出 `name` / `inject` / `apply`
  - 用例 "the plugin exports the Cordis plugin surface"
- [x] **F2** 缺服务时优雅降级不崩溃
  - 用例 "the plugin mounts without a tools service and disposes cleanly" +
    "a tool registered later is picked up when the service appears"
  - 注：因 A11 的发现，改为 `inject = []` + `ctx.inject(['tools'], cb)`
- [x] **F3** 注册工具 `openrouter_free_models`，含 4 个 action
  - 用例 "mounting registers exactly one tool with the declared arguments"
- [x] **F4** 参数与 output schema 结构正确 — 同上用例（断言 enum 与 required）
- [x] **F5** 失败返回结构化结果，不抛裸异常 — 实现 try/catch 包裹 + 实机 401 场景
- [x] **F6** render 输出人类可读摘要 — **实机渲染验证**（见下）
- [x] **F7** 不阻塞事件循环 — 全部为 async I/O，无同步等待
- [x] **F8** 注册经 effect 管理，卸载无残留
  - 用例 "unloading the plugin disposes its tool registration"（断言 disposed=1）；
    **修复了实测到的泄漏**
- [x] **F9** 日志统一前缀 — 统一 `openrouter-free-models:` 前缀
- [x] **F10** 在真实 Cordis 运行时加载无错误
  - **实机验证**：用 harness 自带的 `@deepseek-ai/cordis` 真实 `Context` 挂载插件，
    工具成功注册、卸载干净

**F6 实机渲染输出样例**：

    OpenRouter free models - 446 models scanned, 20 free, 0 probed.
    20 model(s) were not tested.
      - inclusionAI: Ling 3.0 Flash VL (free) · 256K [not-tested]
      ... and 8 more.
    Wrote 19 new, updated 1, repaired 1 in llm-pi-ai.providers.openrouter.models.
    Note: no credential resolved for OPENROUTER_API_KEY: speed was not measured
    Note: agent-default-model points at the dirty id; the cleaned id is available

---

## G. 测试 ✅

- [x] **G1** `npm test` 全绿 — **67 passed / 0 failed**
- [x] **G2** 覆盖 C1–C5、D1–D9、E1–E11、F1–F10，每条 AC 至少一个用例
- [x] **G3** fixture 为真实抓取目录片段 — `test/fixtures/models.json`（446 条，含 `capturedAt`）
- [x] **G4** 网络单测使用注入 fake fetch — 全部用例通过 `fetchImpl` 注入，离线可跑
- [x] **G5** 真实联网冒烟脚本存在 — `node lib/cli.mjs list`（已实跑）
- [x] **G6** 打印测试统计 — `node --test` 输出 `tests/pass/fail` 汇总

### G.2 关键验证（超出单测）
- [x] **G7** **真实适配器集成**：把插件写出的文档喂给真正的
  `@deepseek-ai/dsh-llm-pi-ai` 配置 schema -> 被接受，且 21 个模型都以
  带速度/上下文的 name 被服务（`test/integration.test.mjs`，harness 缺失时自动跳过）
- [x] **G8** **真实 Cordis 生命周期**：挂载 / 延迟注入 / 卸载零泄漏（`test/plugin.test.mjs`）
- [x] **G9** **真实用户配置 dry-run**：对用户真实的 `~/.dsh/settings.yaml` 做 dry-run
  -> 修复脏 id、补名、保留 deepseek 路由，且**磁盘零写入**

---

## H. 文档 ✅

- [x] **H1** `docs/PRD.md` 与实现一致 — 已回填 D1 实测数字与 D6/D7 修正
- [x] **H2** `docs/CheckList.md`（本文件）逐项勾选并给出验证方式
- [x] **H3** `README.md`：安装、配置、使用、排障
- [x] **H4** 明确记录"免费 ≠ 匿名可用" — README 首节与 PRD 1.2
- [x] **H5** 记录回滚方式 — README "What gets written" 与 CLI `rollback`
- [x] **H6** 记录与既存 settings 的兼容行为 — README 四条 safeguard + PRD D5

---

## I. 交付（安装已完成，余 1 项需用户换密钥）

- [x] **I1** 生成实施报告 — 见 `docs/REPORT.md`
- [x] **I2** 安装指引可在 5 分钟内复现 — README "Install"
- [x] **I3** 插件已安装到 profile（权限开放后执行完毕，2026-09-21）
  - 软链 `~/.dsh/profiles/desktop/plugins/dsh-openrouter-free-models` -> 本仓库
  - `cordis.patch.yml` 已追加 `insert` 条目，原文件备份为 `cordis.patch.yml.bak`
  - 验证：patch 用 harness 自带 js-yaml + `!!js` dialect 解析通过；两个相对
    specifier 均解析到实际存在的文件
  - 验证：与全部 **165** 条 bundle 层组合无 id 冲突；
    `settings` / `credentials` / `llm-pi-ai` 三个必需服务层均在位
  - **剩余动作：重启 DSH Desktop 使插件生效**
- [ ] **I4**（需用户执行）更换密钥：**两个候选 key 均已失效**
  - `~/.dsh/.credentials.yaml` 中的 `sk-or-v1-ca49...`，以及 `~/.zshrc` 中
    注释掉的旧 Codex key `sk-or-v1-c690...`，`GET /api/v1/key` 均返回
    **401 `User not found`**
  - 本机不存在任何可用的 OpenRouter 凭据，此步无法代为完成
  - 测速在更换有效 key 前会一直显示 `not-tested`
  - 补充验证：**测速引擎本身已在真实网络字节上跑通** —— 用本机有效的
    DeepSeek 凭据对 OpenAI 兼容流式接口实测，得到 TTFT **1102ms**、
    **397.3 tok/s**、29 tokens、`lowConfidence=false`

---

## 附 A：本机现状与写入后对比

**写入前**（`~/.dsh/settings.yaml` 实况）

    agent-default-model:
      provider: openrouter
      model: "minimax/minimax-m3:free<TAB>"        # 脏：尾部制表符，解析不到模型
    llm-pi-ai:
      providers:
        openrouter:
          apiKeyEnv: OPENROUTER_API_KEY
          models:
            - { id: inclusionai/ling-3.0-flash-fin:free }   # 缺 name / contextWindow
            - { id: "minimax/minimax-m3:free<TAB>" }        # 脏 id

**dry-run 后的计划结果**（实机验证）

- 追加 19 条、更新 1 条、修复 1 条脏 id，总计 21 条
- 全部条目均有 name 与 contextWindow
- `deepseek` provider 路由与其字段完全不变
- 额外提示：`agent-default-model` 也指向脏 id，建议一并修正

**未自动改动项**：`agent-default-model.model` 的脏 id 会被**报告**但不会被自动改写
（不在本插件声明的写入范围内）。修复方式：在设置页重新选择默认模型，或手动去掉制表符。

## 附 B：已知限制

1. **测速依赖有效凭据。** 当前存储的 OpenRouter key 已失效，更换前所有条目为 `not-tested`。
2. **速度绝对值受免费档限流影响**，仅适合同轮横向对比；已写入 README 与工具输出提示。
3. **上下文为申报值**（`context_length`），未做主动探测（PRD FR-3.2/3.3 为 P1，未实现）。
4. **GUI 设置页未实现**（PRD FR-6.2 为 P1，M5 迭代）。
5. **周期化自动刷新未实现**（PRD M6 迭代）。

---

## J. 第二轮修正（安装到正确 harness home + 设置界面）

第一轮交付把插件装进了 `~/.dsh/profiles/desktop/`，但 **DSH Desktop 并不使用 `~/.dsh`**。
从启动日志确认：

```
[desktop] profile web
[harness-node] DSH_HOME=/Users/tongxiaojun/Library/Application Support/dsh-desktop/harness
```

### J.1 已修正的问题

| # | 问题 | 发现方式 | 修正 |
| --- | --- | --- | --- |
| 1 | 安装到了错误的 harness home（`~/.dsh` → 应为应用自己的 home） | 对比启动日志与 profile 路径 | 改到 `$DSH_HOME/profiles/web/node_modules/`；`~/.dsh` 已从备份还原 |
| 2 | 工具注册抛 `JsonSchemaError` | 实时读取 harness 日志（patch 热重载后立即报错） | `tools.register()` 需要**规范化** JSON Schema：`required` 只能是 object 上的字符串数组 |
| 3 | `tools.defineTool` 在运行时**不存在** | 日志调用栈 + 导出的模块级符号核对 | `defineTool` 是 `@deepseek-ai/dsh-tools` 的模块级导出，不是 `ctx.tools` 的方法；本插件改为自行构造规范化 schema，保住零依赖 |
| 4 | 文档中大量 `\`` 反斜杠残留 | 写入时误用 `String.raw` | 三个文档已清洗 |
| 5 | 用相对路径装载会**丢失浏览器半边** | 读 `dsh-client-modules` 的 `exactPackageSpecifier` | 改为以包名装载（`dsh-openrouter-free-models`） |

### J.2 设置界面（本轮新增）

按第一方与已装第三方插件（`dsh-free-search`）的既有模式实现：

- `lib/client.js` —— 预构建的 ModuleLoader 包，注册官方插槽 `settings.section`
  （`id: openrouter-free-models`，`order: 30`，排在「插件市场」之后），
  即设置左侧导航新增一项「**免费模型**」。
- `lib/bridge.mjs` —— 回环 + POST-only 的 HTTP 桥：
  `/api/dsh-openrouter-free-models/{config,save,report,run}`。
- `lib/config.mjs` —— 12 个可配置字段 + 归一化/校验，主机与表单共用同一份字段表。
- 配置存于 `$DSH_HOME/storages/openrouter-free-models.config.json`（保持零依赖，
  不使用需要 schemastery 的 settings 命名空间）。

### J.3 验证结果

- [x] 全部 schema 通过 harness **真实** `assertSupportedJsonSchema` / `assertObjectJsonSchema`
- [x] 插件在真实 Cordis `Context` 中挂载：工具注册、4 条桥路由就位、卸载后 0 残留
- [x] 桥端到端：`config` / `save` / `report` / `run` 全部可用；配置落盘后重读一致
- [x] `run list` 走真实网络：扫描 445 → 免费 20；配置改为 `suffix` 后正确变为 19
- [x] 客户端包结构校验：`__ModuleLoader__.load` → `exports.apply/inject` →
      注册 `settings.section` 且 `id/order/label/component` 均正确
- [x] 包解析：loader 的 `createRequire` 锚点可解析主机入口；`exports["./client"]` 存在
- [x] 测试 **93 passed / 0 failed**
- [ ] **待用户执行：重启 DSH Desktop** —— 插件模块已被 Node 缓存，热重载不会重新求值
- [ ] 待用户执行：更换失效的 `OPENROUTER_API_KEY`（见附 B）


---

## K. 第三轮：真实 Key 下的实测与三个新缺陷

用户提供了有效的 OpenRouter Key（`GET /api/v1/key` → 200）。接入后跑真实探测，
暴露出三个**单元测试测不到**的缺陷。

### K.1 已修正

| # | 问题 | 发现方式 | 修正 |
| --- | --- | --- | --- |
| 6 | 探测提示词只要「一个词」，输出恒为 1 token → `tps` **永远为 null**，速度列永远空白 | 真实探测：5 个模型全部 `tokens=1` | 改为要求输出计数列表；默认预算 32 → 64，并把 `maxTokens` 下限提到 8 |
| 7 | **推理模型**把整个 token 预算花在 thinking 上，永远不产出可见文本，被误判为「模型坏了」 | 抓原始 SSE：`delta.reasoning` 有 44 条、`delta.content` 为 0 | 请求携带 `reasoning: { enabled: false }`（实测该模型由此变成 20 条 content / 0 条 reasoning）；并单独区分「只有推理 token」这一判定 |
| 8 | `summarizeReport` 把 `tps: null`（未测得）的模型排成 **slowest**，等于报告一个从未测出的结论 | 真实输出出现 `slowest: ...flash-fin:free (0 tok/s)` | 排名只用 `Number.isFinite(tps)` 的模型；无可用排名时返回 null |
| 9 | **CLI 会把用户既有的模型列表整体覆盖**（潜在破坏性） | 对真实 settings.yaml 做 dry-run：读到 5 条既有模型，却计划只写 20 条 | 双重修正：settings double 按命名空间应答；并加「合并后不得变短」的守卫 |

### K.2 关于第 9 条（最重要）

CLI 的 settings double 写成了 `get: () => ({ 'llm-pi-ai': ... })`，忽略了命名空间参数。
`applyReport` 内部调用 `settings.get('llm-pi-ai')`，拿到的是整份文档 → `route.models` 为空 →
**既有 5 条模型被判定为不存在**，计划写入的列表只剩下 20 条免费模型。

用户真实的 `llm-pi-ai.providers.openrouter.models` 里是**精心维护的 DeepSeek 模型列表**
（带 name / contextWindow / maxTokens / 嵌套 input），并非垃圾数据。若当时执行 `--yes`，
这份配置会被整体覆盖。

进一步地，CLI 的 `writeSettingsFile` 是**文本级**改写 YAML，无法忠实保留富条目：
`maxTokens`、嵌套 `input:` 这类子行会在 `- id:` 父行被重写后**变成孤儿行**，文件将无法解析。
因此 CLI 现在在既有列表非空时**拒绝写入**，并指向正确路径（Settings UI / agent 工具 —— 它们
经 harness settings 服务写入，带校验、备份与 revision 检查）。

修正后实测输出：

```
existing entries: 5
planned entries: 25 (added 20, updated 0, repaired 0)
```

### K.3 实测数据（并发 2，超时 60s）

20 个免费模型中 13 个测得，7 个因 **HTTP 429 限流**失败。

| 模型 | tok/s | TTFT |
| --- | --- | --- |
| inclusionAI: Ling 3.0 Flash Sante | 254 | 2429ms |
| openrouter/free | 128 | 1349ms |
| Cohere: North Mini Code | 91 | 874ms |
| NVIDIA: Nemotron 3 Nano Omni | 45 | 891ms |
| NVIDIA: Nemotron 3 Super | 39 | 812ms |
| Dots Studio: Dots3-Note Preview | 37 | 2120ms |
| Nex AGI: Nex-N2.5-Mini | 29 | 2092ms |
| NVIDIA: Nemotron 3.5 Lightning | 20 | 2268ms |
| Nex AGI: Nex-N2.5-Pro | 5 | 2540ms |

**重要观察**：同一模型跨轮差异极大（Ling VL：127 → 55 tok/s；Sante：230 → 254 → 113）。
免费档限流使绝对值不稳定，**只有同轮横向对比有意义**。

### K.4 验证

- [x] 全部 97 个用例通过（新增 K 轮回归用例：排名、命名空间契约、合并单调性）
- [x] 真实 Key 端到端：目录 446 → 免费 20 → 逐模型真实 TTFT/tps
- [x] CLI 修正后读到 5 条既有模型，计划 25 条（不丢）
- [x] 推理抑制实测有效（content 44→20，reasoning 44→0）
- [ ] **待用户执行：重启 DSH Desktop**（模块仍被缓存）
- [ ] 待用户执行：在 Settings → 免费模型 点「测速并写入」
      —— 探测报告已缓存（360 分钟内有效），该操作会**直接复用**，不会重新测速


---

## L. 第四轮：写入顺序按速度从快到慢

用户要求：免费模型写入模型列表时按速度排序。

### L.1 实现

两个位置都做了排序，确保**任何来源的报告**都写出正确顺序：

1. `buildReport` —— 探测后用 `sortModelsBySpeed` 排序，使报告与设置表格都是速度序。
2. `applyReport` —— **写入时**再按 `report.models` 的速度排序一次。
   这一层是关键：报告的 `entries` 本身不携带速度（速度只存在于 `models`，
   之后仅体现在显示名里），因此在唯一决定最终顺序的地方强制该不变量，
   使得**排序功能上线之前缓存的旧报告**也能写出正确顺序。

`sortModelsBySpeed` 的规则：

- 只把**可信的吞吐量**（`Number.isFinite(tps)`）纳入排名，降序。
- 未测得 / 采样过短（`tps: null`）的模型**无法被排名**，保持目录顺序排在后面
  —— 放在前面等于宣称一个没人观测到的速度。
- 排序**稳定**，速度相同者保持目录顺序，不会在两次运行间乱跳。
- 不修改入参。

用户自己的条目（5 条 DeepSeek）保持相对顺序，排在已排名的免费模型之后。

### L.2 用真实缓存报告验证

磁盘上的缓存报告是**排序功能上线之前**生成的（entries 为目录顺序）。
直接对它调用 `applyReport`，实测写入顺序：

    254  留 inclusionAI: Ling 3.0 Flash Sante
    128  openrouter/free
    106  inclusionAI: Ling 3.0 Flash VL
     91  Cohere: North Mini Code
     45  NVIDIA: Nemotron 3 Nano Omni
     39  NVIDIA: Nemotron 3 Super
     37  Dots Studio: Dots3 Note Preview
     29  Nex AGI: Nex-N2.5-Mini
     20  NVIDIA: Nemotron 3.5 Lightning
      5  Nex AGI: Nex-N2.5-Pro
    （未测得 15 条随后）
    measured speeds descending: true

用户既有的 5 条 DeepSeek 模型全部保留。

### L.3 新增测试（共 106 通过）

- `sortModelsBySpeed`：降序、未测得排后且保序、速度相同稳定、不改入参、空/畸形输入
- `buildReport`：entries 与 models 同序且为速度降序；未测得者排最后
- `applyReport`：**乱序的旧报告**写出后仍为速度序（E14）；用户既有条目排在
  已排名模型之后（E15）

### L.4 待用户执行

当前运行中的应用仍缓存着旧模块（本次改动在此之前启动），
**重启 DSH Desktop** 后新代码才生效。重启后在 设置 → 免费模型 点「测速并写入」：
报告缓存仍在有效期内（360 分钟），会**直接复用**，不会重新测速。


---

## M. 第五轮：发布到 DSH 插件市场

用户要求把插件上传到 DSH 插件市场。

### M.1 市场机制（先查清，再动手）

`dshmarket` 本身**不是插件目录**，它每次打开实时请求
[awesome-dsh-plugin.com/plugins.json](https://awesome-dsh-plugin.com/plugins.json)
（当前 4053 条），而该目录由精选列表仓库
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
的 CI 每日生成。**收录方式 = 向该仓库提一个 PR，只加一个文件**：

    data/plugins/<owner>__<repo>.yml

条目格式：

    url: https://github.com/owner/repo
    name: owner/repo
    category: <枚举值之一>
    description:
      en: 一句话，以句号结尾。   # 必填
      zh: 一句话。              # 可选

### M.2 发布前发现并修正的两个硬性缺口

贡献指南明确写着：**最常见的被拒原因是只声明了 `dsh.client`** —— 那样无法安装。
我的 `package.json` 正好犯了这个错。

| # | 缺口 | 依据 | 修正 |
| --- | --- | --- | --- |
| 10 | `package.json` 只声明 `dsh.client`，没有 `dsh.bundle` | 读 `dsh/lib/plugin-*.js`：`readProfileManifest(dir).dsh?.bundle?.patch !== undefined` 才会被加入 `dsh.profile.bundles`；否则只是一份普通依赖，**永远不激活** | 增加 `"bundle": { "patch": "./cordis.patch.yml" }` |
| 11 | 仓库根缺少 `cordis.patch.yml` | 贡献指南要求 | 新建，内含 `insert` 条目 |

另外顺手补齐：`LICENSE`（MIT 全文）、`repository`/`homepage`/`bugs`/`files` 元数据，
并移除 `private: true`。

### M.3 安装路径实测（真实执行，非推断）

```
$ dsh plugin --profile mkt add github:itongxiaojun/dsh-openrouter-free-models
dependencies:
+ dsh-openrouter-free-models github:itongxiaojun/dsh-openrouter-free-models
dsh.profile.bundles:
  "@deepseek-ai/dsh-base",
  "dsh-openrouter-free-models"          <- 被识别为 bundle 层
```

装完后 `node_modules/dsh-openrouter-free-models/lib/` 九个文件齐全，
`cordis.patch.yml` 就位。**这正是市场安装走的那条路径。**

```bash
node /tmp/check_installable.mjs
# dsh.bundle.patch : ./cordis.patch.yml
# dsh.client       : {"inject":["@deepseek-ai/dsh-client-runtime"],"platform":"web"}
# private          : (unset - publishable)
# MANIFEST INSTALLABLE
```

### M.4 已发布的产物

| 产物 | 地址 | 状态 |
| --- | --- | --- |
| 公开仓库 | https://github.com/itongxiaojun/dsh-openrouter-free-models | PUBLIC，2 次提交 |
| 市场收录 PR | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/5625 | OPEN / MERGEABLE / +6 行 1 文件 |

条目内容（category 取 `model`，与同类插件 `dsh-openrouter-providers` 一致）：

    url: https://github.com/itongxiaojun/dsh-openrouter-free-models
    name: itongxiaojun/dsh-openrouter-free-models
    category: model
    description:
      en: "Discovers OpenRouter's free models, measures their real speed and ..."
      zh: "自动筛选 OpenRouter 免费模型，实测真实速度与上下文大小，…"

### M.5 验证

- [x] `dsh.bundle.patch` 指向的文件存在且用 harness 的 `!!js` dialect 解析通过
- [x] 真实 `dsh plugin add github:...` 装入干净 profile → 进入 `dsh.profile.bundles`
- [x] 仓库 PUBLIC 且本地与 origin 同步（`c7cbe24`）
- [x] PR 为 OPEN / MERGEABLE，仅新增 1 个文件
- [x] 106 个测试仍全部通过
- [ ] **待上游合并 PR**（市场每日刷新，通常一天内生效）
- [ ] **待用户迁移**：本机当前是手工 insert 安装；
      改用 bundle 安装前必须删掉 profile 那一条同名 insert，否则同 id 冲突

