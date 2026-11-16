/**
 * Gateway 协议 v1（vessel.gateway/1）
 *
 * 0.1.0 只实现单节点控制面：事件、运行、会话、工具、权限、静态托管。
 * legacy team 任务协议已于 0.22.1 删除，只剩 `team.*` 方法的 method_not_allowed 守卫。
 *
 * @module @vessel-agent/serve/protocol
 */

import type { RunEvent } from '@vessel-agent/core';

/** 协议版本（主版本） */
export const PROTOCOL_VERSION = 1 as const;

/** 协议标识与能力广告 */
export interface ProtocolInfo {
  name: 'vessel.gateway';
  version: 1;
  /** 可接受的最低客户端主版本 */
  min: 1;
  /** 可选能力；客户端按需降级 */
  features: string[];
}

/** 本进程节点的公开信息 */
export interface NodeInfo {
  node_id: string;
  /** 人类可读展示名（0.25）；缺省回退 `node_id`。 */
  name: string;
  pid: number;
  started_at: number;
  endpoint: string;
  role: 'standalone' | 'team';
  status: 'idle' | 'busy' | 'draining';
  current_run_id?: string;
  current_session_id?: string;
  capabilities: {
    tools: string[];
    provider?: string;
    model?: string;
    max_concurrency: 1;
    protocol: 1;
  };
}

/** 稳定错误码（0.1.0 实际使用的子集 + 0.2 预留） */
export type ProtocolErrorCode =
  | 'unauthorized'
  | 'forbidden_origin'
  | 'invalid_host'
  | 'unsupported_protocol'
  | 'invalid_request'
  | 'not_found'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'no_runtime'
  | 'no_session'
  | 'busy'
  | 'depth_exceeded'
  | 'task_not_found'
  | 'cancelled'
  | 'internal'
  // R3 team
  | 'team_disabled'
  | 'no_host'
  | 'no_spawn'
  | 'peer_not_found'
  | 'peer_unreachable'
  | 'peer_error'
  | 'timeout'
  | 'agent_not_found'
  | 'broadcast_not_supported'
  | 'remote_cancel_not_supported'
  | 'transport_closed'
  | 'inbox_overflow'
  // 0.3 durable / MCP（DECISION-008 §4.4 + Addendum A/B）
  | 'run_not_found'
  | 'run_not_resumable'
  | 'run_already_running'
  | 'durable_disabled'
  | 'mcp_disabled'
  // 0.4 metrics / feishu / evals（DECISION-009 §5.7 / §10.3）
  | 'metrics_disabled'
  | 'channel_disabled'
  | 'eval_not_found'
  // 0.5 RPC / 多租户（DECISION-010 A-3 §10.2）
  | 'forbidden'
  | 'invalid_params'
  | 'data_locked'
  | 'quota_exceeded'
  | 'conflict'
  // 0.13：权限/交互请求已过期或已取消（DECISION-024 §2.2）。
  | 'expired'
  // 0.13 Addendum A：run 已结束 / 重启后找不到 run。
  | 'run_ended'
  // 0.48 M3：插件 WS 路由形态错误（CONTRACT-0.48 §3.3）。
  | 'upgrade_required'
  | 'upgrade_not_allowed'
  // 0.54 B1：时间线订阅（ADR-105 §6 / D4）。
  // - `session_frozen_readonly`：旧格式会话**写**保护（有 `events.ndjson`、没有 timeline
  //   标记 ⇒ 只读冻结）。与 core 的写者错误码**同名同义**（`packages/core/src/timeline/types.ts`）。
  //   0.54 C 起它**不再**是读分支：`after_timeline_seq` 订阅遇到"没有时间线标记"时给空段
  //   （新会话在磁盘上也是这个形状，报成冻结是假事实，见 `EMPTY_TIMELINE_HEADS`）；
  //   `timeline.read_from` 回退开关也随之删除。
  // - `timeline_unavailable`：装配层没开 timeline 读面（端口缺失）。与上一条分开，
  //   是因为「服务端没开这个能力」不是「这个会话坏了」——报错文本会误导排障。
  | 'session_frozen_readonly'
  | 'timeline_unavailable';

export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;
  retryable?: boolean;
  /** RPC 错误的结构化细节（如 `{ reason: 'history_changed' }`）；可选、additive。 */
  details?: unknown;
}

/** 服务端 → 客户端帧 */
export type ServerFrame =
  | {
      v: 1;
      kind: 'hello';
      node_id: string;
      ts: number;
      protocol: ProtocolInfo;
      node: NodeInfo;
      /**
       * 0.9：本进程事务代际（12 位随机短 id）。
       * 远端按 `(node_id, incarnation, run_id, seq)` 去重；缺失时按 `-` 兼容。
       */
      incarnation: string;
      /**
       * 本次 epoch 实际会发送的第一条 seq：有回放窗口时为窗口首条；
       * 已追平为 `latest_seq + 1`；空缓冲为 0。
       */
      from_seq: number;
      /** 服务端当前最新 seq；无事件时为 0 */
      latest_seq: number;
      // ── 0.54 B1：时间线段（**全部 additive**，老客户端忽略即旧行为）──────────
      /**
       * 本次 epoch 的读源。
       * - `'timeline'`：下面六个字段都有效，帧的 `seq` 是会话内 `timeline_seq`；
       * - `'legacy'`：老订阅 / `read_from = 'legacy'` 回退期，帧的 `seq` 仍是进程级
       *   hub seq，客户端必须按老行为处理（**不做**四条 count 校验）。
       * 缺省 = 老服务端，等价于 `'legacy'`。
       */
      timeline_source?: 'timeline' | 'legacy';
      /**
       * 声明区间的左端（闭）= `after_timeline_seq + 1`；`reset` 时为 1。
       * 可以落在 `holes` 里 ⇒ 客户端第一条实收是「该洞之后第一个非洞 seq」。
       */
      start_seq?: number;
      /**
       * 声明区间的右端（**闭**）= `wal_head`。不是页末、也不是 `timeline_head`。
       * 分页时每页报同一个右端，客户端攒到它再核 count。
       */
      end_seq?: number;
      /**
       * `[start_seq, end_seq]` 里服务端会发出的可读事件条数
       * = `(end_seq - start_seq + 1) - Σ|holes ∩ 区间|`。
       * 口径与边界见 `gateway/timeline-protocol.ts#timelineHello`。
       */
      count?: number;
      /** 已归档进 `timeline.ndjson` 的最大 seq（`≤ wal_head`，不变式）。 */
      timeline_head?: number;
      /** `[1..wal_head]` 每条要么可读、要么已被 `holes` 声明。 */
      wal_head?: number;
      /**
       * **一定被发布过**的最大 seq（`<= wal_head`）。
       *
       * `published_head < wal_head` 时，`(published_head, wal_head]` 是 pub-i2 的崩溃窗口产物：
       * 磁盘上可读、但**从未被发布**，所以**允许永远不被推送**。客户端据此知道：
       * - `count` 只覆盖到 `min(end_seq, published_head)`；
       * - 那一段缺失**不得**报 `timeline_gap_reported`（它不是丢数据，是没承诺过要发）。
       * 缺省（老服务端）等价于 `= wal_head`：全部视为已发布。
       */
      published_head?: number;
      /** 本次区间内**已声明**的洞（归并 / 排序 / 裁进区间）；空数组 = 没有洞。 */
      holes?: { from_seq: number; to_seq: number }[];
      /** 会话级污点（洞存在或最后一次状态声明为 tainted）：标记但不阻断渲染。 */
      tainted?: boolean;
      /** 客户端游标已越过服务端事实（`after_timeline_seq > wal_head`）：整段重拉。 */
      reset?: boolean;
    }
  | {
      v: 1;
      kind: 'event';
      node_id: string;
      ts: number;
      seq: number;
      /** 网关级运行 id（run.started 之后可知） */
      job_id?: string;
      event: RunEvent;
    }
  /**
   * 缺口区间（**过渡期字段，B2 落地即删**）。
   *
   * 只由 `timeline_source === 'legacy'` 的**老 epoch** 发：B2 上线前老客户端就是
   * 生产客户端，它靠这一帧知道「慢消费 / 预算跳过让我漏了 [from_seq, to_seq]」；
   * 删早了就变成「静默丢帧变真静默」——那正是我们这半年在消灭的那类 bug。
   *
   * **时间线 epoch 永不发**这个帧：它的连续性由 `hello` 的 `count`（覆盖到
   * `min(end_seq, published_head)`）与 `holes`（写者声明的不可读区间）表达，
   * 缺一条就是客户端自己算错，由客户端报 `timeline.gap_reported`（ADR-105 §9 R4）。
   */
  | {
      v: 1;
      kind: 'gap';
      node_id: string;
      ts: number;
      from_seq: number;
      to_seq: number;
    }
  | { v: 1; kind: 'res'; node_id: string; ts: number; id: string; ok: true; result: unknown }
  | {
      v: 1;
      kind: 'res';
      node_id: string;
      ts: number;
      id: string;
      ok: false;
      error: ProtocolError;
    }
  | { v: 1; kind: 'ping'; node_id: string; ts: number };

/** 客户端 → 服务端帧 */
export type ClientFrame =
  | {
      v?: 1;
      kind: 'auth';
      token: string;
      role?: 'console';
      since?: number;
      /** 0.9：客户端进程代际（additive；网关不据此做鉴权或去重） */
      incarnation?: string;
    }
  | { v?: 1; kind: 'req'; id: string; method: string; params?: unknown }
  | { v?: 1; kind: 'pong' }
  /**
   * 0.54 B1：客户端自报「游标收到的集合与 `hello` 的 `count` 对不上」。
   *
   * 为什么走**连接上一帧**而不是一个 RPC 方法：这条报告的语义是「这趟握手/回放我核不上」，
   * 属于传输层事实，且它必须能在 RPC 通道坏掉（服务端正忙 / 订阅刚失败）时仍然送达。
   * 服务端只做**记录**（`timeline.gap_reported` 事件 + 一条结构化 warn），
   * 不据此改 `holes`、不改读源——洞只能由写者声明（ADR-105 §6）。
   */
  | {
      v?: 1;
      kind: 'timeline_gap';
      /** 发生在哪个会话上（`timeline_seq` 是会话内序号，缺它这条报告无从定位）。 */
      session_id?: string;
      /** 客户端算的、与服务端声明对不上的两个数（ADR-105 §6 校验 3/4）。 */
      expected?: number;
      received?: number;
      /** 本次 epoch 服务端声明的区间（可选，便于对账）。 */
      start_seq?: number;
      end_seq?: number;
      /** 客户端游标在报告时的位置（排他游标的当前值）。 */
      after_timeline_seq?: number;
      /** 四条校验里哪条没过：1 首条 / 2 末条 / 3 条数 / 4 集合闭区间。 */
      check?: 1 | 2 | 3 | 4;
    };

/** 运行状态 */
export interface RunStatus {
  /** 网关分配的稳定 id；API 用它做查询/取消 */
  run_id: string;
  /** core 事件流里的 run_id（run.started 后可知） */
  core_run_id?: string;
  session_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  output?: string;
  error?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    total_cost?: number;
  };
  started_at?: number;
  completed_at?: number;
  queue_position?: number;
  /** 0.14 / 0.15 E6：run.failed 结构化 envelope（additive）。 */
  error_code?: string;
  category?: string;
  phase?: string;
  retryable?: boolean;
  http_status?: number;
  details?: Record<string, unknown>;
}

/**
 * 工具公开信息（不含 handler）。
 *
 * 节点与成员是同一份清单、同一种条目：0.51 用户裁定不区分两者，所以这里没有
 * `source` / `surface` 之类第二层字段（成员身体上运行期注入的 `inbox` 只是同一份
 * 清单里的一条，待 inbox 插件化后归位到节点面）。
 */
export interface ToolInfo {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  has_permission_check: boolean;
}

// 0.2 team/transport 类型已迁移：
// - Transport/AgentMessage/PeerInfo 以 core R1 冻结为准；
// - gateway 边界见 ./team.ts；loopback 实现见 ./transport/；
// - task 语义（task/result/cancel）归 ext，web 不定义。

/** 构造协议错误载荷 */
export function protocolError(
  code: ProtocolErrorCode,
  message: string,
  details?: unknown,
): ProtocolError {
  return { code, message, ...(details !== undefined ? { details } : {}) };
}
