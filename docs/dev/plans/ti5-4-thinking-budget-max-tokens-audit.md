# TI5-4 审计与修复方案：thinking 注入 budget 超 max_tokens 致 provider 400

- 分支：`fix/q-ti5-4-budget`（基于 redblue-dev @ 4ddb2489）
- 执行：q-ti5-4-budget（红蓝微修复）
- 状态：审计完成 → 方案候 main 合并 → 金丝雀行为复验

## 1. 症状

O-TI2 映射修复让 `dashscope/qwen4-max` 命中 thinking-intensity 插件 qwen 行（budget 形状），
high 档注入 `thinking_budget=16384`；canary model config `max_tokens=4096` 未随之抬升 →
Dashscope 返回 400：

```
max_completion_tokens[4096] must be greater than thinking_budget[16384]
```

canary lead + lifecycle tester 双双 `provider_http_error` 阻塞（节点活、agent 死）。
临时 workaround：canary `default_level: low`（2048 < 4096）解阻。

## 2. 根因（file:line 审计）

| 环节 | 位置 | 事实 |
| --- | --- | --- |
| 注入形状 | `plugins/context/thinking-intensity/src/mapping.ts:103-114` | qwen 行（`/^qwen/i`，budget 形状）：非 off ⇒ `{ enable_thinking: true, thinking_budget: budget }`；off ⇒ `{ enable_thinking: false }`。档位默认 `state.ts:38-40`：low=2048 / medium=8192 / high=16384 |
| 请求体构建 | `packages/core/src/provider/providers.ts:473-484`（非流式）/ `571-583`（流式） | `OpenAICompatibleProvider`：`max_tokens: req.max_tokens ?? this.maxTokens`（canary config=4096），随后 `mergeExtraParams` 浅合并 extra_params |
| 合并闸 | `packages/core/src/provider/request-extras.ts:160-202` | `max_tokens` 在 `RESERVED_BODY_KEYS_OPENAI`（:44-52）⇒ 插件**不能**覆盖 max_tokens；`thinking_budget` 是普通透传键，照常合并 |
| 一致性缺口 | `request-extras.ts:215-242` | 只有 `applyAnthropicThinkingConsistency`（Anthropic 形状，clamp budget down 哲学）；**OpenAI/qwen budget 形状（enable_thinking + thinking_budget）无任何一致性处理** ⇒ 4096 < 16384 的必 400 请求原样发出 |

设计文档原约定（`docs/dev/plans/thinking-intensity-plugin-design.md` R8）：
「适配器 clamp 只兜 Anthropic 硬约束；其它厂商超限 ⇒ 400 可见 + 修表」——
本次事故即该缺口在 qwen4 新输出预算语义下的显形。

**档位影响面**（canary max_tokens=4096）：low=2048 幸免（workaround）；
medium=8192 与 high=16384 均必 400。

## 3. 用户裁定（修复方向）

> 「这个我感觉是因为思考强度限制了 token 数量导致的，正常来说不应该对这个进行限制，
> 控制思考强度只是传额外请求头」+「我倾向于不去限制太多」。

⇒ thinking 强度只传额外请求参数（enable_thinking/thinking_budget），**不该限制 token 数**。
修复方向 = **抬 max_tokens 容纳 thinking_budget**，不是 clamp budget down。

## 4. 修复方案

### 4.1 `request-extras.ts` 新增 `applyOpenAIThinkingConsistency`

与 `applyAnthropicThinkingConsistency` 同模块同判据（形状一致性，不做厂商语义映射；
绝不抛错；无 thinking / 非 budget 形状 ⇒ 返回原对象逐字节不变）：

触发条件（全部满足才动 body）：
1. `body.thinking_budget` 是有限正数（budget 形状在场）；
2. `body.enable_thinking !== false`（显式关闭 ⇒ 不思考，不动）；
3. `body.max_tokens` 是 number 且 `max_tokens <= thinking_budget`（必 400 形状）。

动作：**抬** `max_tokens = thinking_budget + 8192`（克隆 body，只改这一个键），
并 `warnOnce` 一次性告警（可观测，金丝雀可据此核对）。不 clamp budget、不丢 thinking。

余量裁定（+8192）：
- 约束是严格大于（`max_completion_tokens > thinking_budget`），+8192 留足响应空间；
- 8192 对 agent 单轮输出（长 tool_call arguments / 代码块）宽裕；
- high=16384 ⇒ 24576，远低于 qwen4-max-preview 输出上限 393216（见 §5），
  也低于当代主流模型输出上限，不会抬出新的超限 400；
- 固定常量可预测，无厂商语义；只在「原本必 400」的形状上触发，
  任何本来能成功的请求（max_tokens > budget）逐字节不变。

### 4.2 接线（与 Anthropic 同位置模式）

`providers.ts` 两处 `mergeExtraParams` 之后包一层（对照 Anthropic :884-885）：
- 非流式 :473 `const body = applyOpenAIThinkingConsistency(mergeExtraParams(...))`
- 流式 :571 `const streamBody = applyOpenAIThinkingConsistency(mergeExtraParams(...))`
- `provider/index.ts` 对称 re-export 新函数。

### 4.3 不动面（红线）

- thinking-intensity 插件零改动（映射/档位/注入形状不动）；
- Anthropic clamp 哲学不动（聚焦 OpenAI/qwen bug）；
- `RESERVED_BODY_KEYS_OPENAI` 不动（max_tokens 所有权仍属 core，插件仍不可覆盖；
  抬升是 core 自己在合并后的一致性兜底）；
- 无 thinking / effort 形状（reasoning_effort）/ toggle 形状请求逐字节不变；
- core 不做厂商语义映射：函数只认识「budget 形状两数值键的序关系」这一传输协议硬事实
  （与 Anthropic budget<max_tokens 同类），不认识任何厂商。

## 5. 口径核实（③ litellm/Dashscope max_tokens → max_completion_tokens）

1. **事故实证（最强证据）**：core 全仓只发 `max_tokens`（grep 确认代码中无任何
   `max_completion_tokens`）；400 报错中的 `max_completion_tokens[4096]` 与 canary
   config `max_tokens=4096` 逐值吻合 ⇒ 中间网关（litellm/Dashscope 兼容模式）把
   core 发出的 max_tokens 翻译/别名为 max_completion_tokens 后校验。
   **抬 max_tokens 即抬被校验的 max_completion_tokens。**
2. **qwen4 新语义**（官方文档核对的公开资料，2026-11）：自 qwen4-max-preview 起
   `max_tokens ≡ max_completion_tokens`，两者都限制「思考 + 最终回答」总量；
   输出上限 393216。旧 qwen 行为不变（max_tokens 只管答案）。canary 的问题模型
   dashscope/qwen4-max 属新语义 ⇒ 总盘子必须 > thinking_budget，抬 max_tokens 正解。
3. litellm 对 OpenAI 兼容 reasoning 模型将 max_tokens 映射为 max_completion_tokens
   透传（与 1 的实证一致）；core 侧无需改名，抬值即可。

## 6. 修复后实证设计（行为验证归金丝雀，零测试/零探针）

canary 同步后 lifecycle 复验（max_tokens config=4096 不变）：

| 档位 | 注入 | 修复前 | 修复后请求体 | 预期 |
| --- | --- | --- | --- | --- |
| high | thinking_budget=16384 | 400 阻塞 | max_tokens=24576 > 16384 | 不再 400，正常思考+响应 |
| medium | thinking_budget=8192 | 400 | max_tokens=16384 > 8192 | 不再 400 |
| low | thinking_budget=2048 | 正常（workaround） | 2048 < 4096 ⇒ 不触发，逐字节不变 | 行为不变 |
| off | enable_thinking=false | 正常 | 无 budget ⇒ 不触发，逐字节不变 | 行为不变 |
| 非 qwen（effort 等） | 无 thinking_budget | 正常 | 不触发，逐字节不变 | 行为不变 |

静态实证：high 档请求体 `thinking_budget=16384 < max_tokens=24576`，
满足 Dashscope 严格大于约束；流式/非流式两分支同规则。

## 7. 门禁

唯一门禁 `bun run build`（worktree 根，typecheck+lint+📦，本仓无 bundle ADR-006）。
零测试/零探针（宪法）；行为验证归金丝雀。