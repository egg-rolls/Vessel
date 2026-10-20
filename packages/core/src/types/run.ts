/**
 * Run 选项（F1：从 runtime 移到 types，Kernel 只依赖 port 类型）
 * @module @vessel/core/types
 */

import type { ContextManager } from './context.js';
import type { UsageStats } from './limits.js';
import type { Message } from './provider.js';

/**
 * 一次 run 的执行态（0.8 C1）。
 *
 * run 级状态（run id / session / branch / 计时 / usage）收敛在这里，
 * 由 `AgentRuntime` 在 run()/resume() 入口创建、`finally` 释放；
 * 调用方不应持有或修改它。
 */
export interface RunExecution {
  runId: string;
  sessionId: string;
  branch?: string;
  /** checkpoint 的 created_at（resume 时沿用原 run） */
  createdAt: number;
  /** 本次执行开始时间（duration_ms 基准；resume 会重置） */
  startedAt: number;
  stats: UsageStats;
  context: ContextManager;
}

/**
 * `AgentRuntime.interrupt()` 的中断原因（0.10 R2-18）。
 *
 * - `shutdown` / `timeout`：checkpoint 落 `interrupted`，可 `--resume-run`；
 * - `user`：按用户取消处理，checkpoint 落 `cancelled`。
 */
export type RunInterruptReason = 'shutdown' | 'timeout' | 'user';

/** Run 选项 */
export interface RunOptions {
  /**
   * @internal 仅供 Kernel/Host 使用：指定本次 run 的 run_id，
   * 使 `RunHandle.id` 与事件流里的 `run_id` 一致（F6）。
   * 普通调用方不要设置；缺省由 AgentRuntime 生成。
   */
  runId?: string;
  /** AbortSignal——设置后可在外部中断 run()（Hermes/Claude Code 模式） */
  signal?: AbortSignal;
  /** 当前 git branch——app 层采集，core 透传存入 RunState.branch */
  branch?: string;
  /**
   * 本轮请求前置注入的消息。core 不解释其来源与语义——
   * skill 内容、附件、引用文件、项目约定，任何要进语言空间的文本都走这里。
   * 写入顺序：注入消息在前，用户输入在后；两者都持久化进 ContextManager。
   */
  messages?: Message[];
}
