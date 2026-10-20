/**
 * @vessel/core/kernel 模块（0.2 R1）
 * @module @vessel/core/kernel
 */

export { createCancellationScope } from './cancellation.js';
export { createRuntime } from './create-runtime.js';
export { MemoryEventBus } from './event-bus.js';
export { InProcessRuntimeHost, type InProcessRuntimeHostOptions } from './runtime-host.js';
export { InProcessScheduler, SerialScheduler } from './scheduler.js';
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
  TransportRequest,
} from './types.js';
