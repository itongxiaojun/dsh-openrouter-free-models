# PRD — dsh-openrouter-free-models（DSH 插件）

> 版本：v1.0　状态：待评审　作者：DSH Agent　日期：2026-09-21
> 目标平台：DSH Desktop 0.9.1 / DSH 0.1.5-rc.2（profile: `desktop`）

---

## 1. 背景与问题

### 1.1 现状
DSH 通过 `@deepseek-ai/dsh-llm-pi-ai` 适配器接入 OpenRouter。该适配器的 provider 路由由 **settings 命名空间 `llm-pi-ai`** 驱动：

```yaml
# ~/.dsh/settings.yaml
llm-pi-ai:
  providers:
    openrouter:
      apiKeyEnv: OPENROUTER_API_KEY
      models:
        - { id: inclusionai/ling-3.0-flash-fin:free }
        - { id: "minimax/minimax-m3:free\t" }      # ← 用户手写，尾部带垃圾字符
```

当前用户现状（实测）：

| 现象 | 证据 | 影响 |
| --- | --- | --- |
| 模型列表靠手工维护 | settings.yaml 中 2 条手写记录 | 新增/下架模型无法自动跟进 |
| 模型名不可读 | picker 里只显示裸 id，如 `inclusionai/ling-3.0-flash-fin:free` | 无法判断速度/上下文，只能盲选 |
| 存在脏数据 | `"minimax/minimax-m3:free\t"` 尾部有制表符 | 该条目实际不可用/不可选 |
| 缺上下文信息 | 条目未声明 `contextWindow`，退化到 `defaultContextWindow=262144` | 与真实上下文（如 1M）不符，影响压缩与预算判断 |
| 免费模型无法筛选 | OpenRouter 有 446 个模型，其中仅 24 个免费 | 人工分辨成本高，且规则不透明 |

### 1.2 OpenRouter 侧事实（2026-09-21 实测 `GET /api/v1/models`）
- 模型总数 **446**，其中 id 以 `:free` 结尾的 **21** 个。
- 按 `pricing.prompt == "0" && pricing.completion == "0"` 判定的 **24** 个，与 `:free` 后缀集合有 21 个交集：
  - 3 个 ``"零价但无 :free 后缀"``：`google/lyria-3-clip-preview`、`google/lyria-3-pro-preview`（音频输出）、`openrouter/free`（路由别名）。
- 免费模型中 **20/24** 支持 `tools` 参数（DSH 的 Agent 工具调用必需），**4** 个不支持。
- `GET /api/v1/models` 是**公开接口**，无需 API Key；但**推理接口 `POST /api/v1/chat/completions` 每个模型都必须带 Key**（实测无 Key 返回 401）。因此"免费"指零计价，**不是匿名可用**。

### 1.3 用户诉求（原始）
> 过滤出 OpenRouter 上的免费模型，测试速度和上下文大小，并更新到 OpenRouter 的默认模型列表中，模型名字中添加速度和上下文大小。

---

## 2. 目标与非目标

### 2.1 目标（Goals）
- **G1 过滤**：从 OpenRouter 实时目录中稳定、可解释地筛出"免费模型"，规则可配置、结果可审计。
- **G2 测速**：对筛出的候选做真实推理探测，得到**端到端时延**与**吞吐**两类速度指标。
- **G3 测上下文**：以 OpenRouter 公布的 `context_length` 为基准，并以**真实探测**确认可服务（含 Key 缺失时的降级）。
- **G4 写入默认模型列表**：把通过校验的模型写回 `llm-pi-ai.providers.openrouter`，使 DSH 模型选择器立即可用。
- **G5 可读命名**：模型显示名中内嵌速度与上下文，例如
  `Ling 3.0 Flash Fin · ⚡62 tok/s · 256K`。

### 2.2 非目标（Non-Goals）
- 不做跨 provider 的通用 benchmark（只覆盖 OpenRouter 免费档）。
- 不做计费/账单统计。
- 不修改 OpenRouter 云端任何配置（只读其 API + 写本地 settings）。
- 不引入新的 LLM 适配器；复用现有 `llm-pi-ai` 通道。
- 不自动长时间后台跑测速（v1 仅手动/单次触发；周期化留到 v1.1）。

---

## 3. 用户与场景

**用户**：本机 DSH Desktop 使用者（开发者），希望"不花钱也能用上尽量好的模型"。

**核心场景**
1. **S1 一键刷新**：用户在设置页点「刷新免费模型」，等待若干秒后，模型选择器出现带速度/上下文标注的新模型列表。
2. **S2 只探测不写入**：用户想先看结果（dry-run），确认无误后再点「应用」。
3. **S3 Agent 内触发**：用户在对话里说"帮我更新一下免费模型"，Agent 调用工具完成同样的流程并汇报结果。
4. **S4 无 Key 降级**：用户尚未配置 `OPENROUTER_API_KEY`，此时只能拿到目录元数据（上下文/价格），速度列为"未测"，且明确提示原因。

---

## 4. 功能需求

### FR-1 免费模型过滤
| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| FR-1.1 | 从 `GET /api/v1/models` 拉取目录，带超时与重试 | P0 |
| FR-1.2 | 提供 3 种判定策略：`suffix`（`:free` 结尾）、`zero-price`（prompt+completion 均为 0）、`either`（并集，默认） | P0 |
| FR-1.3 | 支持排除规则：排除指定 id、排除无 `tools` 能力者、排除非文本输出者（如音频） | P0 |
| FR-1.4 | 结果按稳定顺序输出，并给出**为何入选/落选**的理由 | P0 |
| FR-1.5 | 目录拉取失败时保留上次快照并告警，不破坏已有配置 | P0 |

### FR-2 速度测试
| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| FR-2.1 | 对每个候选发起一次最小真实对话（`max_tokens` 可配，默认 32） | P0 |
| FR-2.2 | 记录 `TTFT`（首 token 时延，ms）与 `tok/s`（输入后生成速率） | P0 |
| FR-2.3 | 并发度可配（默认 3），每模型超时可配（默认 30s） | P0 |
| FR-2.4 | 失败模型记录错误类别（401/404/429/超时/空响应），不阻塞其他模型 | P0 |
| FR-2.5 | 同一模型重复 N 次（默认 1）取中位数，降低抖动 | P1 |
| FR-2.6 | 无 Key 时跳过测速，标记 `not-tested` 并说明原因 | P0 |

### FR-3 上下文测试
| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| FR-3.1 | 以 `context_length` 作为申报上下文，写入 `contextWindow` 字段 | P0 |
| FR-3.2 | 提供"真实探测"模式：发送约 `probeTokens` 的输入，验证模型确实接受（而不是被静默截断） | P1 |
| FR-3.3 | 探测发现申报值与实际不符时，标记 `contextMismatch` 并在 UI 提示，**不**擅自改写 | P1 |
| FR-3.4 | 上下文以人类可读形式渲染（262144 → `256K`，1048576 → `1M`） | P0 |

### FR-4 写入 OpenRouter 默认模型列表
| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| FR-4.1 | 写入 `settings` 命名空间 `llm-pi-ai` 的 `providers.openrouter`，保留其他 provider 与其他字段 | P0 |
| FR-4.2 | 写入前经 `llm-pi-ai` 严格校验（`write` 路径不吞诊断） | P0 |
| FR-4.3 | 写入必须显式确认（GUI 二次确认 / 工具 `apply: true`），默认 dry-run | P0 |
| FR-4.4 | 写入后可选自动设为默认模型（仅在用户勾选时） | P1 |
| FR-4.5 | 写入失败（校验不通过）时给出精确原因，且**不改动**原配置 | P0 |
| FR-4.6 | 提供"恢复"能力：覆盖前备份原 `models` 数组，可一键回滚 | P1 |

### FR-5 命名规则（核心诉求）
| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| FR-5.1 | 模型 `name` = `<人类可读名> · <速度> · <上下文>` | P0 |
| FR-5.2 | 速度格式：`⚡{tok/s 取整} tok/s`；未测时省略该段 | P0 |
| FR-5.3 | 上下文格式：`256K` / `1M` | P0 |
| FR-5.4 | 名称可自定义模板（占位符 `{name} {tps} {ttft} {ctx} {id}`），默认模板见 FR-5.1 | P1 |
| FR-5.5 | `id` 必须保持 OpenRouter 原样（含 `:free`），**仅**改 `name`，且写入前 trim 掉控制字符 | P0 |

### FR-6 触发入口
| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| FR-6.1 | 模型工具 `openrouter_free_models`，支持 `list / probe / apply` 三个动作 | P0 |
| FR-6.2 | GUI：设置页按钮 + 结果表格（下次迭代，见 §9） | P1 |
| FR-6.3 | CLI：`node lib/cli.mjs --dry-run`（脱离 DSH 也能跑，便于排障） | P1 |

---

## 5. 关键设计决策

### D1 免费判定默认用 `either`（后缀 ∪ 零价）
```
:free 后缀 (21)  ⊂  零价判定 (24)
```
- 仅用后缀会漏掉 3 个零价模型（2 个是音频输出、`openrouter/free` 是路由别名）。
- 仅用零价会引入非规范条目。
- **决策**：默认 `either`，但 FR-1.3 默认排除非文本输出与无 tools 者，实际会把 2 个音频模型剔除；`openrouter/free` 作为别名默认保留但可用 `excludeIds` 关闭。策略在配置中显式可改。

> **实施后实测结论**（2026-09-21，`either` + `requireTools` + `textOnly` 全开）：
> 目录 **446** 条 → 免费 **20** 条。19 条同时命中"后缀 + 零价"，1 条
> （`openrouter/free`）仅由零价命中。被 `textOnly` 剔除的是
> `google/lyria-3-clip-preview` 与 `google/lyria-3-pro-preview`（音频输出）；
> 另有 4 条免费模型因不声明 `tools` 参数被 `requireTools` 剔除。**这 20 条即
> 实测的默认入选集合**，而非 §1.2 的 24。

### D2 速度指标定义
- `TTFT`：从发出请求到收到**首个含可见文本的 chunk**（流式）。这是交互体感的主导项。
- `tok/s`：`可见输出 token 数 / (末 chunk 时间 − 首 chunk 时间)`；若总时长 < 50ms 或输出 < 5 token，标记为不可靠（`lowConfidence`）。
- 说明：DSH 免费档普遍限流，绝对值仅供参考，**同一轮内的横向对比**才有意义 → 该结论必须写进结果里，避免误导。

### D3 上下文：申报值优先，"探测"为校验
`llm-pi-ai` 的 `contextWindow` 会影响压缩阈值与预算计算，写入错误值比不写更糟。因此：
- 默认（`probeLevel = metadata`）：只用 `context_length`，
- 可选（`probeLevel = infer`）：发送大输入验证，**仅告警不改值**。

### D4 写入安全
- 所有写入走 `ctx.settings.mutate('llm-pi-ai', ops, revision)`，做 revision 检查，避免覆盖并发修改。
- 写入前备份原数组到 `~/.dsh/storages/openrouter-free-models.backup.json`。
- 校验：先本地跑一遍 `llm-pi-ai` 的 schema 规则（name/contextWindow/maxTokens 正整数、id 唯一），失败则直接返回错误，不触碰 settings。

### D5 与用户既有配置的兼容
用户已手写 2 条模型。插件写入时**默认追加/合并**而不是整体替换，并默认清理尾部控制字符（`"minimax/minimax-m3:free\t"` → `minimax/minimax-m3:free`）。重复 id 去重，保留用户手工条目的额外字段。

### D6 实现期修正（实施后补充，均已落地）

实现与联调暴露了三处需要修正的设计假设：

1. **`inject` 是必需依赖门，不是"可选依赖"声明。**
   Cordis 的 `inject` 语义是：列出的服务未就绪时 `apply` **根本不运行**。
   这与"缺 tools 时优雅降级"的需求直接冲突。本插件改为声明 `inject = []`，
   用 `ctx.inject(['tools'], cb)` 延迟获取 —— 这既是 harness 自身的惯用法，
   也让降级路径真正可达。

2. **工具注册必须被生命周期 effect 收养。**
   直接 `tools.register(...)` 会丢弃返回的 disposer，插件卸载后工具仍留在
   注册表里（实测确认泄漏）。改为在 `ctx.effect` 内注册并返回该 disposer 后，
   卸载零残留（`test/plugin.test.mjs` 有回归用例）。

3. **合并阶段需为"无 name 的历史条目"补名。**
   本机 `settings.yaml` 中 `inclusionai/ling-3.0-flash-fin:free` 只有 id 没有 name，
   而 `llm-pi-ai` 要求 name 非空。若原样保留，**整份写入会被校验拒绝**。
   现在合并会为这类条目补上 id 作为 name，并列入报告字段 `named`。

### D7 合并顺序语义

探测结果（按目录顺序）**前置于**历史条目：用户既有条目保留其额外字段，但位置
让给最新排名。"更新模型列表"的语义就是让选择器反映当前目录顺序，同时不丢用户
的手工配置。

---

## 6. 数据与产物

### 6.1 模型记录（内部）
```ts
interface ModelProbe {
  id: string                  // OpenRouter 原样 id，如 "minimax/minimax-m3:free"
  label: string               // 人类可读名，如 "MiniMax: MiniMax M3 (free)"
  contextWindow: number       // 来自 context_length
  freeBy: ('suffix' | 'zero-price')[]
  toolSupport: boolean
  inputModalities: string[]
  speed: null | {
    tps: number | null        // tok/s
    ttftMs: number | null
    samples: number
    lowConfidence: boolean
  }
  contextProbe: null | { declared: number; observed: number; mismatch: boolean }
  displayName: string         // 最终写入 settings 的 name
  status: 'ok' | 'error' | 'not-tested'
  error?: string
}
```

### 6.2 持久化
| 产物 | 路径 | 说明 |
| --- | --- | --- |
| 最近一次探测结果 | `~/.dsh/storages/openrouter-free-models.report.json` | GUI/Agent 复用，避免重复测速 |
| 写入前备份 | `~/.dsh/storages/openrouter-free-models.backup.json` | 回滚用 |
| 运行日志 | DSH logger，前缀 `openrouter-free-models:` | 排障 |

### 6.3 写入到 settings 的最终形态
```yaml
llm-pi-ai:
  providers:
    openrouter:
      apiKeyEnv: OPENROUTER_API_KEY
      models:
        - id: minimax/minimax-m3:free
          name: "MiniMax: MiniMax M3 (free) · ⚡48 tok/s · 1M"
          contextWindow: 1048576
        - id: inclusionai/ling-3.0-flash-fin:free
          name: "inclusionAI: Ling 3.0 Flash Fin (free) · ⚡61 tok/s · 256K"
          contextWindow: 262144
```

---

## 7. 验收标准（可执行）

| 编号 | 验收项 | 判定方式 |
| --- | --- | --- |
| AC-1 | 目录拉取成功且给出免费集合，条数与线上一致 | 单测比对 `:free` 后缀数量 |
| AC-2 | 策略 `suffix` / `zero-price` / `either` 各自结果集正确 | 单测用固定 fixture |
| AC-3 | 显示名符合 `<label> · ⚡N tok/s · 256K` 格式 | 单测断言正则 |
| AC-4 | 未测速的模型不出现 `tok/s` 段落 | 单测 |
| AC-5 | `contextWindow` 为 `context_length` 原值，且人类可读渲染正确 | 单测（262144→256K，1048576→1M） |
| AC-6 | dry-run 绝不写 settings | 单测（mock settings 记录调用次数=0） |
| AC-7 | 写入保留非 openrouter provider 与 unknown 字段 | 单测 |
| AC-8 | 写入合并去重，且清理 `\t` 等控制字符 | 单测（含用户现存脏数据用例） |
| AC-9 | 校验失败时 settings 不被改动 | 单测 |
| AC-10 | 无 Key 时全流程可跑通并标记 `not-tested` | 集成（无凭据环境） |
| AC-11 | 插件在 DSH Desktop 中加载无错误日志 | 实机启动验证 |
| AC-12 | 插件卸载后不留 settings 命名空间与新 provider 路由（无泄漏） | 实机 + 代码审查 |

---

## 8. 风险与对策

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| OpenRouter 免费档限流（429），测速失真 | 高 | 低并发 + 指数退避 + 失败标记而非重试到底；结果里标注"仅供参考" |
| 免费模型动态增减，探测结果过期 | 中 | 报告带 `fetchedAt`；超期（默认 6h）时 UI/工具提示重新探测 |
| 写入错误 `contextWindow` 破坏上下文预算 | 中 | 只用官方 `context_length`；infer 模式仅告警 |
| 覆盖用户手工配置 | 中 | 默认合并 + 备份 + revision 检查 + 二次确认 |
| 免费模型静默返回空响应 | 中 | 记录 `EMPTY_RESPONSE`，标记不可用，不写入 |
| `llm-pi-ai` 内部 schema 与本文档假设漂移 | 低 | 写入前用真实校验函数验证；文档标注"以运行时为准" |
| 低价模型未来变价 | 低 | 每次刷新重新判定，不做跨轮缓存继承 |

---

## 9. 里程碑

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M0 | PRD + CheckList 评审 | 本次交付 |
| M1 | 纯函数核心：过滤 / 命名 / 上下文渲染 / 合并去重 + 单测 | 本次交付 |
| M2 | 探测执行器：OpenRouter 流式测速（TTFB/tok·s⁻¹） | 本次交付 |
| M3 | 写入层：settings mutate + 备份 + 回滚 | 本次交付 |
| M4 | DSH 插件入口：工具 + 生命周期 + 实机加载验证 | 本次交付 |
| M5 | GUI 设置页（结果表格、按钮、二次确认） | 后续迭代 |
| M6 | 周期化自动刷新（schedule 插件 + 变更通知） | 后续迭代 |

---

## 10. 附录：术语与事实来源

- **免费模型**：本 PRD 一律指 OpenRouter 侧 `prompt`/`completion` 计价为 0，或 id 带 `:free` 后缀的模型。
- **默认模型列表**：指 settings 命名空间 `llm-pi-ai` → `providers.openrouter.models`，即 DSH 模型选择器的数据源。
- **事实来源**：`GET https://openrouter.ai/api/v1/models`（公开）；`@deepseek-ai/dsh-llm-pi-ai` 的 `modelProfile` schema；`@deepseek-ai/dsh-settings` 的 `register/mutate/describe` API；本机 `~/.dsh/settings.yaml` 现状。
