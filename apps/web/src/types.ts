/**
 * 前端协议类型（vessel.gateway/1 的最小契约）。
 *
 * 与 packages/serve/src/protocol.ts 对齐，但不 import 服务端源码——
 * 前端独立构建，避免把 Bun/Node 类型带进来。
 */

/** Run 事件（type 为开放字符串协议） */
export interface RunEvent {
  type: string;
  run_id: string;
  data: Record<string, unknown>;
  ts: number;
}

/** LLM 流式 chunk（对应 core 的 StreamChunk） */
export interface StreamChunk {
  type: 'text_delta' | 'tool_call_delta' | 'finish';
  delta?: string;
  tool_call_index?: number;
  tool_call_id?: string;
  tool_call_name?: string;
  arguments_delta?: string;
  finish_reason?: string;
  usage?: Usage;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  total_cost?: number;
}

/** LLM 工具 Schema（对应 `llm.request.data.tools`） */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** 会话摘要（/v1/sessions 返回的 SessionInfo） */
export interface SessionInfo {
  session_id: string;
  title: string;
  preview: string;
  status: string;
  started_at: number;
  updated_at: number;
  message_count: number;
  branch?: string;
}

/** 工具公开信息（/v1/tools） */
export interface ToolInfo {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  has_permission_check: boolean;
}

/** ask_user 单个问题 */
export interface AskUserQuestion {
  header: string;
  question: string;
  options?: string[];
  multi_select?: boolean;
}

/** ask_user 单个回答 */
export interface AskUserAnswer {
  header: string;
  question: string;
  answer: string;
}

/** ask_user 请求（ask.user.requested） */
export interface AskUserRequest {
  requestId: string;
  questions: AskUserQuestion[];
  runId: string;
  expiresAt: number;
}

/** 运行状态（/v1/runs/:id、run.get） */
export interface RunStatus {
  run_id: string;
  core_run_id?: string;
  session_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  output?: string;
  error?: string;
  usage?: Usage;
  started_at?: number;
  completed_at?: number;
  queue_position?: number;
}

/** 协议信息 */
export interface ProtocolInfo {
  name: 'vessel.gateway';
  version: number;
  min: number;
  features: string[];
}

/** 节点公开信息 */
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
    max_concurrency: number;
    protocol: number;
  };
}

/** hello 帧 */
export interface HelloInfo {
  protocol: ProtocolInfo;
  node: NodeInfo;
  from_seq: number;
  latest_seq: number;
}

/** gap 帧 */
export interface GapFrame {
  kind: 'gap';
  from_seq: number;
  to_seq: number;
}

/** 服务端帧（前端只消费用到的字段） */
export type ServerFrame =
  | ({ v: 1; kind: 'hello'; node_id: string; ts: number } & HelloInfo)
  | {
      v: 1;
      kind: 'event';
      node_id: string;
      ts: number;
      seq: number;
      job_id?: string;
      event: RunEvent;
    }
  | ({ v: 1; kind: 'gap'; node_id: string; ts: number } & Omit<GapFrame, 'kind'>)
  | { v: 1; kind: 'res'; node_id: string; ts: number; id: string; ok: true; result: unknown }
  | {
      v: 1;
      kind: 'res';
      node_id: string;
      ts: number;
      id: string;
      ok: false;
      error: { code: string; message: string };
    }
  | { v: 1; kind: 'ping'; node_id: string; ts: number };
