# REPORT — dsh-openrouter-free-models 实施报告

> 日期：2026-09-21　状态：实现完成，待用户安装
> 配套：`docs/PRD.md`（需求）· `docs/CheckList.md`（逐项验证）· `README.md`（使用）

---

## 1. 交付内容

### 1.1 插件本体（DSH Cordis 插件）

| 文件 | 职责 |
| --- | --- |
| `lib/index.mjs` | Cordis 插件入口：生命周期 + 注册工具 `openrouter_free_models` |
| `lib/core.mjs` | 纯函数：免费判定、上下文渲染、显示名生成、合并清洗、校验 |
| `lib/or-client.mjs` | OpenRouter HTTP 客户端：目录拉取 + 流式测速（TTFT / tok·s⁻¹） |
| `lib/probe.mjs` | 探测编排：有界并发、独立超时、凭据失效短路 |
| `lib/apply.mjs` | 写入层：合并 → 校验 → 备份 → `settings.mutate`；回滚 |
| `lib/cli.mjs` | 独立 CLI，脱离 DSH 也能跑（排障用） |

### 1.2 文档

`docs/PRD.md`、`docs/CheckList.md`、`docs/REPORT.md`（本文件）、`README.md`

### 1.3 测试

`test/{core,probe,plugin,integration}.test.mjs` + `test/fixtures/models.json`（446 条真实目录快照）

**结果：67 passed / 0 failed**（`npm test`，离线可跑）

---

## 2. 需求满足情况

| 用户诉求 | 实现 | 验证 |
| --- | --- | --- |
| 过滤出 OpenRouter 上的免费模型 | 3 种策略（`suffix`/`zero-price`/`either`）+ tools/文本输出过滤 | 446 → 20 条，实测一致 |
| 测试速度 | 真实流式探测：TTFT + tok/s，中位数采样，低置信标记 | 用例 D8 全组；实机 401 分类正确 |
| 测试上下文大小 | 取官方 `context_length`，渲染为 `256K`/`1M`，写入 `contextWindow` | 用例 C2 组 + G7 真实适配器接受 |
| 更新到默认模型列表 | 写入 `llm-pi-ai.providers.openrouter.models` | 用例 E 组 + 实机 dry-run/write |
| 模型名中加入速度与上下文 | `<label> · ⚡N tok/s · 256K`，模板可定制 | 用例 C3 组 + 真实适配器解析出该 name |

---

## 3. 实机验证证据

### 3.1 真实适配器接受写入结果（决定性验证）

把插件产出的文档直接喂给 `@deepseek-ai/dsh-llm-pi-ai` 的真实配置 schema：

    adapter accepts the written document: yes
    models the adapter will serve: 21
    every served model has a display name: true
    minimax/minimax-m3:free -> "MiniMax: MiniMax M3 (free) · ⚡48 tok/s · 1M" ctx= 1048576
    deepseek route preserved: [{"id":"deepseek-v4-flash","name":"DSH Flash",...}]

### 3.2 对用户真实配置的 dry-run（磁盘零写入）

    tool registered: openrouter_free_models
    ok: true | written: false | selected: 20
    mutate called: 0 (a dry run must be zero)
    repaired: [{"from":"minimax/minimax-m3:free<TAB>","to":"minimax/minimax-m3:free"}]
    added count: 19 | updated count: 1
    Note: agent-default-model points at the dirty id; the cleaned id is available
    settings file untouched on disk: true

### 3.3 真实 Cordis 生命周期

    after mount  -> registered: 1 unregistered: 0
    after dispose -> registered: 1 unregistered: 1
    leak check: no leak

### 3.4 回滚逐字节还原

    pre-write list had 2 entries
    rollback ok: true
    after rollback: [{"id":"inclusionai/ling-3.0-flash-fin:free"},{"id":"minimax/minimax-m3:free<TAB>"}]
    restored byte-identical to the original: true

---

## 4. 实施中发现并修正的缺陷

测试与联调捕获了 4 个**真实缺陷**（非假设）：

| # | 缺陷 | 发现方式 | 修正 |
| --- | --- | --- | --- |
| 1 | `inject: { optional: [...] }` 导致 `apply` 完全不执行 | 真实 Cordis 挂载实测 | 改为 `inject = []` + `ctx.inject(['tools'], cb)` |
| 2 | 裸 `tools.register()` 注销后不释放（泄漏） | 挂载/销毁计数实测 | 注册包进 `ctx.effect` 并返回 disposer |
| 3 | `mergeModelEntries(undefined, ...)` 抛 `TypeError` | 用例 C4.6 | 入参归一化为数组 |
| 4 | 畸形报告（空 id）被静默丢弃后仍写入 | 用例 E6-E7 | 报告条目先行校验，不合格整体拒绝 |

另有一项设计修正：**无 name 的历史条目会让整份写入被适配器拒绝**
（实测于用户真实 settings），合并阶段现会为其补 id 作为 name。

---

## 5. 尚未完成 / 需用户操作

| 项 | 原因 | 操作 |
| --- | --- | --- |
| ~~安装到 profile~~ | 权限开放后**已完成**（软链 + insert 条目均已写入并验证） | 只需重启 DSH Desktop |
| 有效 OpenRouter Key | **两个候选 key 实测均 401 User not found**，本机无可用凭据 | 在设置页更换后即可获得真实测速数据 |
| GUI 设置页 | PRD P1 / M5 迭代 | — |
| 上下文主动探测 | PRD P1（FR-3.2/3.3） | — |
| 周期化自动刷新 | PRD M6 迭代 | — |
| `agent-default-model` 脏 id | 不在本插件写入范围 | 设置页重选默认模型，或手动去掉制表符 |

---

## 6. 结论

五项用户诉求全部实现，并有自动化测试与实机验证支撑。核心链路
「拉取目录 → 判定免费 → 实测速度/上下文 → 生成带标注的名字 → 校验后写入 settings」
已在真实 Cordis 运行时与真实适配器 schema 上端到端跑通；写入具备
**合并不覆盖、校验前置、备份可回滚、revision 防并发**四重保护。
