---
title: 状态与持久化接口
kind: current
triggers: [session, run store, checkpoint, durable, limits, corruption, prune]
paths: [packages/core/src/types/session.ts, packages/core/src/types/limits.ts, packages/core/src/types/run-store.ts]
---

# 状态与持久化接口

<a id="session"></a>

### `SessionBackend`（`types/session.ts`）

```ts
interface SessionBackend {
  load(sessionId: string): Promise<RunState | null>;
  save(state: RunState): Promise<void>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<string[]>;
  listRich(): Promise<SessionInfo[]>;
  close?(): void;
}
```

（ADR-056）：`FileSessionBackend.load()` 只在主路径 `ENOENT` 时回退 legacy；文件存在但不可读或 JSON 损坏 → 抛 `SessionCorruptError`（`code: 'session_corrupt'`，含 `path`），不再静默当成“无会话”。`delete()` 同样先 `load()`，损坏时抛错不删除；`listRich()` 对损坏文件降级跳过，单文件损坏不拖垮列表。

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
  maxIterations: number;
  maxRuntimeSeconds?: number;
}
```

（ADR-084）：限额判定拆成两个纯函数——`evaluateUsageLimits(stats, limits)` 与 `evaluateTermination(stats, policy)`，都返回 `LimitBlock | null`（`scope` / `key` / `current` / `max` / `source` / `hint` / `retryable: false`）；`MemoryLimitChecker.checkLimits` / `checkTermination` 分别复用它们。终止策略命中同样产生 `LimitBlock`（key `max_iterations` / `max_runtime`）。事件与 envelope 契约见 `docs/versions/0.14.3.md` 与 [ADR-084](../adr/ADR-084-limit-visibility-and-provider-errors.md)。

<a id="run-store"></a>

### `RunStore`（`types/run-store.ts`，module port）

```ts
interface RunCheckpoint {
  run_id: string;
  session_id: string;
  agent_id?: string;
  status: 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
  messages: Message[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; total_cost?: number };
  iteration?: number;
  created_at: number;
  updated_at: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

interface RunStore {
  save(checkpoint: RunCheckpoint): Promise<void>;
  load(runId: string): Promise<RunCheckpoint | null>;
  list(opts?: {
    status?: RunCheckpoint['status'];
    session_id?: string;
    limit?: number;
    /** 跳过排序后的前 N 条（缺省 0）；全量分页 */
    offset?: number;
  }): Promise<RunCheckpoint[]>;
  delete(runId: string): Promise<void>;
  close?(): Promise<void>;
}
```

实现：`MemoryRunStore`（进程内）与 `FileRunStore({ dir, tenantId? })`（每 run 一个 JSON 文件，temp + rename，Windows best-effort）。从 `@vessel-agent/core/session` 与根入口导出。**`RunStore` 是 module port，不是第 10 个扩展接口**；`SessionBackend`（会话对话持久化）与它正交（ADR-040）。

（ADR-056）：`FileRunStore` 接受可选的 `tenantId`。tenant 模式下 `delete(runId)` 先 `load()` 校验归属——缺失或属于其它 tenant 时直接 no-op，不 unlink 文件；与 `FileSessionBackend.delete` 的 foreign 会话语义对称。装配层在 `--resume-run`、单 agent 与 per-tenant runtime 三条路径都把 `tenantId` / `tenantRunsDir` 透传到 store。

（ADR-056）：`list` 增加可选 `offset`（过滤、排序后切片，用于 `deleteSessionData` 的全量分页冲突检查）。tenant 模式下 `FileRunStore.load()` 把非 ENOENT 读取错误、JSON 解析失败与非法 checkpoint 形状视为损坏并抛 `SessionCorruptError`（`code: 'session_corrupt'`）；`delete()` 让该错误向上传播，绝不删除归属未知的文件。非 tenant 模式保持宽松语义（损坏 → `null`）。

`pruneRuns(store, opts?)` helper（`PruneRunsOptions` / `PruneRunsResult`，从根入口与 `@vessel-agent/core/session` 导出），按 `status` / `older_than_ms` / `keep_latest` 清理 run；**不修改 `RunStore` 接口**，也不自动调度（ADR-045）。

