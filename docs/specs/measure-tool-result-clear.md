---
title: 工具结果清理：体积阈值与实测对照（0.53 主题1 ②③）
kind: current
triggers:
  - 改 KEEP_RECENT_TOKEN_RATIO / KEEP_RECENT_MAX / TOOL_RESULT_VOLUME_THRESHOLD_RATIO
  - 改 planClearedToolResults / measureRetainedToolResultVolume / shouldCompact 的触发条件
  - 讨论「前缀缓存命中率」「cached_tokens 占比」「多清还是少清」
paths:
  - packages/core/src/context/context-manager.ts
  - packages/core/src/types/context.ts
  - scripts/check-tool-result-clear.ts
  - scripts/measure-tool-result-clear.ts
---

# 工具结果清理：体积阈值与实测对照

0.53 主题1 的 ②（体积阈值）与 ③（实测对照）。① 段起点冻结已在 `1bdbab35` 落地，本文不重复。

**一句话**：默认行为一个字节都没变（4 道门禁改前改后同色，46 个真实 run 里体积阈值触发 0 次）；
新增的体积维度只在「单条工具结果自己吃掉窗口 ≥20%」时才说话；实测对照给出的方向是
「少清、晚清、开新段时才清」—— 同一批真实会话上 cached 上界从 37.0% 抬到 74.8%。

---

## A. 判据变更

### A1. 把 5% / 10 条抽成命名常量 + 可注入参数

`packages/core/src/context/context-manager.ts`：

| 之前 | 现在 | 值 |
| --- | --- | --- |
| `const KEEP_RECENT_TOKEN_RATIO` | `export const KEEP_RECENT_TOKEN_RATIO` | 0.05（未改） |
| `const KEEP_RECENT_MAX` | `export const KEEP_RECENT_MAX` | 10（未改） |
| 无 | `export const TOOL_RESULT_VOLUME_THRESHOLD_RATIO` | 0.2（新增） |

`retainedToolResultCount` / `planClearedToolResults` 多一个可选入参
`ToolResultKeepOptions { keepRecentTokenRatio?, keepRecentMax? }`，缺省即上面两个常量。
抽参只为让门禁能把「恰好等于预算 / 预算 + 1」钉死，**不改任何默认路径**。

### A2. 新增体积阈值维度

- 语义（HANDOFF 原话）：「保留下来的工具结果原文体积超过窗口预算的 N% ⇒ 触发压缩/开新段」。
- 判据：`measureRetainedToolResultVolume(messages, maxTokens, options?)` 返回
  `{ maxTokens, thresholdRatio, retainedCount, retainedTokens, ratio, exceeds }`；
  `shouldCompactForToolResultVolume(...)` 是它的布尔壳。**严格大于**才算触发
  （恰好等于阈值不触发，门禁 T6.1 锁住）。
- 「保留下来的」= `planClearedToolResults` 会保留原文的那几条（最新结果，累计 ≤ 5% 预算）。
  已清空的占位条只有几十字符，量它们没意义。
- 覆盖方式：**配置参数** `ContextConfig.toolResultVolumeRatio`，不用环境变量。
  理由：core 是库，环境变量会让同一份代码在不同机器上判定不同，也没法在门禁里逐例注入；
  配置参数能同时被 runtime 与门禁拿在手里。
- 接线：`ContextManager.shouldCompact()` 在原有
  `tokenCount > max × compactThreshold || isOverMessageCap()` 之后**或**上体积维度。
  它只多一个触发理由，不放宽 token 主阈值，也**不参与「清几条」的决策**
  （T6.9 锁住：触发体积阈值前后，清除集合逐字节相同）。
- 段起点冻结的语义不变（`execution-unit.ts` 属禁改清单，未动）。

**默认值 0.20 的依据**

1. `retainedToolResultCount` 已把「多条保留」封在窗口 5% 以内（≤10 条、累计 ≤ `max × 5%`），
   所以 20% 只可能被**单条巨型结果**顶到 —— 那正是不该继续往同一段里塞的情形
   （例如一次 `read` 回 200KB 文件）。
2. 20% = 保留预算的 4 倍：实测 46 个真实 run 的最大保留体积占比是 **4.7%**，
   0 个触发（表 1 下方统计）。默认配置因此与旧行为等价，不是靠嘴说的。
3. 必须高于 5%（否则每段都触发 = 把冻结白做），必须明显低于压缩主阈值 85%
   （否则体积维度永远轮不到说话）。20% 在两端都留出 4 倍余量。
4. 按体积而不是按条数：体积才是 provider 计费与前缀缓存的实际成本，
   条数会漏掉「一条顶十条」的巨型结果。

### A3. 门禁只增不删（`scripts/check-tool-result-clear.ts`：32 → 43 项）

| 编号 | 断言 |
| --- | --- |
| T6.0 | 常量冻结：5% / 10 条 / 20% |
| T6.1 | 阈值边界：保留 200 tokens / 窗口 1000 = 0.2 ⇒ **不触发** |
| T6.2 | 阈值 +1 token：201/1000 ⇒ 触发 |
| T6.3 | 可清 0 条：只有 1 条工具结果 ⇒ 清除集合空、体积不触发 |
| T6.4 | 整个窗口都被工具结果占满（20 条 × 1000 tokens）⇒ 仍只保留 1 条，且触发 |
| T6.5 | 默认阈值不触发：正常段 6 条 × 106 tokens，保留 1 条 = 10.6% |
| T6.6 | 默认阈值触发：单条 300 tokens / 1000 = 30% |
| T6.7 | 默认配置 ≡ 显式默认值 ≡ 冻结期望集合（5% 预算维度，逐字节） |
| T6.8 | 同上，10 条上限维度（12 条结果 ⇒ 清 `call_0`、`call_1`） |
| T6.9 | 体积判据不参与清除集合决策（触发前后清除集合相同） |
| T6.10 | 保留条数 + 清除条数 = 工具结果总条数 |

R4 / C1h / append-only 的判据一个字都没动；`check-append-only-context.ts` 的
C1h（20 passed / 1 PENDING）改前改后完全一致。

---

## B. 实测对照

数据源：本机 `Vessel/.vessel/sessions.db`（46 个真实 run 快照）。跑法：

```bash
bun run scripts/measure-tool-result-clear.ts --db=<sessions.db> --max-tokens=<窗口>
```

默认 `maxTokens = 200000`（本机真实最大 prompt 150475，留 ~33% 余量），
压缩阈值 0.85 与 core 默认同源。**每列都标了来源，混着看就是错。**

### B1. 真实 run 的用量（有工具结果的那 11 个 run，[实测]）

| run | session | messages | tool 条数 | prompt_tokens | cached_tokens | 保留体积占比 | 重算新增清除条数 [推算] |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 20260728 | 18 | 2 | 2577 | 未上报 | 0.0% | 0 |
| 2 | 20260728 | 19 | 10 | 62140 | 未上报 | 4.7% | 3 |
| 3 | 20260728 | 22 | 6 | 23923 | 未上报 | 0.1% | 0 |
| 6 | 20260731 | 47 | 33 | 150475 | 未上报 | 2.5% | 32 |
| 7 | 20260731 | 22 | 13 | 105833 | 未上报 | 3.4% | 3 |
| 10 | 20260731 | 10 | 3 | 6439 | 未上报 | 0.3% | 0 |
| 21 | 20260810 | 11 | 2 | 18311 | 未上报 | 0.0% | 0 |
| 23 | 20260810 | 13 | 5 | 41037 | 未上报 | 0.1% | 0 |
| 40 | 20261017 | 20 | 8 | 22692 | 未上报 | 1.2% | 0 |
| 42 | 20261017 | 5 | 1 | 2540 | 未上报 | 0.0% | 0 |
| 46 | 20261018 | 33 | 17 | 43826 | 未上报 | 1.0% | 7 |

- `messages` / `tool 条数` / `prompt_tokens`：[实测]，直接来自磁盘。
- `cached_tokens`：**46/46 全部未上报**（`usage` 里没有 `cache_read_input_tokens`），
  所以「cached 占比」这一列在本机只能是 §B2 的推算值，不能当实测写进汇报。
- `保留体积占比`：[实测输入 + 确定性判据] —— 消息是真实的，占比由 core 的
  `measureRetainedToolResultVolume` 算出。
- `重算新增清除条数`：[推算] —— 见 §未验证项第 2 条（run 切分）。

**默认阈值触发统计**：`TOOL_RESULT_VOLUME_THRESHOLD_RATIO = 0.2` 在 46 个真实 run 里触发 **0** 次；
实测最大保留体积占比 **4.7%**（run 2，保留 7 条 / 9429 tokens，窗口 200k）。

### B2. 两种策略的前缀可复用长度（[推算]，离线模拟）

模型（写死了，便于被人推翻）：provider 的 `cached_tokens` ≈ 上一条请求与本条请求的
**最长公共前缀**长度；段边界（估算 prompt 越过 0.85 × 窗口）按 core 默认压缩阈值判定；
每条消息的 token 用 core 的 `estimateTokens`（`ceil(chars / 4)`）口径。

取 6 个工具结果最多/最大的真实会话，各重建逐次调用（完整表由脚本输出，此处节选）：

| session | run | 现状：cached 上界 | 旧行为：cached 上界 | 旧行为本 run 新清掉 |
| --- | --- | --- | --- | --- |
| 20260731 | 4 | 13.2% | 2.6% | 3 |
| 20260731 | 7 | 90.6% | 5.0% | 4 |
| 20260731 | 10 | 66.7% | 13.3% | 13 |
| 20260728 | 4 | 18.7% | 18.7% | 0 |
| 20260728 | 5 | 77.4% | 3.4% | 3 |
| 20261018 | 8 | 94.7% | 4.5% | 1 |
| 20261018 | 13 | 91.5% | 17.4% | 2 |

汇总（6 个真实会话，[推算]）：

- 现状（段起点冻结）：cached 上界 **74.8%**，累计未缓存输入 **93 073** tokens。
- 旧行为（每 run 重算）：cached 上界 **37.0%**，累计未缓存输入 **123 927** tokens。
- 理论上界 / 下界：上界 = 上表（前缀全命中）；下界两种策略都是 **0%**
  （provider 缓存全失效时一条都命中不了）。真机大概率落在两者之间。
- 机制：每 run 重算会把占位符插到窗口**早期位置**，前缀当场失配，之后整段都进不了 cache；
  段起点冻结只在开新段那一次失配。旧行为买到的「prompt 更小」不足以抵掉这条
  —— 净增 30 854 tokens 未缓存输入。

### B3. 合成兜底（[合成]，不是实测）

`--synthetic` 用 `MemoryLLMProvider` + 8 run fixture（窗口压到 8k 才清得动）：

| run | prompt tokens [合成] | 现状 cached 上界 | 旧行为 cached 上界 | 旧行为本 run 新清掉 |
| --- | --- | --- | --- | --- |
| 3 | 1538 | 50.8% | 3.9% | 1 |
| 5 | 3052 | 75.2% | 7.6% | 1 |
| 8 | 5323 | 85.8% | 12.7% | 1 |
| 均值 | — | **75.1%** | **7.7%** | 0.75/run |

注意：`MemoryLLMProvider` 自带的 usage 是固定常量（`prompt_tokens = 10` 或输入长度），
**不是前缀感知的**，给不出真实 cached 值 —— 这张表的 prompt/cached 全是脚本按
`estimateTokens` 算的合成值，只用来说明判据形状，不能当证据。

### B4. 结论：阈值该定多少

**保持默认 0.20，不要调低。**

1. 0.20 在本机 46 个真实 run 上触发 0 次，实测最大值 4.7% —— 还有 4.2 倍余量。
   调低到 0.10 会把「单条 20k tokens 的 read」都算成该开新段，等于把段起点冻结
   刚赚到的 74.8% cached 上界自己打回去。
2. 不能低于 5%：保留预算本身就是 5%，跌破它就等于每段必触发，冻结白做。
3. 体积维度是「少清但不能无限塞」的兜底，不是主阈值 —— 主阈值仍是 token 0.85。
   两个阈值留 4 倍间距，是为了让 token 阈值先说话，体积阈值只在巨型单条结果处兜住。
4. 换算成可读的量：200k 窗口 ⇒ 单条工具结果 > 40k tokens 触发；
   1M 窗口 ⇒ > 200k tokens 触发。现实中只有 `read` 大文件/大日志会摸到，
   正是应该停下来开新段的场景。

---

## 未验证项

1. **真机 cached 数字没拿到**：本机 46/46 个 run 的 `usage` 都没有
   `cache_read_input_tokens`，表 1 的 cached 两列只能是「未上报」，
   §B2/§B3 的占比全部是推算。要拿真数：让 provider 适配层把该字段写进 `usage`，
   然后 `bun run scripts/measure-tool-result-clear.ts --db=<sessions.db> --max-tokens=<窗口>`。
2. **run 切分是推算**：落盘快照是「run 结束时的历史」，逐次调用边界按 assistant 消息位置
   反推（`splitFrames`）。真实边界若不同，表 2 的逐行数字会变，但汇总量级不应变。
3. **前缀缓存模型未在真机校验**：假设 provider 只按「整段前缀」命中。
   Anthropic 的 cache breakpoints、OpenAI 的自动前缀缓存、各家最小可缓存长度
   都会让真机值偏离上界。
4. **窗口参数是猜的**：`--max-tokens=200000`。真实模型窗口未落盘，
   本文所有占比都随该参数线性变化（阈值触发统计同理）。
5. **根 `tsc` 未跑**：worktree 无 `node_modules`，类型检查在主线兜。
   本地只确认了脚本能被 bun 直接跑通。
6. **`bun run check:docs` 不存在**：仓库里没有该 npm script，改跑
   `bun run scripts/check-docs.ts`。

