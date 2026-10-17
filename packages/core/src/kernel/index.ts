/**
 * @vessel/core/kernel 模块（0.2 R1）
 * @module @vessel/core/kernel
 *
 * 类型冻结阶段只导出契约；实现（InProcessRuntimeHost / Scheduler 等）
 * 在 host implementation 提交中追加。
 */

export type {
  AgentHandle,
  AgentMessage,
  AgentSpec,
  AgentState,
  AgentStatus,
  Cancellation,
  CancellationScope,
  EventBus,
  EventFilter,
  InboxPage,
  Limits,
  PeerInfo,
  RunHandle,
  RunnableAgent,
  RunStatus,
  RuntimeHost,
  RuntimeOptions,
  ScheduledTask,
  Scheduler,
  SchedulerOptions,
  SchedulerStats,
  Transport,
} from './types.js';
