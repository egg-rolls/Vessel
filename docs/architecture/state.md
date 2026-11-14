---
title: 状态与持久化接口
kind: current
triggers: [session, run store, checkpoint, durable, limits, corruption, prune, 状态, 存储, 检查点, 持久化, 损坏, 裁剪, 上界, 会话存储]
paths: [packages/core/src/types/session.ts, packages/core/src/types/limits.ts, packages/core/src/types/run-record-store.ts, packages/core/src/session/message-identity.ts]
---

# 状态与持久化接口
> Stage 4 已落地：目标模型见 [0.34-target.md](0.34-target.md)，决策见 [ADR-098](../adr/ADR-098-terminology-and-layering-agent-session-runtime-loop-run.md)（accepted）；本文正文描述现态。**0.49 T5 现态**：单公司数据根为 `<dataDir>/{sessions,runs,events}`，没有 `tenants/<id>` 层；`tenant.json` 只保存内部持久单 id，legacy sqlite `sessions.tenant_id` 列按读写兼容保留（defer-3，待独立数据迁移）。`<dataDir>/tenants/**` 非空时启动 fail-fast `non_root_layout`，不移动、不删除数据。
<a id="session"></a>

### `SessionStore`（`types/session.ts`）

```ts
interface SessionStore {
  load(sessionId: string): Promise<SessionState | null>;
  save(state: SessionState): Promise<void>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<string[]>;
  listRich(): Promise<SessionInfo[]>;
  close?(): void;
}
```

（ADR-056）：`FileSessionStore.load()` 只在主路径 `ENOENT` 时回退 legacy；文件存在但不可读或 JSON 损坏 → 抛 `SessionCorruptError`（`code: 'session_corrupt'`，含 `path`），不再静默当成“无会话”。`delete()` 同样先 `load()`，损坏时抛错不删除；`listRich()` 对损坏文件降级跳过，单文件损坏不拖垮列表。

`SessionState.messages` 的消息可以带两个 additive 身份字段（0.51）：`run_id`（这条消息属于哪个 run；用户消息归属它开启的那次 run）与 `run_segment`（同一次 run 内第几段正文，0 起，只数非空 assistant 正文）。`run_id` 在 `ExecutionUnit.addContext`（唯一同时看见消息与 runId 的写入点）盖章；`run_segment` 由 `assignMessageIdentities`（`session/message-identity.ts`）在 `RunJournal.saveSessionState` —— SessionState 的唯一写口 —— 统一补：幂等、压缩删段后不重编号、resume 由事件投影（`projectMessages`）同一函数补齐。缺字段 = 旧数据，`sessions.get` 原样透出、读侧退回按内容比较（Web 时间线据此把「实时流那段正文」与「落盘那条消息」认成同一个对象，正文被 Output guardrail 改写过也认得出）。

<a id="limits"></a>

### `LimitChecker`（`types/limits.ts`）

```ts
interface LimitChecker {
  checkLimits(stats: UsageStats, limits: UsageLimits): boolean;
  checkTermination(stats: UsageStats, policy: TerminationPolicy): boolean;
  incrementRequest(stats: UsageStats): void;
  incrementToolCall(stats: UsageStats): void;
  addTokens(stats: UsageStats, input: number, output: number): void;
  addCost(stats: UsageStats, cost: number): void;
}

interface UsageLimits {
  requestLimit?: number;
  toolCallsLimit?: number;
  inputTokensLimit?: number;
  outputTokensLimit?: number;
  totalCostLimit?: number;
}

interface TerminationPolicy {
  maxIterations?: number;
  maxRuntimeSeconds?: number;
}
```

（ADR-084）：限额判定拆成两个纯函数——`evaluateUsageLimits(stats, limits)` 与 `evaluateTermination(stats, policy)`，都返回 `LimitBlock | null`（`scope` / `key` / `current` / `max` / `source` / `hint` / `retryable: false`）；`MemoryLimitChecker.checkLimits` / `checkTermination` 分别复用它们。终止策略命中同样产生 `LimitBlock`（key `max_iterations` / `max_runtime`）。事件与 envelope 契约见 `docs/versions/0.14.3.md` 与 [ADR-084](../adr/ADR-084-limit-visibility-and-provider-errors.md)。

<a id="run-store"></a>

### `RunRecordStore`（`types/run-record-store.ts`，module port）

```ts
interface RunRecord {
  run_id: string;
  session_id: string;
  agent_id?: string;
  status: 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; total_cost?: number };
  iteration?: number;
  error?: string;
  error_envelope?: ErrorEnvelope;
  event_cursor?: number;
  created_at: number;
  updated_at: number;
  branch?: string;
  metadata?: Record<string, unknown>;
  /** @internal 只读兼容旧 checkpoint 的 messages */
  legacy_messages?: Message[];
}

interface RunRecordStore {
  save(record: RunRecord): Promise<void>;
  load(runId: string): Promise<RunRecord | null>;
  list(opts?: {
    status?: RunRecord['status'];
    session_id?: string;
    limit?: number;
    /** 跳过排序后的前 N 条（缺省 0）；全量分页 */
    offset?: number;
  }): Promise<RunRecord[]>;
  delete(runId: string): Promise<void>;
  close?(): Promise<void>;
}
```
实现：`MemoryRunRecordStore`（进程内）与 `FileRunRecordStore({ dir })`（每 run 一个 JSON 文件，temp + rename，Windows best-effort）。从 `@vessel-agent/core/session` 与根入口导出。**`RunRecordStore` 是 module port，不是第 10 个扩展接口**；`SessionStore`（会话壳：元数据 + messages 投影）与它正交（ADR-040）。
（ADR-056）：`RunRecord` 不再有 `tenant_id`；`FileRunRecordStore` 不传 tenant，也不做 foreign tenant 归属判定。`delete(runId)` 先 `load()`；缺失直接 no-op，损坏时抛错、不 unlink。
（ADR-056）：`list` 增加可选 `offset`（过滤、排序后切片，用于 `deleteSessionData` 的全量分页冲突检查）。`FileRunRecordStore.load()` 把非 ENOENT 读取错误、JSON 解析失败与非法记录形状视为损坏并抛 `SessionCorruptError`（`code: 'session_corrupt'`）；`delete()` 让该错误向上传播，绝不删除归属未知的文件。
`pruneRuns(store, opts?)` helper（`PruneRunsOptions` / `PruneRunsResult`，从根入口与 `@vessel-agent/core/session` 导出），按 `status` / `older_than_ms` / `keep_latest` 清理 run；**不修改 `RunRecordStore` 接口**，也不自动调度（ADR-045）。（0.34）`FileLeaseService`（`src/lease-service.ts`）实现 `LeaseServicePort`（`binding` / `session` 两级租约，TTL + 续租 + 单调 `fencingToken`）：**仅单节点本地** `.locks/leases/**`，不做多节点 / 集群共识、**不可当分布式锁用**；跨节点迁移/接管靠 TTL 过期 + fencing，同一 `dataDir` 多进程依赖本地文件系统语义（原子 `wx` / rename）；写 `SessionEventLog` / `RunRecord` 按 `token >= currentFence` 拒绝旧 token，释放/过期使 fence 递增。

