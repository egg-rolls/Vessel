/**
 * Kernel 内部符号与内部接口（不从公开 index 导出）。
 *
 * 用途：AgentHandle 与 Scheduler 之间的直接执行 / 取消通道，
 * 避免 `Scheduler.submit → AgentHandle.run → Scheduler.submit` 递归。
 *
 * @module @vessel-agent/core/kernel
 */

import type { Message } from '../types/provider.js';
import type { RunOptions } from '../types/run.js';
import type { AgentHandle, RunHandle, Scheduler } from './types.js';

/** AgentHandle 的直执行入口（实现方按需提供） */
export const kExecuteAgentRun = Symbol('vessel.kernel.executeAgentRun');

/** AgentHandle 的额外执行能力（sessionId 由 ScheduledTask 透传，F9） */
export interface InternalAgentHandle extends AgentHandle {
  [kExecuteAgentRun](
    input: string | Message,
    opts?: RunOptions,
    sessionId?: string,
  ): Promise<RunHandle>;
}

/** Scheduler 的按成员取消入口 */
export const kCancelAgentRuns = Symbol('vessel.kernel.cancelAgentRuns');

/** 支持按成员取消的 Scheduler（内置实现） */
export interface InternalScheduler extends Scheduler {
  [kCancelAgentRuns](agentId: string, reason?: string): number;
}
