/**
 * per-chat 成员生命周期 + AgentService 执行面（Addendum B §11.3 / 0.27 统一 agent body）。
 *
 * - 成员经注入的 `AgentService` 创建（id 按 chat 派生；重复 id 视为 snapshot
 *   重载后的已存在成员，按 createOrRestoreOwner 的口径容忍）；
 * - 执行走 `service.admit`，**只给 `agent_id`**：一个 agent 恰好一具 Body
 *   （CONTRACT §1），per-chat 的隔离由「每个 chat 一个 agent」保证，不再需要旧的
 *   `session_id = <prefix>:<chat_id>` 合成 session。渠道自身的 per-chat 串行由
 *   channel.ts 的 PerChatQueues 保证，全局并发 / 同 body 串行由 tenant scheduler 裁决；
 * - `admit` 只返回排队信封；最终文本来自 `run.completed.data.output`。
 *   等待口径与 `src/connect-run-wait.ts` 一致（先订阅注入的 events 流再 admit，
 *   按 `run_id` 匹配终态），但插件不得 import `src/**`，因此在此复刻约 15 行语义；
 * - 成员 run.* 事件已由 service 的父事件流接线到达注入的 `events`，
 *   本类不再做任何事件转发；
 * - 成员被 TTL 回收后，下一条消息先 `reinstate` 原地复活再 admit（CONTRACT §4.2）；
 *   Team 由装配层注入 `resolveTeamId`，缺省时保持旧的 `member_closed` 行为；
 * - 达到 max_members 后新 chat 返回 MemberLimitError（渠道回 busy，不逐出）。
 */

import { type AdmitResult, AgentError, type AgentService } from '@vessel-agent/agent';
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

/** 成员被回收（TTL sweep / 显式 close）后 admit 抛出的唯一错误码。 */
function isMemberClosed(error: unknown): boolean {
  if (error instanceof AgentError) return error.code === 'member_closed';
  // 插件与装配层可能各持一份 `@vessel-agent/agent`（node 链接 / 测试双实例）：
  // 结构判据兜底，避免因 instanceof 失配把可复活路径当成未知错误。
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'member_closed'
  );
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
  /**
   * 0.28 F2：成员被 TTL 回收后复活所需的 Team id（CONTRACT §4.2）。
   * `reinstate` 的 `team_id` 是必填，渠道自己不知道 workspace，只能由装配层
   * 提供（默认 workspace 对应的 Team）；缺省时不复活，`member_closed` 原样抛出。
   */
  resolveTeamId?: () => string | undefined;
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
    return await this.waitForOutput(agentId, text, signal);
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
  private async waitForOutput(agentId: string, text: string, signal: AbortSignal): Promise<string> {
    const { events, cancelRun } = this.options;

    const buffered: RunEvent[] = [];
    let onTerminal: ((event: RunEvent) => void) | undefined;
    const unsubscribe = events.subscribe((event) => {
      if (!TERMINAL_RUN_EVENT_TYPES.has(event.type)) return;
      if (onTerminal !== undefined) onTerminal(event);
      else buffered.push(event);
    });

    try {
      if (signal.aborted) throw abortError(signal);

      // 只给 `agent_id`：`admit` 会解析到该 agent 的唯一 live Body。带 `from` 缺省
      // 是 `human`（消息发送者是人类，不是成员归属的默认 owner）。
      const admitted = await this.admitWithRevival(agentId, text);

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

  /**
   * 投递；成员已被 TTL 回收时先 `reinstate` 原地复活再重试一次（CONTRACT §4.2）。
   *
   * 只在 `admit` 报 `member_closed` 时触发：该错误在入队前抛出，重试不会留下
   * 半条消息。复活是幂等原语（present 成员直接返回现状），但这里只在 closed
   * 时调用，避免把仍然存活的无 Team 成员顺手绑进 Team。
   */
  private async admitWithRevival(agentId: string, text: string): Promise<AdmitResult> {
    const { service } = this.options;
    try {
      return await service.admit({ agent_id: agentId, content: text });
    } catch (error) {
      if (!isMemberClosed(error)) throw error;
      if (!(await this.revive(agentId))) throw error;
      return await service.admit({ agent_id: agentId, content: text });
    }
  }

  /**
   * 复活被回收的渠道成员。返回 false 表示无法复活（装配层未提供 Team / 成员
   * 不在 registry），调用方保留原始的 `member_closed`。
   *
   * `reinstate` 会原地清 body 的 `retiredAt`、重设 primary、清 bodyHistory 中同一
   * session 的条目并刷新 lastSeen，因此 agent id / session_id / 历史都不变；
   * 渠道侧不需要（也不能）新建 body。
   */
  private async revive(agentId: string): Promise<boolean> {
    const { service, resolveTeamId } = this.options;
    if (resolveTeamId === undefined) return false;
    const teamId = resolveTeamId();
    if (teamId === undefined || teamId === '') return false;
    const status = await service.identify(agentId);
    if (status === undefined) return false;
    if (status.membership !== 'left' && status.state !== 'closed') return false;
    await service.reinstate({ to: agentId, team_id: teamId });
    return true;
  }

  private async createMember(chatId: string): Promise<string> {
    const existing = this.members.get(chatId);
    if (existing !== undefined) return existing;

    const agentId = this.pickAgentId(chatId);
    // 先保留 id，避免并发创建时两个 chat 选中同一 id。
    this.usedAgentIds.add(agentId);

    try {
      await this.ensureAgent(agentId);
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
   *
   * 只传 `id`，其余全走 service 的缺省：导出的角色是 `temporary`（渠道成员是受管 /
   * 临时的，`single` 在 0.28 已不存在），不绑 Team（chat 没有 workspace 概念）。
   *
   * **为什么不传 name**（0.28 R8）：
   * - 合法形状不是充分条件。`name` 一旦存在且 service 配了 `defaultWorkspace`，
   *   `create` 会走 `teamBinder.ensureForWorkspace({ workspace, name })` 把成员绑进
   *   该 Team（`visibility` 随之变 `team`）。渠道成员必须保持 unbound private，
   *   所以这里连 name 都不给；缺省命名由 service 的 `autoNameFor` 负责。
   * - 旧写法 `name: \`feishu:${chatId}\`` 在任何配置下都不合法：`MEMBER_NAME_RE`
   *   （`packages/agent/src/service.ts` 的 `/^[A-Za-z0-9_-]{1,64}$/`）不接受 `:`，
   *   该 create 必然抛 `invalid_input`（`name must match ...`）。成员 id 已经编码了
   *   chat（`feishu_<sanitized chat id>`），name 不承担寻址职责。
   *
   * **不传 owner**：temporary 的缺省归属由 service 决定（`AgentServiceOptions.ownerId`）；
   * 渠道侧钉死一个 owner 会把「谁拥有这些成员」固化在插件里，与装配层的裁决冲突。
   */
  private async ensureAgent(agentId: string): Promise<void> {
    try {
      await this.options.service.create({ id: agentId });
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
