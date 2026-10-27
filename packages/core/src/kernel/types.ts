/**
 * 0.2 Kernel 契约（R1 类型冻结）
 *
 * 只依赖 9 接口的类型定义，不依赖任何模块实现。
 * Module ≠ Plugin：Kernel 是构造期边界；运行期扩展仍只走 PluginHost。
 *
 * @module @vessel-agent/core/kernel
 */

import type { EventHandler, EventStream, Unsubscribe } from '../types/event.js';
import type { PluginHost } from '../types/plugin.js';
import type { Message, Usage } from '../types/provider.js';
import type { RunInterruptReason, RunOptions } from '../types/run.js';

/** Agent 生命周期状态 */
export type AgentState = 'idle' | 'running' | 'cancelled' | 'error' | 'closed';

/** Run 生命周期状态 */
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

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

/** 成员句柄（agent 的唯一寻址单位） */
export interface AgentHandle {
  readonly id: string;
  readonly name?: string;
  status(): AgentStatus;
  /** 提交一次 run；同一成员在 R1 同时只允许一个运行中的 run */
  run(input: string | Message, opts?: RunOptions): Promise<RunHandle>;
  send(message: AgentMessage): Promise<void>;
  inbox(cursor?: string): Promise<InboxPage>;
  /**
   * 取消排队 / 运行中的 run。
   * `reason` 复用 0.13 的中断语义：`shutdown` / `timeout` → interrupted checkpoint，
   * `user`（或未传）→ cancelled；经 AbortSignal.reason 透传给成员 runtime。
   */
  cancel(runId?: string, reason?: RunInterruptReason): void;
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

/** 跨节点通用请求（0.6；method/params 的语义由上层定义，port 不解释） */
export interface TransportRequest {
  /** 调用方请求 id；缺省由实现生成，用于日志关联与重试去重 */
  requestId?: string;
  /** 方法名；port 保持开放字符串，不枚举 team/gateway 语义 */
  method: string;
  /** 方法参数；透传给远端，port 不校验 */
  params?: unknown;
}

/**
 * Transport port（R1 冻结；0.6 additive）。
 *
 * 0.2 约束见 DECISION-003 A3：只绑 loopback、消息带 protocol、失败只降级该传输。
 * 0.6 只做追加：`kind` 增加 `'remote'`，`nodeId` / `request` 可选；
 * `send` / `receive` / `peers` / `close` 签名不变。
 *
 * `send` 语义：对端受理即可 resolve（at-least-once）；跨节点实现必须按
 * `message.id` 去重，且不得依赖共享文件系统。
 */
export interface Transport {
  readonly kind: 'in-process' | 'loopback' | 'remote';
  /**
   * 本节点 id；0.5 的 InProcessTransport / LoopbackTransport 已提供。
   * port 层保持可选，避免破坏 0.5 的适配器与测试 fake。
   */
  readonly nodeId?: string;
  send(message: AgentMessage): Promise<void>;
  receive(handler: (message: AgentMessage) => void): Unsubscribe;
  peers(): Promise<PeerInfo[]>;
  /**
   * 面向指定节点的通用请求（可选能力）。只定义传输语义，method / params
   * 由 ext（team）或 asm（gateway）定义；不支持远程调用的实现可不提供。
   */
  request?<T>(nodeId: string, request: TransportRequest): Promise<T>;
  close(): Promise<void>;
}

/** 同机/远程节点公开信息（0.2 只做本机；0.6 允许远程节点） */
export interface PeerInfo {
  nodeId: string;
  endpoint?: string;
  agents: AgentStatus[];
  protocol: 1;
  /** 最近一次健康探测结果；仅在实现有能力提供时出现 */
  status?: 'healthy' | 'unreachable';
  /** 最近一次成功心跳/探测的 Unix 毫秒；缺省表示未知 */
  lastSeen?: number;
}

/** 聚合事件的过滤条件 */
export interface EventFilter {
  agentId?: string;
  runId?: string;
  /** 开放字符串前缀，例如 'agent.' */
  typePrefix?: string;
  /** 0.6：事件来源节点；显式设置时只匹配带相同 node_id 的事件 */
  nodeId?: string;
}

/** 聚合事件总线；仍实现 EventStream（9 接口不变） */
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
  /** 可选：从 durable checkpoint 恢复（AgentRuntime 已实现） */
  resume?(runId: string, opts?: RunOptions): Promise<string>;
  dispose(): void | Promise<void>;
}

/** Scheduler 提交项（R1 冻结；R2 实现队列/并发） */
export interface ScheduledTask {
  agent: AgentHandle;
  /**
   * 串行键（0.27 必填）：同一键同时最多一个 running。
   * 统一入口总是 body/session id，因此不同 body 可并发、同 body 串行。
   */
  serialKey: string;
  /** 成员默认 session；R2 用于 RunHandle.sessionId */
  sessionId?: string;
  /**
   * 0.14.1（additive）：固定 run id，用于保持 `RunHandle.id` 与 durable run 一致；
   * 缺省由 Scheduler 生成。重复 id 的 submit 会被拒绝。
   */
  runId?: string;
  input: string | Message;
  opts?: RunOptions;
  /** 预留：0.2 只做 FIFO，不实现优先级 */
  priority?: number;
  /**
   * 直接执行入口（收到 runId 后创建 RunHandle）。
   * 自定义 Scheduler 必须优先调用它，否则会和 `AgentHandle.run` 形成递归。
   */
  executor?: (runId: string) => Promise<RunHandle>;
}

export interface SchedulerOptions {
  /** 全局并发上限；缺省 Infinity（0.27：显式正整数才限制） */
  maxConcurrency?: number;
  /** 队列上限；默认 100 */
  maxQueueSize?: number;
  /** 同一 body/session 串行（默认 true）；不同 body 可并发 */
  perBodySerial?: boolean;
  /** 0.15 E4：队列事件发布流；缺省不发（只读观测，不改变调度） */
  events?: EventStream;
  /** 0.15 E4：事件 tenant 盖章；缺省不写 */
  tenantId?: string;
}

/**
 * 0.15 E3/E4：队列等待原因。
 * core 只产出 `capacity` / `per_body_serial`；其余取值预留给上层调度实现。
 */
export type WaitReason = 'capacity' | 'per_body_serial' | 'paused' | 'dependency' | 'quota';

export interface SchedulerStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

/** 一次 run 的只读摘要（0.14.1，纯 JSON，可安全序列化） */
export interface RunSnapshot {
  runId: string;
  agentId: string;
  sessionId: string;
  state: RunStatus;
  /** FIFO 队列位置（1 起；仅 queued 时有） */
  queuePosition?: number;
  /** 等待原因（仅 queued 时有；0.15 E3） */
  waitReason?: WaitReason;
  /** 入队时间（Unix ms） */
  queuedAt?: number;
  /** 开始执行时间（Unix ms；仅 running 时有） */
  startedAt?: number;
}

/** Scheduler 只读快照（0.14.1） */
export interface SchedulerSnapshot {
  asOf: number;
  queued: RunSnapshot[];
  running: RunSnapshot[];
  stats: SchedulerStats;
}

/** 调度器契约（F2：R1 只冻结类型；R2 实现完整队列） */
export interface Scheduler {
  submit(task: ScheduledTask): Promise<RunHandle>;
  cancel(runId: string, reason?: string): boolean;
  stats(): SchedulerStats;
  /** 可选：只读快照；自定义 Scheduler 可不实现（消费方按缺省处理） */
  snapshot?(): SchedulerSnapshot;
  close(): Promise<void>;
}
