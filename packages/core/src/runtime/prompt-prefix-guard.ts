/**
 * 提示词前缀不可变守卫（CONTRACT-prefix-invariant §4）。
 *
 * 每个 session 保存上一次请求的 system / tools / messages 快照；下一次请求的
 * 消息序列必须以上一次为前缀（逐条 JSON 字节相等）。system / tools 变化不算
 * 消息重写，但同样要可见。带 `reason` 的显式失效（compaction / resume / ...）
 * 直接放行；无 reason 时发 `prompt.prefix_changed`，`VESSEL_STRICT_PREFIX=1`
 * 时抛 `PromptPrefixChangedError`（生产默认只告警）。
 *
 * @module @vessel-agent/core/runtime
 */

import type { EventStream } from '../types/event.js';
import type { Message } from '../types/provider.js';

/** 允许一次显式前缀失效的原因 */
export type PrefixChangeReason =
  | 'compaction'
  | 'system_revision'
  | 'tools_changed'
  | 'model_changed'
  | 'session_switch'
  | 'branch'
  | 'resume'
  | 'context_trim';

/** 一次守卫检查的输入 */
export interface PromptPrefixCheckInput {
  sessionId: string;
  /** 本次请求实际发送的 system（无则为空串） */
  system: string;
  /** 工具 schema 的稳定 JSON 序列化 */
  tools: string;
  messages: readonly Message[];
  /** 显式失效原因；缺省表示必须保持前缀 */
  reason?: PrefixChangeReason;
  /** 事件归属的 run（缺省用 sessionId） */
  runId?: string;
}

/** 一次守卫检查的结果 */
export interface PromptPrefixCheckResult {
  /** 消息前缀是否仍然成立（带 reason 的显式失效视为成立） */
  ok: boolean;
  /** 消息序列首次分叉的下标（删除尾部时为新的长度） */
  divergedAt?: number;
  systemChanged: boolean;
  toolsChanged: boolean;
}

interface PromptSnapshot {
  system: string;
  tools: string;
  /** 逐条序列化后的消息，用字符串比较避免对象引用差异 */
  messages: readonly string[];
}

/** 严格模式下检测到未声明的前缀变化 */
export class PromptPrefixChangedError extends Error {
  readonly sessionId: string;
  readonly divergedAt?: number;

  constructor(sessionId: string, divergedAt?: number) {
    super(
      `prompt prefix changed for session ${sessionId}` +
        (divergedAt !== undefined ? ` at message ${divergedAt}` : ''),
    );
    this.name = 'PromptPrefixChangedError';
    this.sessionId = sessionId;
    if (divergedAt !== undefined) this.divergedAt = divergedAt;
  }
}

function serializeMessage(message: Message): string {
  return JSON.stringify(message);
}

export class PromptPrefixGuard {
  private readonly snapshots = new Map<string, PromptSnapshot>();

  constructor(
    private readonly events?: EventStream,
    private readonly tenantId?: string,
  ) {}

  check(input: PromptPrefixCheckInput): PromptPrefixCheckResult {
    const previous = this.snapshots.get(input.sessionId);
    const serialized = input.messages.map(serializeMessage);

    // 每个 session 的第一份快照：没有可比较的历史。
    if (!previous) {
      this.snapshots.set(input.sessionId, {
        system: input.system,
        tools: input.tools,
        messages: serialized,
      });
      return { ok: true, systemChanged: false, toolsChanged: false };
    }

    let divergedAt: number | undefined;
    const shared = Math.min(previous.messages.length, serialized.length);
    for (let i = 0; i < shared; i += 1) {
      if (previous.messages[i] !== serialized[i]) {
        divergedAt = i;
        break;
      }
    }
    // 新序列是旧序列的前缀但更短：尾部被删除，同样算分叉。
    if (divergedAt === undefined && serialized.length < previous.messages.length) {
      divergedAt = serialized.length;
    }

    const systemChanged = previous.system !== input.system;
    const toolsChanged = previous.tools !== input.tools;
    const messagesChanged = divergedAt !== undefined;

    // 快照在检查后立即更新：同一次显式失效不会被后续请求重复报告。
    this.snapshots.set(input.sessionId, {
      system: input.system,
      tools: input.tools,
      messages: serialized,
    });

    if (!messagesChanged && !systemChanged && !toolsChanged) {
      return { ok: true, systemChanged, toolsChanged };
    }

    if (input.reason !== undefined) {
      return {
        ok: true,
        ...(divergedAt !== undefined ? { divergedAt } : {}),
        systemChanged,
        toolsChanged,
      };
    }

    this.publishChange(input, divergedAt, systemChanged, toolsChanged);

    if (process.env.VESSEL_STRICT_PREFIX === '1') {
      throw new PromptPrefixChangedError(input.sessionId, divergedAt);
    }

    return {
      ok: !messagesChanged,
      ...(divergedAt !== undefined ? { divergedAt } : {}),
      systemChanged,
      toolsChanged,
    };
  }

  private publishChange(
    input: PromptPrefixCheckInput,
    divergedAt: number | undefined,
    systemChanged: boolean,
    toolsChanged: boolean,
  ): void {
    if (!this.events) return;
    const runId = input.runId ?? input.sessionId;
    this.events.publish({
      type: 'prompt.prefix_changed',
      run_id: runId,
      data: {
        session_id: input.sessionId,
        ...(divergedAt !== undefined ? { diverged_at: divergedAt } : {}),
        system_changed: systemChanged,
        tools_changed: toolsChanged,
      },
      ts: Date.now(),
      ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
    });
  }
}
