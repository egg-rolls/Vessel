/**
 * Gateway 协议 v1（vessel.gateway/1）
 *
 * 0.1.0 只实现单节点控制面：事件、运行、会话、工具、权限、静态托管。
 * `/v1/team/*` 与任务协议是 0.2 草案，仅保留类型定义，不在 0.1.0 提供服务端实现。
 *
 * @module @vessel/serve/protocol
 */

import type { RunEvent } from '@vessel/core';

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
  name?: string;
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
  // 0.4 workflow / metrics / feishu / evals（DECISION-009 §5.7 / §10.3）
  | 'metrics_disabled'
  | 'workflow_disabled'
  | 'workflow_not_found'
  | 'workflow_invalid'
  | 'workflow_already_running'
  | 'workflow_not_resumable'
  | 'channel_disabled'
  | 'eval_not_found'
  // 0.5 RPC / 多租户（DECISION-010 A-3 §10.2）
  | 'forbidden'
  | 'invalid_params'
  | 'tenant_locked'
  | 'quota_exceeded'
  | 'conflict';

export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;
  retryable?: boolean;
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
      /** 本次回放的第一条 seq；无事件时为 0 */
      from_seq: number;
      /** 服务端当前最新 seq；无事件时为 0 */
      latest_seq: number;
      /** 0.5：token 解析出的目标 tenant（additive） */
      tenant_id?: string;
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
  | { v?: 1; kind: 'auth'; token: string; role?: 'console'; since?: number }
  | { v?: 1; kind: 'req'; id: string; method: string; params?: unknown }
  | { v?: 1; kind: 'pong' };

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
}

/** 工具公开信息（不含 handler） */
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
export function protocolError(code: ProtocolErrorCode, message: string): ProtocolError {
  return { code, message };
}
