/**
 * Conversation 预算内核（0.19 S4）。
 *
 * - 限额来自 Team policy（`policyFor`），默认全部不限；环检测始终开启；
 * - 发送侧 `checkDelivery` 同步检查并预留 hop / 有向边；接收侧 `canStartTurn` 只读；
 * - 环检测是**滑动窗口限速**：同一有向边在每个 `cooldownSeconds` 窗口内最多
 *   `maxRepeats` 次；越界只拒绝本次投递（带 `retry_after`），**不落持久 blocked**。
 *   按整条 conversation 生命周期累积会把正常的多轮 hub-and-spoke 判死；
 * - 所有检查由投递 / turn 开始触发，没有定时器或轮询；
 * - 人工 override 只能抬高限额或清除；状态落 `ConversationStore`。
 *
 * @module @vessel-agent/agent
 */

import type { TeamBudgetPolicy, TeamPolicy } from '@vessel-agent/config';
import { type Logger, noopLogger } from '@vessel-agent/core';
import {
  type ConversationStore,
  MAX_CONVERSATION_EDGES,
  type StoredConversation,
  type StoredConversationEdge,
} from './conversation-store.js';
import { RESERVED_PRINCIPALS } from './team-address.js';
import {
  AgentError,
  type BudgetBlockReason,
  type BudgetCheckResult,
  type BudgetDeliveryInput,
  type BudgetDimension,
  type BudgetOverrideInput,
  type BudgetOverrideResult,
  type BudgetStatusInput,
  type BudgetTurnBlockedInput,
  type BudgetTurnFinishedInput,
  type BudgetTurnInput,
  type BudgetTurnStartedInput,
  type BudgetWarning,
  type ConversationBudgetEdge,
  type ConversationBudgetPort,
  type ConversationBudgetStatus,
} from './types.js';

export const DEFAULT_CYCLE_MAX_REPEATS = 2;
export const DEFAULT_CYCLE_COOLDOWN_SECONDS = 60;
export const DEFAULT_WARNING_THRESHOLD = 0.8;
export const MAX_STATUS_CONVERSATIONS = 20;

/** conversation_id：`conv_` + 生成器；接受的显式格式见 `isValidConversationId` */
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * 保留字：这些 from / to 不是 agent 投递，不参与环检测。
 *
 * 清单来自 `team-address.ts` 的保留 principal 词典（`RESERVED_PRINCIPALS`），
 * 不在这里另写一份字符串列表 —— 两处各写一份就会分叉。
 *
 * `main` 不在此列 —— 它是 agent（role single），与其它 agent 一样走 hop / cycle /
 * turns 限制。它曾被放进来，是因为人类消息的 `from` 一度就是 `main`。
 */
const NON_AGENT_IDS = RESERVED_PRINCIPALS;

export function isValidConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID_PATTERN.test(value);
}

export function generateConversationId(newId: () => string): string {
  return `conv_${newId()}`;
}

export interface ConversationBudgetOptions {
  store: ConversationStore;
  /** 按 origin team 解析 policy；无 team / 无 policy 时只有默认环检测 */
  policyFor: (teamId?: string) => TeamPolicy | undefined;
  now?: () => number;
  logger?: Logger;
}

interface ResolvedLimits {
  maxHops?: number;
  maxTurns?: number;
  maxTokens?: number;
  maxWallClockMs?: number;
  warningThreshold: number;
  maxRepeats: number;
  cooldownMs: number;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return floored >= 1 ? floored : undefined;
}

/** 运行时再校验一遍：手改 team.json 的非法值按“未配置”忽略，不让整条预算失效 */
export function resolveBudgetLimits(policy: TeamPolicy | undefined): ResolvedLimits {
  const budget: TeamBudgetPolicy | undefined =
    policy?.budget && typeof policy.budget === 'object' ? policy.budget : undefined;
  const cycle = budget?.cycle;
  const thresholdRaw = budget?.warningThreshold;
  const warningThreshold =
    typeof thresholdRaw === 'number' &&
    Number.isFinite(thresholdRaw) &&
    thresholdRaw > 0 &&
    thresholdRaw < 1
      ? thresholdRaw
      : DEFAULT_WARNING_THRESHOLD;
  const maxWallClockSeconds = positiveInteger(budget?.maxWallClockSeconds);
  return {
    ...(positiveInteger(budget?.maxHops) !== undefined
      ? { maxHops: positiveInteger(budget?.maxHops) }
      : {}),
    ...(positiveInteger(budget?.maxTurns) !== undefined
      ? { maxTurns: positiveInteger(budget?.maxTurns) }
      : {}),
    ...(positiveInteger(budget?.maxTokens) !== undefined
      ? { maxTokens: positiveInteger(budget?.maxTokens) }
      : {}),
    ...(maxWallClockSeconds !== undefined ? { maxWallClockMs: maxWallClockSeconds * 1000 } : {}),
    warningThreshold,
    maxRepeats: positiveInteger(cycle?.maxRepeats) ?? DEFAULT_CYCLE_MAX_REPEATS,
    // 窗口必须 > 0：0 会让窗口恒空 = 关掉环检测，违反「不可关闭」。手改 team.json
    // 写成 0 / 负数按未配置忽略，回落到缺省 60s。
    cooldownMs: (positiveInteger(cycle?.cooldownSeconds) ?? DEFAULT_CYCLE_COOLDOWN_SECONDS) * 1000,
  };
}

function isAgentId(value: string): boolean {
  return value !== '' && !NON_AGENT_IDS.has(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ConversationBudget implements ConversationBudgetPort {
  private readonly store: ConversationStore;
  private readonly policyFor: (teamId?: string) => TeamPolicy | undefined;
  private readonly now: () => number;
  private readonly logger: Logger;
  /** 进程内告警去重：conversation → dimension */
  private readonly warned = new Map<string, Set<BudgetDimension>>();
  /** 尚未交给 service 发布的告警 */
  private readonly pendingWarnings = new Map<string, BudgetWarning[]>();
  /** 接收侧 hold：conversation → agent ids（release 时返回） */
  private readonly holds = new Map<string, Set<string>>();

  constructor(options: ConversationBudgetOptions) {
    this.store = options.store;
    this.policyFor = options.policyFor;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? noopLogger;
  }

  checkDelivery(input: BudgetDeliveryInput): BudgetCheckResult {
    if (!this.store.available) return this.unavailable();
    const now = this.now();
    const mode = input.mode ?? 'delivery';
    const existing = this.store.get(input.conversation_id);
    // wake：不 ensure 新 conversation；不存在就跳过全部检查、不落记录。
    if (mode === 'wake' && existing === undefined) return { ok: true };
    if (
      input.origin_explicit === true &&
      existing?.team_id !== undefined &&
      input.team_id !== undefined &&
      existing.team_id !== input.team_id
    ) {
      return this.failed('hops', 'conversation_team_mismatch', existing.hops, null);
    }
    const teamId = existing?.team_id ?? input.team_id;
    const limits = this.limitsFor(teamId);
    // 迁移（0.42）：旧版本把 cycle 越界升级成持久 blocked。cycle 现在是窗口限速，
    // 读到旧标记就地清掉，本次投递按滑动窗口自行恢复（不动 store 版本、不加字段）。
    if (existing?.blocked?.dimension === 'cycle') {
      delete existing.blocked;
      this.store.markDirty();
    }
    if (existing?.blocked !== undefined) {
      const blocked = existing.blocked;
      // wake 只做汇总唤醒，不被 blocked 拦（cycle 已不落 blocked，见上）。
      if (mode !== 'wake') {
        return this.failed(
          blocked.dimension,
          blocked.reason,
          this.currentValue(existing, blocked.dimension, now),
          this.effectiveMax(existing, limits, blocked.dimension),
        );
      }
    }

    // delivery / read_only 才查 hops / wall-clock / turns / tokens。
    // wake 跳过这些维度（只保留 cycle）。
    if (mode !== 'wake') {
      const hops = existing?.hops ?? 0;
      const maxHops = this.effectiveMax(existing, limits, 'hops');
      if (maxHops !== undefined && hops + 1 > maxHops) {
        return this.failed('hops', 'budget_exceeded', hops, maxHops);
      }

      const created = existing?.created_at ?? now;
      const wallClock = now - created;
      const maxWallClock = this.effectiveMax(existing, limits, 'wall_clock');
      if (maxWallClock !== undefined && wallClock > maxWallClock) {
        return this.failed('wall_clock', 'budget_exceeded', wallClock, maxWallClock);
      }

      const turns = existing?.turns ?? 0;
      const maxTurns = this.effectiveMax(existing, limits, 'turns');
      if (maxTurns !== undefined && turns >= maxTurns) {
        return this.failed('turns', 'budget_exceeded', turns, maxTurns);
      }

      const tokens = existing?.total_tokens ?? 0;
      const maxTokens = this.effectiveMax(existing, limits, 'tokens');
      if (maxTokens !== undefined && tokens >= maxTokens) {
        return this.failed('tokens', 'budget_exceeded', tokens, maxTokens);
      }
    }

    // 边处理：bump = 检查并计数；check = 只检查；skip = 同 run 去重后整体跳过。
    // 计数是滑动窗口：一条有向边的重复只在「最近一个 cooldown 窗口」内计，
    // 即「同一有向边每个 cooldownSeconds 窗口最多 maxRepeats 次」。窗口外按 0 计，
    // 否则 (from,to) 会在整条 conversation 生命周期里累积，把多轮往返判死。
    const edgeMode = input.edge ?? (mode === 'read_only' ? 'check' : 'bump');
    let edgeCount = 0;
    const hasEdge = isAgentId(input.from) && isAgentId(input.to);
    if (edgeMode !== 'skip' && hasEdge) {
      const edge = existing?.edges.find(
        (entry) => entry.from === input.from && entry.to === input.to,
      );
      const cooldownMs = this.cooldownMsFor(existing, limits);
      edgeCount = edge !== undefined && this.withinWindow(edge, now, cooldownMs) ? edge.count : 0;
      const maxRepeats = this.effectiveMax(existing, limits, 'cycle') ?? DEFAULT_CYCLE_MAX_REPEATS;
      if (edgeCount + 1 > maxRepeats) {
        // 只限速，不落持久 blocked：窗口滑过后下一次投递自动恢复，
        // 不需要人工 override（永久 block 会把正常协作判死）。
        const retryAfter = (edge?.last_ts ?? now) + cooldownMs;
        return this.failed('cycle', 'cycle_detected', edgeCount, maxRepeats, retryAfter);
      }
    }

    if (mode === 'read_only') return { ok: true };

    // wake 只在已有记录上计边；不存在时上面已返回。
    const conversation = existing ?? this.store.ensure(input.conversation_id, teamId, now);
    if (mode === 'delivery') {
      conversation.last_activity = now;
      conversation.hops += 1;
    }
    if (edgeMode === 'bump' && hasEdge) {
      // baseCount = 窗口内的次数；窗口已滑过就从头计（1）。
      this.bumpEdge(conversation, input.from, input.to, edgeCount, now);
    }
    this.store.markDirty();
    if (mode === 'delivery') this.collectWarnings(conversation, limits, now);
    return { ok: true };
  }

  canStartTurn(input: BudgetTurnInput): BudgetCheckResult {
    if (!this.store.available) return this.unavailable();
    const now = this.now();
    const conversation = this.store.get(input.conversation_id);
    const teamId = conversation?.team_id ?? input.team_id;
    const limits = this.limitsFor(teamId);

    const turns = conversation?.turns ?? 0;
    const maxTurns = this.effectiveMax(conversation, limits, 'turns');
    if (maxTurns !== undefined && turns >= maxTurns) {
      return this.failed('turns', 'budget_exceeded', turns, maxTurns);
    }

    const tokens = conversation?.total_tokens ?? 0;
    const maxTokens = this.effectiveMax(conversation, limits, 'tokens');
    if (maxTokens !== undefined && tokens >= maxTokens) {
      return this.failed('tokens', 'budget_exceeded', tokens, maxTokens);
    }

    const wallClock = conversation === undefined ? 0 : now - conversation.created_at;
    const maxWallClock = this.effectiveMax(conversation, limits, 'wall_clock');
    if (maxWallClock !== undefined && wallClock > maxWallClock) {
      return this.failed('wall_clock', 'budget_exceeded', wallClock, maxWallClock);
    }

    // 迁移（0.42）：同 checkDelivery —— 旧 cycle blocked 就地清掉（窗口限速自愈）。
    if (conversation?.blocked?.dimension === 'cycle') {
      delete conversation.blocked;
      this.store.markDirty();
    }
    if (conversation?.blocked !== undefined) {
      const blocked = conversation.blocked;
      return this.failed(
        blocked.dimension,
        blocked.reason,
        this.currentValue(conversation, blocked.dimension, now),
        this.effectiveMax(conversation, limits, blocked.dimension),
      );
    }

    if (conversation !== undefined) this.collectWarnings(conversation, limits, now);
    return { ok: true };
  }

  noteTurnStarted(input: BudgetTurnStartedInput): void {
    if (!this.store.available) return;
    const now = this.now();
    const conversation = this.store.ensure(input.conversation_id, input.team_id, now);
    conversation.turns += 1;
    conversation.last_activity = now;
    this.store.markDirty();
  }

  noteTurnFinished(input: BudgetTurnFinishedInput): void {
    if (!this.store.available) return;
    const now = this.now();
    const conversation = this.store.ensure(input.conversation_id, input.team_id, now);
    const usage = input.usage;
    if (usage !== undefined) {
      const total =
        typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens)
          ? usage.total_tokens
          : (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
      if (Number.isFinite(total)) conversation.total_tokens += total;
    }
    conversation.last_activity = now;
    void this.store.force();
  }

  status(input: BudgetStatusInput): ConversationBudgetStatus[] {
    if (!this.store.available) {
      throw new AgentError('budget_unavailable', 'budget_unavailable');
    }
    if (input.conversation_id !== undefined) {
      const conversation = this.store.get(input.conversation_id);
      if (conversation === undefined || conversation.team_id !== input.team_id) return [];
      return [this.toStatus(conversation)];
    }
    return this.store
      .all()
      .filter((conversation) => conversation.team_id === input.team_id)
      .sort((left, right) => right.last_activity - left.last_activity)
      .slice(0, MAX_STATUS_CONVERSATIONS)
      .map((conversation) => this.toStatus(conversation));
  }

  override(input: BudgetOverrideInput): BudgetOverrideResult {
    if (!this.store.available) {
      throw new AgentError('budget_unavailable', 'budget_unavailable');
    }
    const conversation = this.store.get(input.conversation_id);
    if (conversation === undefined) {
      throw new AgentError('invalid_input', `conversation_not_found: ${input.conversation_id}`);
    }
    if (conversation.team_id !== undefined && conversation.team_id !== input.team_id) {
      // 不泄漏跨 Team conversation 的存在性
      throw new AgentError('invalid_input', `conversation_not_found: ${input.conversation_id}`);
    }

    const now = this.now();
    const limits = this.limitsFor(conversation.team_id ?? input.team_id);
    const previous = conversation.overrides[input.dimension]?.max ?? null;

    if (input.max !== null) {
      if (typeof input.max !== 'number' || !Number.isFinite(input.max) || input.max <= 0) {
        throw new AgentError('invalid_input', 'max must be a positive finite number or null');
      }
      if (input.dimension === 'cycle') {
        const currentMax =
          conversation.overrides.cycle?.max ?? limits.maxRepeats ?? DEFAULT_CYCLE_MAX_REPEATS;
        if (input.max <= currentMax) {
          throw new AgentError(
            'invalid_input',
            `cycle max must be greater than current maxRepeats (${currentMax})`,
          );
        }
      } else {
        const current = this.currentValue(conversation, input.dimension, now);
        if (input.max <= current) {
          throw new AgentError(
            'invalid_input',
            `${input.dimension} max must be greater than current value (${current})`,
          );
        }
      }
      conversation.overrides[input.dimension] = {
        max: input.max,
        by: 'human',
        via: input.via ?? 'api',
        at: now,
      };
      if (conversation.blocked?.dimension === input.dimension) delete conversation.blocked;
    } else {
      delete conversation.overrides[input.dimension];
    }

    // cycle 的人工干预同时清零该 conversation 的 cycle 边，否则下一次投递仍会被
    // 旧边计数挡住（override 只抬高上限不足以恢复）。
    if (input.dimension === 'cycle') {
      for (const edge of conversation.edges) edge.count = 0;
      if (conversation.blocked?.dimension === 'cycle') delete conversation.blocked;
    }

    if (conversation.team_id === undefined) conversation.team_id = input.team_id;
    void this.store.force();
    return {
      conversation_id: input.conversation_id,
      dimension: input.dimension,
      previous_max: previous,
      max: input.max,
      status: this.toStatus(conversation),
    };
  }

  /** 清除接收侧 hold 与 blocked；返回需要重新 pump 的 agent id */
  release(conversationId: string): string[] {
    const holders = this.holds.get(conversationId);
    this.holds.delete(conversationId);
    this.pendingWarnings.delete(conversationId);
    const conversation = this.store.get(conversationId);
    if (conversation?.blocked !== undefined) {
      delete conversation.blocked;
      void this.store.force();
    }
    return holders === undefined ? [] : [...holders];
  }

  /** 接收侧 hold 记账（service 在 hold 时调用） */
  noteHold(conversationId: string, agentId: string): void {
    let holders = this.holds.get(conversationId);
    if (holders === undefined) {
      holders = new Set();
      this.holds.set(conversationId, holders);
    }
    holders.add(agentId);
  }

  clearHold(conversationId: string, agentId: string): void {
    const holders = this.holds.get(conversationId);
    if (holders === undefined) return;
    holders.delete(agentId);
    if (holders.size === 0) this.holds.delete(conversationId);
  }

  /** 接收侧 turn 被挡：持久化 state.blocked（unavailable 时无状态可写） */
  noteTurnBlocked(input: BudgetTurnBlockedInput): void {
    if (!this.store.available || input.reason === 'budget_unavailable') return;
    const now = this.now();
    const conversation = this.store.ensure(input.conversation_id, input.team_id, now);
    conversation.blocked = { dimension: input.dimension, reason: input.reason, at: now };
    void this.store.force();
  }

  /** 取走 service 尚未发布的告警（每个 conversation+dimension 进程内只发一次） */
  takeWarnings(conversationId: string): BudgetWarning[] {
    const warnings = this.pendingWarnings.get(conversationId) ?? [];
    this.pendingWarnings.delete(conversationId);
    return warnings;
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }

  private limitsFor(teamId: string | undefined): ResolvedLimits {
    try {
      return resolveBudgetLimits(this.policyFor(teamId));
    } catch (error) {
      // 自定义 resolver 抛错不放大成投递失败；按默认策略继续（环检测仍生效）
      this.logger.warn('conversation_budget.policy_failed', { error: errorText(error) });
      return resolveBudgetLimits(undefined);
    }
  }

  private effectiveMax(
    conversation: StoredConversation | undefined,
    limits: ResolvedLimits,
    dimension: BudgetDimension,
  ): number | undefined {
    const override = conversation?.overrides?.[dimension];
    if (override !== undefined && typeof override.max === 'number') return override.max;
    switch (dimension) {
      case 'hops':
        return limits.maxHops;
      case 'turns':
        return limits.maxTurns;
      case 'tokens':
        return limits.maxTokens;
      case 'wall_clock':
        return limits.maxWallClockMs;
      case 'cycle':
        return limits.maxRepeats;
      default:
        return undefined;
    }
  }

  private cooldownMsFor(
    _conversation: StoredConversation | undefined,
    limits: ResolvedLimits,
  ): number {
    return limits.cooldownMs;
  }

  /**
   * 边计数是否仍在窗口内。窗口 = `cooldownSeconds`，从该边上一次成功投递起算：
   * 这意味着「同一条有向边最多每 `cooldownMs / maxRepeats` 打一次」，而不会在
   * 整条 conversation 生命周期内累积。
   */
  private withinWindow(edge: StoredConversationEdge, now: number, cooldownMs: number): boolean {
    return now - edge.last_ts <= cooldownMs;
  }

  private currentValue(
    conversation: Pick<StoredConversation, 'hops' | 'turns' | 'total_tokens' | 'created_at'>,
    dimension: BudgetDimension,
    now: number,
  ): number {
    switch (dimension) {
      case 'hops':
        return conversation.hops;
      case 'turns':
        return conversation.turns;
      case 'tokens':
        return conversation.total_tokens;
      case 'wall_clock':
        return Math.max(0, now - conversation.created_at);
      case 'cycle':
        return 0;
      default:
        return 0;
    }
  }

  private bumpEdge(
    conversation: Pick<StoredConversation, 'edges'>,
    from: string,
    to: string,
    baseCount: number,
    now: number,
  ): void {
    const existing = conversation.edges.find((edge) => edge.from === from && edge.to === to);
    if (existing !== undefined) {
      existing.count = baseCount + 1;
      existing.last_ts = now;
    } else {
      conversation.edges.push({ from, to, count: 1, last_ts: now });
    }
    if (conversation.edges.length > MAX_CONVERSATION_EDGES) {
      conversation.edges.sort((left, right) => left.last_ts - right.last_ts);
      conversation.edges.splice(0, conversation.edges.length - MAX_CONVERSATION_EDGES);
    }
  }

  /** 已配置维度到 80% 且未满 100% 时记录一次告警 */
  private collectWarnings(
    conversation: StoredConversation,
    limits: ResolvedLimits,
    now: number,
  ): void {
    const dimensions: Array<Exclude<BudgetDimension, 'cycle'>> = [
      'hops',
      'turns',
      'tokens',
      'wall_clock',
    ];
    for (const dimension of dimensions) {
      const max = this.effectiveMax(conversation, limits, dimension);
      if (max === undefined || max <= 0) continue;
      const current = this.currentValue(conversation, dimension, now);
      const ratio = current / max;
      if (ratio < limits.warningThreshold || ratio >= 1) continue;
      let warned = this.warned.get(conversation.conversation_id);
      if (warned?.has(dimension)) continue;
      if (warned === undefined) {
        warned = new Set();
        this.warned.set(conversation.conversation_id, warned);
      }
      warned.add(dimension);
      const list = this.pendingWarnings.get(conversation.conversation_id) ?? [];
      list.push({
        conversation_id: conversation.conversation_id,
        ...(conversation.team_id !== undefined ? { team_id: conversation.team_id } : {}),
        dimension,
        current,
        max,
        threshold: limits.warningThreshold,
      });
      this.pendingWarnings.set(conversation.conversation_id, list);
    }
  }

  private toStatus(conversation: StoredConversation): ConversationBudgetStatus {
    const now = this.now();
    const limits = this.limitsFor(conversation.team_id);
    const maxRepeats =
      this.effectiveMax(conversation, limits, 'cycle') ?? DEFAULT_CYCLE_MAX_REPEATS;
    const edges: ConversationBudgetEdge[] = conversation.edges.map((edge) => {
      // blocked_until 只在窗口内越界时给出：窗口滑过后该边自动可再用。
      const blockedUntil =
        this.withinWindow(edge, now, limits.cooldownMs) && edge.count + 1 > maxRepeats
          ? edge.last_ts + limits.cooldownMs
          : undefined;
      return {
        from: edge.from,
        to: edge.to,
        count: edge.count,
        last_ts: edge.last_ts,
        ...(blockedUntil !== undefined && blockedUntil > now
          ? { blocked_until: blockedUntil }
          : {}),
      };
    });
    return {
      conversation_id: conversation.conversation_id,
      ...(conversation.team_id !== undefined ? { team_id: conversation.team_id } : {}),
      created_at: conversation.created_at,
      last_activity: conversation.last_activity,
      hops: conversation.hops,
      turns: conversation.turns,
      total_tokens: conversation.total_tokens,
      wall_clock_ms: Math.max(0, now - conversation.created_at),
      edges,
      overrides: Object.fromEntries(
        Object.entries(conversation.overrides).map(([key, value]) => [key, { ...value }]),
      ) as ConversationBudgetStatus['overrides'],
      ...(conversation.blocked !== undefined ? { blocked: { ...conversation.blocked } } : {}),
    };
  }

  private unavailable(): BudgetCheckResult {
    return {
      ok: false,
      dimension: 'hops',
      reason: 'budget_unavailable',
      current: 0,
      max: null,
    };
  }

  private failed(
    dimension: BudgetDimension,
    reason: BudgetBlockReason,
    current: number,
    max: number | null | undefined,
    retryAfter?: number,
  ): BudgetCheckResult {
    return {
      ok: false,
      dimension,
      reason,
      current,
      max: max ?? null,
      ...(retryAfter !== undefined ? { retry_after_ts: retryAfter } : {}),
    };
  }
}
