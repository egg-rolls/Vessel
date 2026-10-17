/**
 * 0.2 Kernel 契约（R1 类型冻结）
 *
 * 只依赖 9 接口的类型定义，不依赖任何模块实现。
 * Module ≠ Plugin：Kernel 是构造期边界；运行期扩展仍只走 PluginHost。
 *
 * @module @vessel/core/kernel
 */

import type { ContextManager } from '../types/context.js';
import type { EventHandler, EventStream, Unsubscribe } from '../types/event.js';
import type { TerminationPolicy, UsageLimits } from '../types/limits.js';
import type { PluginHost, RuntimePermissionConfig } from '../types/plugin.js';
import type { LLMProvider, Message, Usage } from '../types/provider.js';
import type { RunOptions } from '../types/run.js';
import type { SessionBackend } from '../types/session.js';

/** Agent 生命周期状态 */
export type AgentState = 'idle' | 'running' | 'cancelled' | 'error' | 'closed';

/** Run 生命周期状态 */
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Host 接受的成员规格。
 * `provider` / `model` 必填；其余可缺省，由 Host 的默认值或调用方注入。
 */
export interface AgentSpec {
  /**
   * 成员 id；缺省生成 UUID。
   * 必须匹配 `[A-Za-z0-9_-]{1,64}`（A11）；不含 ':'（地址分隔符）与 '/'（session 命名空间）。
   */
  id?: string;
  name?: string;
  provider: LLMProvider;
  model: string;
  /** 成员能力集；缺省用 Host 注入的 pluginHost */
  pluginHost?: PluginHost;
  systemPrompt?: string;
  /** 成员独占上下文；缺省由 contextFactory 创建 */
  context?: ContextManager;
  /** 成员专用 session 后端；缺省用 Host 共享后端并按 agentId 命名空间隔离 */
  session?: SessionBackend;
  /** 成员默认 session id；缺省 'default'（位于该成员的命名空间内） */
  sessionId?: string;
  /** run / agent / host 三级限额；0.2 R1 先使用 run（agent 同源） */
  limits?: Limits;
  termination?: TerminationPolicy;
  permission?: RuntimePermissionConfig;
  metadata?: Record<string, unknown>;
}

/** 限额作用域（F3）；0.2 R1 只消费 run，agent/host 由 R2 接 */
export interface Limits {
  run?: UsageLimits;
  agent?: UsageLimits;
  host?: UsageLimits;
  termination?: TerminationPolicy;
}

/** 成员状态视图（可序列化，不含 runtime 内部对象） */
export interface AgentStatus {
  /** 必须匹配 `[A-Za-z0-9_-]{1,64}`（A11） */
  id: string;
  name?: string;
  state: AgentState;
  currentRunId?: string;
  toolNames: string[];
  lastError?: string;
}

/**
 * 成员消息。core 内部字段一律 camelCase（A7）；
 * gateway 在边界处映射为 snake_case，core 不做映射。
 *
 * 地址（A12）：canonical 形式是 `nodeId:agentId`；本机可省略 nodeId（只写 agentId）；
 * `*` 仅本机广播。**core 不解析地址**，跨节点路由由 ext / R3 传输层负责。
 */
export interface AgentMessage {
  id: string;
  /** 发送方地址（canonical `nodeId:agentId` 或本机 agentId）；core 不解析 */
  from: string;
  /** 目标地址（canonical `nodeId:agentId` 或本机 agentId）；'*' 仅本机广播；core 不解析 */
  to: string;
  /** 开放字符串（不枚举 team 语义）；ext 声明 message/task/result/cancel */
  kind: string;
  content: string;
  replyTo?: string;
  ts: number;
}

/** 收件箱分页 */
export interface InboxPage {
  messages: AgentMessage[];
  /** 不透明游标；调用方原样回传，不要解析其格式 */
  cursor: string;
}

/**
 * 一次 run 的句柄。
 * A1：`status` 是方法而不是只读字段，queued→running→completed 可被观测。
 */
export interface RunHandle {
  /** 复用 core run id（事件流里同一个 run_id） */
  readonly id: string;
  readonly agentId: string;
  readonly sessionId: string;
  status(): RunStatus;
  /** 最终文本；失败或取消时 reject */
  readonly result: Promise<string>;
  /** 本次 run 的用量；未完成或 Provider 未返回时为 undefined（A9） */
  usage(): Usage | undefined;
  cancel(reason?: string): void;
}

/** 成员句柄（Host 的唯一寻址单位） */
export interface AgentHandle {
  readonly id: string;
  readonly name?: string;
  status(): AgentStatus;
  /** 提交一次 run；同一成员在 R1 同时只允许一个运行中的 run */
  run(input: string | Message, opts?: RunOptions): Promise<RunHandle>;
  send(message: AgentMessage): Promise<void>;
  inbox(cursor?: string): Promise<InboxPage>;
  cancel(runId?: string): void;
  close(): Promise<void>;
}

/** 取消原语（A2：child 随父取消自动中止） */
export interface Cancellation {
  readonly signal: AbortSignal;
  readonly cancelled: boolean;
  cancel(reason?: string): void;
}

export interface CancellationScope extends Cancellation {
  /** 子作用域：父取消时自动中止；子取消不影响父 */
  child(): CancellationScope;
}

/**
 * Transport port（R1 冻结；R3 实现）。
 * 0.2 约束见 DECISION-003 A3：只绑 loopback、消息带 protocol、失败只降级该传输。
 */
export interface Transport {
  readonly kind: 'in-process' | 'loopback';
  send(message: AgentMessage): Promise<void>;
  receive(handler: (message: AgentMessage) => void): Unsubscribe;
  peers(): Promise<PeerInfo[]>;
  close(): Promise<void>;
}

/** 同机/远程节点公开信息（0.2 只做本机） */
export interface PeerInfo {
  nodeId: string;
  endpoint?: string;
  agents: AgentStatus[];
  protocol: 1;
}

/** Host 聚合事件的过滤条件 */
export interface EventFilter {
  agentId?: string;
  runId?: string;
  /** 开放字符串前缀，例如 'agent.' */
  typePrefix?: string;
}

/** Host 级事件总线；仍实现 EventStream（9 接口不变） */
export interface EventBus extends EventStream {
  subscribeFiltered(handler: EventHandler, filter?: EventFilter): Unsubscribe;
}

/**
 * 可运行 agent 的最小结构类型（A10）。
 * `AgentRuntime` 已结构满足；asm 的 owner facade 实现它，tui/web 消费它，
 * 禁止 `as unknown as AgentRuntime`。
 */
export interface RunnableAgent {
  readonly events: EventStream;
  readonly pluginHost: PluginHost;
  run(input: string | Message, sessionId?: string, opts?: RunOptions): Promise<string>;
  dispose(): void;
}

/** Scheduler 提交项（R1 冻结；R2 实现队列/并发） */
export interface ScheduledTask {
  agent: AgentHandle;
  /** 成员默认 session；R2 用于 RunHandle.sessionId */
  sessionId?: string;
  input: string | Message;
  opts?: RunOptions;
  /** 预留：0.2 只做 FIFO，不实现优先级 */
  priority?: number;
  /**
   * @internal Host 使用：直接执行入口（收到 runId 后创建 RunHandle）。
   * 自定义 Scheduler 必须优先调用它，否则会和 `AgentHandle.run` 形成递归。
   */
  executor?: (runId: string) => Promise<RunHandle>;
}

export interface SchedulerOptions {
  /** 全局并发上限；默认 1（0.2 保守） */
  maxConcurrency?: number;
  /** 队列上限；默认 100 */
  maxQueueSize?: number;
  /** 同一成员串行（默认 true） */
  perAgentSerial?: boolean;
}

export interface SchedulerStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

/** 调度器契约（F2：R1 只冻结类型；R2 实现完整队列） */
export interface Scheduler {
  submit(task: ScheduledTask): Promise<RunHandle>;
  cancel(runId: string, reason?: string): boolean;
  stats(): SchedulerStats;
  close(): Promise<void>;
}

/** 多 agent 宿主 */
export interface RuntimeHost {
  readonly events: EventBus;
  /** Scheduler 在 R1 为受限实现（串行/并发拒绝），R2 替换 */
  readonly scheduler: Scheduler;
  spawn(spec: AgentSpec): Promise<AgentHandle>;
  get(id: string): AgentHandle | undefined;
  list(): AgentStatus[];
  send(message: AgentMessage): Promise<void>;
  /**
   * 读取任意 mailbox（含非成员）。`send` 到非成员地址时按需创建邮箱（F4/Q2）；
   * 未知且从未投递的 id 返回空页。
   */
  inbox(id: string, cursor?: string): Promise<InboxPage>;
  /** 生命周期便捷入口；委托给 AgentHandle.cancel */
  cancel(id: string, runId?: string): void;
  close(): Promise<void>;
}

/**
 * SDK 组合选项（F3：冻结 `limits` 形状；具体 createRuntime 在 R2/R6 落地）。
 * asm 的 owner facade / 装配层消费此类型。
 */
export interface RuntimeOptions {
  defaults?: Partial<AgentSpec>;
  pluginHost?: PluginHost;
  contextFactory?: () => ContextManager;
  session?: SessionBackend;
  permission?: RuntimePermissionConfig;
  scheduler?: SchedulerOptions;
  limits?: Limits;
  events?: EventBus;
  /** R3 接；R1 只冻结类型，不实现 */
  transport?: Transport;
}
