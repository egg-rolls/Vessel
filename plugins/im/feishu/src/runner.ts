/**
 * per-chat 成员生命周期 + AgentService 执行面（Addendum B §11.3 / 0.27 统一 agent body）。
 *
 * - 成员经注入的 `AgentService` 创建（id 按 chat 派生；重复 id 视为 snapshot
 *   重载后的已存在成员，按 createOrRestoreOwner 的口径容忍）；
 * - 执行走 `service.admit`：`session_id = <prefix>:<chat_id>` 保证 per-chat Body
 *   与独立会话历史；渠道自身的 per-chat 串行由 channel.ts 的 PerChatQueues 保证，
 *   全局并发 / 同 body 串行由 tenant scheduler 统一裁决；
 * - `admit` 只返回排队信封；最终文本来自 `run.completed.data.output`。
 *   等待口径与 `src/connect-run-wait.ts` 一致（先订阅注入的 events 流再 admit，
 *   按 `run_id` 匹配终态），但插件不得 import `src/**`，因此在此复刻约 15 行语义；
 * - 成员 run.* 事件已由 service 的父事件流接线到达注入的 `events`，
 *   本类不再做任何事件转发；
 * - 达到 max_members 后新 chat 返回 MemberLimitError（渠道回 busy，不逐出）。
 */

import { AgentError, type AgentService } from '@vessel-agent/agent';
import type { EventStream, RunEvent } from '@vessel-agent/core';
import { fallbackAgentId, maskSecrets, sanitizeAgentId } from './config.js';
import type { ResolvedFeishuConfig } from './types.js';

export class MemberLimitError extends Error {
  constructor() {
    super('feishu member limit reached');
    this.name = 'MemberLimitError';
  }
}

/** run 终态事件集合（与 src/connect-run-wait.ts 同口径；插件不得 import src/**）。 */
const TERMINAL_RUN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 终态事件 → 最终文本；失败 / 取消抛带 code 的 Error（复刻 terminalResultOf）。 */
function terminalOutputOf(event: RunEvent): string {
  const data = isRecord(event.data) ? event.data : {};
  if (event.type === 'run.completed') {
    return typeof data.output === 'string' ? data.output : '';
  }
  const message =
    typeof data.error === 'string' && data.error.length > 0
      ? data.error
      : event.type === 'run.cancelled'
        ? 'Run cancelled'
        : 'Run failed';
  throw Object.assign(new Error(message), {
    code: typeof data.error_code === 'string' ? data.error_code : 'run_failed',
    run_id: event.run_id,
  });
}

/** abort 原因归一为 Error；渠道侧按 signal.aborted 静默处理。 */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string' && reason !== '') return new Error(reason);
  return new Error('Run cancelled');
}

export interface ChatMemberRunnerOptions {
  config: ResolvedFeishuConfig;
  /** 注入的事件流（与 service 的父事件流同源）；订阅 run.* 终态。 */
  events: EventStream;
  /** 0.27：注入的 AgentService；成员创建与 admit 执行面。 */
  service: AgentService;
  /** 取消在途 run（装配层接线）；缺省只放弃等待，不通知 service。 */
  cancelRun?: (runId: string, reason?: string) => boolean;
}

export class ChatMemberRunner {
  private readonly members = new Map<string, string>();
  private readonly pendingMembers = new Map<string, Promise<string>>();
  private readonly usedAgentIds = new Set<string>();
  private stopped = false;

  constructor(private readonly options: ChatMemberRunnerOptions) {}

  get memberCount(): number {
    return this.members.size;
  }

  /** 诊断/测试：in-flight 创建数；settle 后必须回到 0。 */
  get pendingMemberCount(): number {
    return this.pendingMembers.size;
  }

  /**
   * 确保 chat 有成员；达到上限返回 MemberLimitError。
   * 同一 chat 的并发调用合并到同一个创建 promise，避免重复创建。
   */
  async ensureMember(chatId: string): Promise<string> {
    if (this.stopped) throw new MemberLimitError();

    const existing = this.members.get(chatId);
    if (existing !== undefined) return existing;

    const pending = this.pendingMembers.get(chatId);
    if (pending !== undefined) return await pending;

    // 本地名额预检：pending 也占名额，避免并发下把压力全部打到 service。
    if (this.members.size + this.pendingMembers.size >= this.options.config.maxMembers) {
      throw new MemberLimitError();
    }

    const creation = this.createMember(chatId);
    this.pendingMembers.set(chatId, creation);
    try {
      return await creation;
    } finally {
      if (this.pendingMembers.get(chatId) === creation) {
        this.pendingMembers.delete(chatId);
      }
    }
  }

  /**
   * 执行一轮成员对话：ensure member → 先订阅终态 → admit → 等待该 run_id 的终态。
   * 输出来自 `run.completed.data.output`；失败抛带 code 的 Error。
   * abort 时调用注入的 cancelRun（如有）并以 signal 原因拒绝。
   */
  async run(chatId: string, text: string, signal: AbortSignal): Promise<string> {
    const agentId = await this.ensureMember(chatId);
    const sessionId = `${this.options.config.sessionPrefix}:${chatId}`;
    return await this.waitForOutput(agentId, sessionId, text, signal);
  }

  /**
   * 本地状态复位；service 及其成员记录归装配层所有（快照持久化），
   * 重启后同 chat 命中已存在成员并续接历史，因此这里不 close 成员。
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.pendingMembers.clear();
    this.members.clear();
    this.usedAgentIds.clear();
  }

  /** 诊断/测试：把错误文本中的凭据脱敏。 */
  sanitize(text: string): string {
    return maskSecrets(text, this.options.config.appId, this.options.config.appSecret);
  }

  /** 先订阅再 admit；admit 返回前到达的终态进缓冲，极快 run 不会漏。 */
  private async waitForOutput(
    agentId: string,
    sessionId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<string> {
    const { service, events, cancelRun } = this.options;

    const buffered: RunEvent[] = [];
    let onTerminal: ((event: RunEvent) => void) | undefined;
    const unsubscribe = events.subscribe((event) => {
      if (!TERMINAL_RUN_EVENT_TYPES.has(event.type)) return;
      if (onTerminal !== undefined) onTerminal(event);
      else buffered.push(event);
    });

    try {
      if (signal.aborted) throw abortError(signal);

      const admitted = await service.admit({
        agent_id: agentId,
        session_id: sessionId,
        content: text,
      });

      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          signal.removeEventListener('abort', onAbort);
        };
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };
        const settleFromEvent = (event: RunEvent): void => {
          settle(() => {
            try {
              resolve(terminalOutputOf(event));
            } catch (error) {
              reject(error);
            }
          });
        };
        onTerminal = (event: RunEvent): void => {
          if (event.run_id === admitted.run_id) settleFromEvent(event);
        };
        const onAbort = (): void => {
          settle(() => {
            const error = abortError(signal);
            if (cancelRun !== undefined) {
              try {
                cancelRun(admitted.run_id, error.message);
              } catch {
                // 取消失败不掩盖原始 abort 原因。
              }
            }
            reject(error);
          });
        };

        signal.addEventListener('abort', onAbort, { once: true });
        // admit 的 await 期间可能已 abort（addEventListener 不补发历史事件）：注册后再确认一次。
        if (signal.aborted) {
          onAbort();
          return;
        }

        // admit 返回前缓冲的终态（run 可能已完成）。
        for (const event of buffered.splice(0)) onTerminal(event);
      });
    } finally {
      unsubscribe();
    }
  }

  private async createMember(chatId: string): Promise<string> {
    const existing = this.members.get(chatId);
    if (existing !== undefined) return existing;

    const agentId = this.pickAgentId(chatId);
    // 先保留 id，避免并发创建时两个 chat 选中同一 id。
    this.usedAgentIds.add(agentId);

    try {
      await this.ensureAgent(agentId, chatId);
    } catch (error) {
      this.usedAgentIds.delete(agentId);
      throw error;
    }

    if (this.stopped) {
      this.usedAgentIds.delete(agentId);
      throw new MemberLimitError();
    }

    this.members.set(chatId, agentId);
    return agentId;
  }

  /**
   * 在注入的 service 上创建成员；重复 id 视为 snapshot 重载后的已存在成员
   * （口径同 src/agent-service-wiring.ts 的 createOrRestoreOwner，但不 import 它）：
   * 只吞 `duplicate member id` 这一种 invalid_input，其余原样抛出。
   */
  private async ensureAgent(agentId: string, chatId: string): Promise<void> {
    try {
      await this.options.service.create({
        id: agentId,
        role: 'single',
        name: `feishu:${chatId}`,
      });
    } catch (error) {
      const duplicate =
        error instanceof AgentError &&
        error.code === 'invalid_input' &&
        error.message === `duplicate member id: ${agentId}`;
      if (!duplicate) throw error;
      const existing = await this.options.service.identify(agentId);
      // 回读不到说明不是“已存在”的重复，而是别的问题：保留原始错误。
      if (existing === undefined) throw error;
    }
  }

  private pickAgentId(chatId: string): string {
    const primary = sanitizeAgentId(chatId);
    if (!this.usedAgentIds.has(primary)) return primary;
    const fallback = fallbackAgentId(chatId);
    if (!this.usedAgentIds.has(fallback)) return fallback;
    let index = 2;
    while (this.usedAgentIds.has(`${fallback}_${index}`)) index += 1;
    return `${fallback}_${index}`.slice(0, 64);
  }
}
