---
title: Core 边界与运行时不变量
kind: advisory
triggers: [core, runtime, execution unit, run, resume, loop, tool pipeline, guardrail, hook, event, config, compaction, limits, lock, storage, journal]
paths: [packages/core/**, packages/config/**]
applies_to: [N, M]
---

# Core 边界与运行时不变量

> 改 `packages/core/**` / `packages/config/**` 前读这一篇；硬安全规则仍以 [AGENTS.md](../../AGENTS.md) 为准。

## core 边界

- 不引入 LangChain / LangGraph（ADR-009）。core 的 `dependencies` 保持为空，重依赖只能进插件包。
- core 不出现业务概念（skills、记忆、资产、文档、代码审查、OCR、PDF、图片、向量、浏览器、IAM、计费）。
- Module 是编译期/构造期边界（provider / context / session / policy / transport / observability），不是第二套运行期机制；禁止 `ModuleHost` / `ModuleRegistry`。依赖方向单向 `core ← 其它`，由 `scripts/check-deps.ts` 检查。
- 事件名一律开放字符串 `<domain>.<action>.<event>`，不新增常量 / 枚举（ADR-030）；事件形状见 [events.md](../architecture/events.md)。
- 全异步，不写 sync-in-async；不留半成品 stub。

## 负空间（不得恢复）

- durable 只做 core 的 `RunRecordStore` port；单公司 data-dir 写锁 / 两级租约原语在 core，跨节点 transport 在装配层；已移除 / 不进 core 的能力清单见 [plugins.md](plugins.md)。
- legacy 传输面（`transport.kind` / loopback / remote / 旧 team 面）见 [serve.md](serve.md#legacy-transport)。
- mock 场景只在 `src/mock/`；`VESSEL_MOCK_SCENARIO` 只在 CLI 入口读一次（ADR-063）。

## 运行时不变量

- **单 run 细节**：`run()` / `resume()` 经 `beginExecution` 占位、`finalizeRun` 收尾；不要绕开 `activeRun` 或另写终态持久化 / 事件发布路径（ADR-054）。规则句见 AGENTS。
- **工具执行唯一 pipeline**：不得直调 `ToolDefinition.handler`；顺序 getTool → ToolCall guardrail → BeforeTool → permission → handler → ToolResult guardrail → AfterTool；权限在 guardrail/hook 改写后判定；`tool.call.*` 由调用方发布（ADR-058）。
- **Host 契约**：per-run session 只由 `AgentHandle.run` 消费 `RunOptions.sessionId`；取消经 `AbortSignal.reason` 透传；`resume` 经 Scheduler（`ScheduledTask.runId`）；`snapshot()` 可 JSON 序列化；合成 `agent.run.*` 带 `mirror_of_run_id`（ADR-081）。
- **Runtime / ExecutionUnit 分层**：`Runtime` 是 per-node 无状态工厂（只持单 node profile 与 `(内部单 id, sessionId)` EU 目录），`ExecutionUnit` 是 per-session 长活对象；唯一 EU 构造入口是 `Runtime.getOrCreateExecutionUnit`。
- **唯一写者**：事实事件 / RunRecord / SessionState 由 Run 经 `RunJournal` 写；`ExecutionUnit` 只持只读 EventLog（ADR-098 C1）。`WorkingContext` 归每次 Run（`contextFactory` 新建），不是 EU 的长期字段。
- **压缩摘要**：`role: 'system'` + `compaction_summary: true`，基底 system 之后、其它消息之前，同时最多一条；应用新压缩时移除旧摘要；不得写回 `assistant`（thinking 模式需要 `reasoning_content`）。`message.compaction` 可带 `cleared_tool_call_ids` / `degraded`，恢复先按 id 写回确定性占位再按 `kept` 裁剪（ADR-083）。
- **基底 system 无内置默认**：基底 system 只来自 `config.agent.systemPrompt` / 成员 `system_prompt`；未配置时为空并跳过 system 消息，core 不提供任何内置默认提示词。Self Card 是 runtime 元数据，仍注入。
- **限额**：判定只经 `evaluateUsageLimits` / `evaluateTermination`（ADR-084）。`request_limit` / token / cost / `max_iterations` / `max_runtime` 命中时先发 `limit.blocked` 再抛 `LimitExceededError`；`tool_calls_limit` 是软预算——发一次 `limit.warning`，下一轮请求不提供工具，模型收尾后 run 正常 `completed`。
- **错误 envelope 只增不改**：`run.failed` / `tool.call.failed` 保留原 `error`，新增字段只附加；不写 prompt / reasoning / 完整工具结果（ADR-080）。
- **透明化**：事件形状冻结、快照只填已知字段、Self Card 每 run 一次、BeforeLlm 注入只增不改（ADR-086/087）。

## 配置与存储

- 配置层序固定 `CLI > env > project > user > default`，没有 tenant overlay；只在 `loadConfig()` 合并；CLI flag 经 `buildCliConfigOverrides()`；serve / connect 不自读 argv / env（ADR-057）。
- legacy 配置只读：新版 `provider:` 优先；未注册 provider 且无 `provider.base_url` 抛 `ProviderConfigError`；YAML 解析失败 / 重复键是 validation error；API Key 经 `resolveEffectiveApiKey()`（ADR-068）。
- 默认 `session.backend: file`；保留 sqlite；检测到 legacy 数据只提示 `vessel migrate`，不自动迁移。
- `context.maxTokens` 默认 1M；`context.compactThreshold` 默认 0.85 且是应用层唯一来源（core 兜底同值）；`provider.maxTokens` 是单次输出上限（ADR-064）。

## 单公司存储（根布局）

- 单公司数据直接位于 `<dataDir>/{sessions,runs,events,agents,conversations,teams}/`，
  没有 `tenants/<id>` 层；`tenant.json` 只保存内部持久单 id（缺省 `default`），不是 wire
  字段、不参与路由。legacy sqlite `sessions.tenant_id` 列按读写兼容保留（defer-3，待独立
  数据迁移）；核心 `RunRecord` / 事件 DTO 不再有 `tenant_id`。
- 写意图锁是 `src/data-lock.ts`（单公司 data-dir；`data_locked`）；运行时不再获取写者锁，
  session / run 写冲突仍走 `session_locked` / `run_locked`。非空 `<dataDir>/tenants/**`
  或 `.t2-migrating-*` 启动 fail-fast `non_root_layout`，不读、不删、不迁移。

## 指针

- 运行细节：[runtime-lifecycle](../architecture/runtime-lifecycle.md) · [runtime-loop](../architecture/runtime-loop.md) · [state](../architecture/state.md) · [config](../architecture/config.md) · [events](../architecture/events.md)。
- 路径 denylist / 原子写 / 单 run / 密钥的**规则**见 AGENTS.md 硬安全规则；本文件不复述。
