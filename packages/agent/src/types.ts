/**
 * Agent 能力层契约（AgentService / registry / runtime port / snapshot）。
 *
 * 成员状态、可见性与 DTO 字段名是 0.17 的对外形状（snake_case），
 * 不要为内部方便改名；内部记录在 registry 里用 camelCase。
 *
 * @module @vessel-agent/agent
 */

import type { EventStream, Logger, Usage } from '@vessel-agent/core';

/** 成员状态（终态：completed / failed / cancelled / closed） */
export type MemberState =
  | 'created'
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'closed'
  | 'stale';

/** 成员可见性；private 仅 owner 可见 */
export type MemberVisibility = 'private' | 'team' | 'tenant';

/** 成员对外状态（E1 冻结形状） */
export interface MemberStatus {
  id: string;
  session_id: string;
  name?: string;
  parent_id?: string;
  owner: string;
  visibility: MemberVisibility;
  state: MemberState;
  current_tool?: string;
  last_seen?: number;
  usage?: Usage;
}

/** 成员间消息；队列只在内存，不落 snapshot */
export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  ts: number;
}

/** 传给执行内核的成员身份（不携带 registry 状态） */
export interface MemberRuntimeMember {
  id: string;
  session_id: string;
  name?: string;
  parent_id?: string;
  owner: string;
  visibility: MemberVisibility;
  model?: string;
  system_prompt?: string;
}

/** 一轮执行的结果 */
export interface MemberTurnResult {
  /** 本轮最终文本；成员未显式 reply 时由 AgentService 自动投递给父成员 */
  content?: string;
  outcome?: TurnOutcome;
  usage?: Usage;
}

/**
 * 执行内核适配口（A2/A3 提供实现）。
 *
 * runTurn 被 AgentService 调用，不得在内部吞掉取消；
 * 成员若调用 `reply`，本轮自动最终文本会被抑制。
 */
export interface MemberRuntimePort {
  spawn(member: MemberRuntimeMember): Promise<void>;
  runTurn(member: MemberRuntimeMember, message: AgentMessage): Promise<MemberTurnResult>;
  cancel(member: MemberRuntimeMember): Promise<void> | void;
  dispose(member: MemberRuntimeMember): Promise<void> | void;
}

/** 权限请求（传输由入口层实现；A1 只定义形状与状态等待） */
export interface PermissionRequestInput {
  requestId?: string;
  tool: string;
  input?: unknown;
}

/** 权限应答；桥梁缺席或异常时按 deny 处理 */
export interface PermissionDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}

/** bridge 模式下成员处于/离开权限等待的阶段（执行内核回调 AgentService 用） */
export type MemberPermissionState = 'waiting' | 'running';

/** 权限 bridge 端口；由 owner 入口实现（UI / 端点），A1 不实现传输 */
export interface PermissionBridge {
  request(
    member: MemberRuntimeMember,
    request: PermissionRequestInput,
  ): Promise<PermissionDecision>;
}

/** 成员创建参数 */
export interface NewMemberInput {
  name?: string;
  model?: string;
  systemPrompt?: string;
  visibility?: MemberVisibility;
  parentId?: string;
  owner?: string;
}

/** 批量创建（条目并行，逐条结果） */
export interface NewBatchInput {
  members: NewMemberInput[];
}

/**
 * 注册 root owner（REPL 主 agent）。不调用 runtime.spawn。
 * 重复 attach 幂等；stale 记录恢复为 idle。
 */
export interface AttachOwnerInput {
  id: string;
  /** 缺省与 id 相同 */
  sessionId?: string;
  visibility?: MemberVisibility;
}

/** 发送参数；`to` 可传成员 id 或 session id */
export interface SendInput {
  to: string;
  content: string;
  /** 发送者；缺省 DEFAULT_OWNER，private 成员只有 owner 能寻址 */
  from?: string;
}

/** 批量发送 */
export interface SendBatchInput {
  messages: SendInput[];
}

/** 关闭参数 */
export interface CloseInput {
  member?: string;
  to?: string;
}

/** 批量关闭（成员 id / session id） */
export interface CloseBatchInput {
  members: string[];
}

/** 列表过滤；viewer 用于 private 可见性判定 */
export interface ListFilter {
  viewer?: string;
  visibility?: MemberVisibility;
  state?: MemberState | readonly MemberState[];
  parentId?: string;
}

/** 发送结果：入队即返回，不等待一轮结束 */
export interface SendResult {
  queued: true;
  message_id: string;
  state: MemberState;
}

/** 成员回复父级的结果 */
export interface ReplyResult {
  queued: true;
  message_id: string;
  to: string;
}

/** 关闭结果；重复 close 幂等 */
export interface CloseResult {
  state: 'closed';
}

/** 批量逐条结果；成功条目放在 status */
export type BatchItemResult<T> = { ok: true; status: T } | { ok: false; error: string };

/** 批量结果（与输入顺序一致；单条失败不影响其它条目） */
export interface BatchResult<T> {
  results: BatchItemResult<T>[];
}

/** 快照写入选项 */
export interface AgentSnapshotOptions {
  enabled?: boolean;
  /** 合并写入窗口；缺省 0（下一轮事件循环） */
  throttleMs?: number;
  /** POSIX 权限；缺省 0o600 */
  mode?: number;
}

/** 一轮的结局；缺省 completed */
export type TurnOutcome = 'completed' | 'failed' | 'cancelled';

/** 成员事件（开放字符串；字段 snake_case） */
export interface AgentEvent {
  type: string;
  agent_id: string;
  session_id?: string;
  parent_id?: string;
  /** 成员可见性（/agents Self Card 用；spawned 等身份事件必带） */
  visibility?: MemberVisibility;
  /** 成员名（可选） */
  name?: string;
  /** 本轮 usage（turn.completed 有则带） */
  usage?: Usage;
  state?: MemberState;
  message_id?: string;
  /** 消息来源（queued 事件） */
  from?: string;
  tool?: string;
  outcome?: TurnOutcome;
  reason?: string;
  request_id?: string;
  decision?: 'allow' | 'deny';
  ts: number;
}

/** 事件监听器；抛错会被隔离，不影响服务行为 */
export type AgentEventListener = (event: AgentEvent) => void;

/** AgentService 构造参数 */
export interface AgentServiceOptions {
  /** 一个实例只服务一个 tenant */
  tenantId: string;
  /** 缺省不落盘（纯内存） */
  dataDir?: string;
  runtime: MemberRuntimePort;
  now?: () => number;
  /** 注入 id 生成器（session_id === member id） */
  newId?: () => string;
  logger?: Logger;
  snapshot?: AgentSnapshotOptions;
  permissionBridge?: PermissionBridge;
  /** 可选的进程内事件流出口；同时仍可 subscribe */
  events?: EventStream;
}

/** 稳定错误码（入口层据此映射 RPC / CLI 错误） */
export type AgentErrorCode =
  | 'invalid_input'
  | 'unknown_member'
  | 'member_closed'
  | 'member_stale'
  | 'member_not_visible'
  | 'no_parent'
  | 'spawn_failed'
  | 'invalid_state_transition';

/** AgentService 错误；code 稳定，message 供人读 */
export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}

/** Agent 能力层唯一契约 */
export interface AgentService {
  // 接口里裸写 `new(...)` 会被解析为构造签名，必须加引号
  'new'(input: NewMemberInput): Promise<MemberStatus>;
  'new'(input: NewBatchInput): Promise<BatchResult<MemberStatus>>;
  /** 注册 root owner；不 spawn，重复调用幂等 */
  attachOwner(input: AttachOwnerInput): Promise<MemberStatus>;
  send(input: SendInput): Promise<SendResult>;
  send(input: SendBatchInput): Promise<BatchResult<SendResult>>;
  close(input: CloseInput): Promise<CloseResult>;
  close(input: CloseBatchInput): Promise<BatchResult<CloseResult>>;
  list(filter?: ListFilter): Promise<MemberStatus[]>;
  /**
   * session 是否属于被 spawn 的成员；external owner 的 session 返回 false。
   * O(1) 直查，不受 visibility 过滤。
   */
  hasMember(sessionId: string): Promise<boolean>;
  /** 成员显式回复父级；本轮自动最终文本随后被抑制 */
  reply(memberId: string, content: string): Promise<ReplyResult>;
  /**
   * 取走成员待处理消息（REPL owner 用）；FIFO，不触发 runTurn，不重复投递。
   * limit 缺省取空队列。
   */
  takeMessages(memberId: string, limit?: number): Promise<AgentMessage[]>;
  /** 执行内核 bridge 上报的权限等待/恢复；只推进 waiting_permission ↔ running */
  notePermissionState(memberId: string, state: MemberPermissionState): void;
  /** 权限等待：waiting_permission ↔ running；无 bridge 时 deny */
  requestPermission(memberId: string, request: PermissionRequestInput): Promise<PermissionDecision>;
  /** 立即落盘待写快照（close 已自动等待；测试 / 收口用） */
  flushSnapshot(): Promise<void>;
  /** 订阅成员事件；返回取消函数 */
  subscribe(listener: AgentEventListener): () => void;
}

/** 缺省成员 owner / 发送者 */
export const DEFAULT_OWNER = 'main';

/** 单条消息上限（字节） */
export const MAX_MESSAGE_BYTES = 64 * 1024;
