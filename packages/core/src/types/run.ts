/**
 * Run 选项（F1：从 runtime 移到 types，Kernel 只依赖 port 类型）
 * @module @vessel-agent/core/types
 */

import type { WorkingContext } from './context.js';
import type { ErrorPhase } from './error.js';
import type { UsageStats } from './limits.js';
import type { Message } from './provider.js';
import type { RunRecord } from './run-record-store.js';

/**
 * 一次 run 的瞬时执行态（0.8 C1）。
 *
 * run 级状态（run id / session / branch / 计时 / usage）收敛在这里，
 * 由 `ExecutionUnit` 在 run()/resume() 入口创建、`finally` 释放；
 * 调用方不应持有或修改它。可恢复的进度在 `record`（RunRecord）里。
 */
export interface Run {
  runId: string;
  sessionId: string;
  branch?: string;
  /** RunRecord 的 created_at（resume 时沿用原 run） */
  createdAt: number;
  /** 本次执行开始时间（duration_ms 基准；resume 会重置） */
  startedAt: number;
  stats: UsageStats;
  /** 本次 run 的上下文窗口（per Run；从 SessionEventLog 重建，不落库） */
  workingContext: WorkingContext;
  /**
   * 当前执行阶段（0.14 P0，内部使用）：失败时供 `toErrorEnvelope` 标注 `phase`。
   * 调用方不应依赖该字段的实时性。
   */
  phase?: ErrorPhase;
  /**
   * 0.18：本次 LLM 请求已流出的正文（内部使用）。
   * run 中断/失败时写入终态事件的 `partial_content`；成功时忽略。
   */
  partialContent?: string;
  /**
   * @internal 流式段落聚合状态（`llm.stream.summary` 的唯一来源）。
   *
   * 只由 `ExecutionUnit` 在 `on_chunk` 里维护，段结束即清空 `open`；run 结束随
   * `Run` 释放。它**只存计数，不存正文**，也不参与 messages 重建 —— 删掉它只会
   * 让日志少一份骨架，不影响任何状态。
   */
  streamSegment?: StreamSegmentState;
  /** 本 run 的持久记录引用（可恢复进度；不新增持久字段） */
  record: RunRecord;
}

/**
 * 一个打开中的流式段落：只有计数与时刻，**没有任何文本缓冲**。
 */
export interface OpenStreamSegment {
  kind: 'text' | 'reasoning';
  /** 该段已收到的同 kind 增量条数 */
  chunkCount: number;
  /** 该段增量 UTF-8 字节数 */
  bytes: number;
  /** 该段首个 / 末个增量的 run 内流式序号（1 起） */
  firstSeq: number;
  lastSeq: number;
  startedAt: number;
  endedAt: number;
  /** 本次请求发出 → 该段首个增量的毫秒数（只在该次请求的首段上有值） */
  ttftMs?: number;
}

/**
 * 流式段落聚合状态（`Run.streamSegment`，0.51）。
 *
 * 存在理由：`llm.stream.chunk` 不落盘（体量），落盘日志因此看不到「流式结构」。
 * 这里只维护**计数**，段结束时经 `RunJournal` 落一条 `llm.stream.summary`。
 * 状态机与 `apps/web/src/state/events.ts` 的 text/reasoning 分段同源：
 * kind 切换 / `finish` / 请求结束收口，`tool_call_delta` 不断段。
 */
export interface StreamSegmentState {
  /** 下一个 chunk 的 run 内流式序号（1 起；`finish` / `tool_call_delta` 同样占号） */
  nextSeq: number;
  /** 已发出的摘要条数 = 下一个 `segment_index` */
  nextSegmentIndex: number;
  /**
   * 本次请求发出时刻：下一次「打开新段」时算出 `ttft_ms` 后清空。
   * 请求入口写入，保证 ttft 只属于本次请求的首个增量。
   */
  pendingTtftBase?: number;
  /** 当前打开的段；`undefined` = 没有打开中的段 */
  open?: OpenStreamSegment;
}

/**
 * `ExecutionUnit.interrupt()` 的中断原因（0.10 R2-18）。
 *
 * - `shutdown` / `timeout`：RunRecord 落 `interrupted`，可 `--resume-run`；
 * - `user`：按用户取消处理，RunRecord 落 `cancelled`。
 */
export type RunInterruptReason = 'shutdown' | 'timeout' | 'user' | 'interrupt';

/** Run 选项 */
export interface RunOptions {
  /**
   * @internal 仅供 Kernel/Host 使用：指定本次 run 的 run_id，
   * 使 `RunHandle.id` 与事件流里的 `run_id` 一致（F6）。
   * 普通调用方不要设置；缺省由 ExecutionUnit 生成。
   */
  runId?: string;
  /**
   * per-run session（0.14.1，additive）：多 agent Host 的 `AgentHandle.run` 用它
   * 覆盖成员默认 session；`ScheduledTask.sessionId` 仍可被自定义 Scheduler 改写。
   * 单 agent `ExecutionUnit.run(input, sessionId, opts)` 继续以显式参数为准，
   * 不消费该字段（避免双来源）。
   */
  sessionId?: string;
  /**
   * 0.28（D10）：本次投给哪个 agent。
   *
   * `RunnableAgent.run()` 只带 session 时，走 `admit` 的入口只能「只传 session_id」，
   * 那会让未绑定的 session 落到 `main` 上长出第二具 body（CONTRACT-0.28 §3 禁止）。
   * 装配层用它把「这一次投给哪个 agent」表达出来；core 不解释语义，只透传给适配器。
   * 未给出时保持既有行为（`/resume` 等按 session 的路径不受影响）。
   */
  agentId?: string;
  /** AbortSignal——设置后可在外部中断 run()（Hermes/Claude Code 模式） */
  signal?: AbortSignal;
  /** 当前 git branch——app 层采集，core 透传存入 RunRecord.branch */
  branch?: string;
  /**
   * 本轮请求前置注入的消息。core 不解释其来源与语义——
   * skill 内容、附件、引用文件、项目约定，任何要进语言空间的文本都走这里。
   * 写入顺序：注入消息在前，用户输入在后；两者都持久化进 WorkingContext。
   */
  messages?: Message[];
}
