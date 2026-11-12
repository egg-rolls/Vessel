/**
 * Team 事件派生状态（纯函数，无 React / 无全局单例）。
 *
 * - 权威消息源只有 `teams.get` 轮询；本模块不构造消息正文，只产出「需要重新拉取」的信号。
 * - 成员活动由 `run.*` 驱动：`run.*` 带 `agent_id` / `session_id`，但不保证带 `team_id`，
 *   因此缺 `team_id` 时按 roster 成员的 `session_id` 集合反查归属；
 *   带 `team_id` 的事件仍只按 team 过滤（旧事件 / unbound agent 不得混入）。
 * - 去重：`lastAppliedSeq` 防止 50ms 合批重复应用；EventStore 的 seq 去重之外再兜一层。
 * - Body 历史：优先服务端 `member.body_history`；仅字段缺失时才累积事件观察值。
 */
import type { TeamBodyHistoryEntry, TeamDetail, TeamMember, TeamMessage } from '../gateway/types';

/** 事件观察到的已退役 Body（仅 `body_history` 缺失时使用）。 */
export interface ObservedBody {
  session_id: string;
  epoch: number;
  observed_at: number;
  reason?: string;
}

export interface TeamEventState {
  lastAppliedSeq: number;
  /** 仅在 member.body_history 缺失时使用；按 agent_id 分组 */
  fallbackBodyHistory: Record<string, ObservedBody[]>;
  /** 需要重新拉取 `teams.get`（消息 + roster）的信号；正文永远来自轮询。 */
  rosterDirty: boolean;
}

export interface TeamEventLike {
  type: string;
  seq?: number;
  ts: number;
  data: Record<string, unknown>;
}

/** 事件回退历史的上限；与 S3 `body_history` 保持一致。 */
const MAX_OBSERVED_BODIES = 20;

export function createTeamEventState(): TeamEventState {
  return {
    lastAppliedSeq: 0,
    fallbackBodyHistory: {},
    rosterDirty: false,
  };
}

function compareMessages(a: TeamMessage, b: TeamMessage): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  // 字典序用码元比较，避免 localeCompare 在不同环境产生不同结果。
  if (a.message_id === b.message_id) return 0;
  return a.message_id < b.message_id ? -1 : 1;
}

/** `ts` 升序；`ts` 相同按 `message_id` 字典序（稳定，不依赖输入顺序）。 */
export function sortMessages(messages: readonly TeamMessage[]): TeamMessage[] {
  return [...messages].sort(compareMessages);
}

/** 按 `message_id` 去重；incoming 覆盖同 id 的 base；`kind:'reply'` 与其它消息同等对待。 */
export function mergeMessages(
  base: readonly TeamMessage[],
  incoming: readonly TeamMessage[],
): TeamMessage[] {
  const byId = new Map<string, TeamMessage>();
  for (const message of base) byId.set(message.message_id, message);
  for (const message of incoming) byId.set(message.message_id, message);
  return sortMessages([...byId.values()]);
}

/**
 * 「加载更早」响应合并（CONTRACT-msg-system §4.4，数据层）。
 *
 * - 前插按 `message_id` 幂等去重（`mergeMessages` 已排序）；
 * - `hasMore` **只**由 `before` 响应更新；尾页轮询不得拿它覆盖翻页状态。
 * 组件层（S3 的 `useTeamChat`）只需保留 `before` 响应的返回值。
 */
export function mergeEarlierTeamPage(
  current: readonly TeamMessage[],
  page: Pick<TeamDetail, 'messages' | 'messages_has_more'>,
): { messages: TeamMessage[]; hasMore: boolean } {
  return {
    messages: mergeMessages(current, page.messages),
    hasMore: page.messages_has_more === true,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function appendObserved(
  history: Record<string, ObservedBody[]>,
  agentId: string,
  body: ObservedBody,
): Record<string, ObservedBody[]> {
  const current = history[agentId] ?? [];
  // 按 session_id 去重：同一 Body 的重复事件不重复累积。
  if (current.some((entry) => entry.session_id === body.session_id)) return history;
  return {
    ...history,
    [agentId]: [...current, body].slice(-MAX_OBSERVED_BODIES),
  };
}

/**
 * 事件是否属于当前 Team。
 *
 * `team_id` 存在时以它为准；`run.*` 不保证带 `team_id`（§5.2），
 * 此时用 roster 成员的 `session_id` 集合反查归属。两者都没有则忽略。
 */
function belongsToTeam(
  event: TeamEventLike,
  activeTeamId: string,
  memberSessionIds: ReadonlySet<string> | undefined,
): boolean {
  const eventTeamId = asString(event.data.team_id);
  if (eventTeamId !== undefined) return eventTeamId === activeTeamId;
  const sessionId = asString(event.data.session_id);
  if (sessionId === undefined || memberSessionIds === undefined) return false;
  return memberSessionIds.has(sessionId);
}

/**
 * 应用一条 Team 事件，返回新状态（不修改入参）。
 *
 * - 有 `seq` 且 `<= lastAppliedSeq` → 原样返回；
 * - 有 `seq` 时先更新 `lastAppliedSeq`，即使事件因 team 不匹配被忽略；
 * - 不属于当前 Team → 除 seq 外不改变任何状态；
 * - 不构造消息正文：正文只来自 `teams.get` 轮询，事件最多置 `rosterDirty`。
 */
export function applyTeamEvent(
  state: TeamEventState,
  event: TeamEventLike,
  activeTeamId: string,
  memberSessionIds?: ReadonlySet<string>,
): TeamEventState {
  if (event.seq !== undefined && event.seq <= state.lastAppliedSeq) return state;

  const next: TeamEventState =
    event.seq !== undefined ? { ...state, lastAppliedSeq: event.seq } : state;

  if (!belongsToTeam(event, activeTeamId, memberSessionIds)) return next;

  switch (event.type) {
    // 0.51：旧 `agent.rotated` 分支已删（死类型，从未发出）。Body 历史的事件观察值
    // 只来自 `agent.retired` —— rotate 的退役在工具内就发，早于新 body 的
    // `agent.session.activated`，所以它才是「换过身体」的唯一事件来源。
    case 'agent.retired': {
      const agentId = asString(event.data.agent_id);
      const bodyId = asString(event.data.body_id);
      if (!agentId || !bodyId) return next;
      const reason = asString(event.data.reason);
      const history = appendObserved(next.fallbackBodyHistory, agentId, {
        session_id: bodyId,
        epoch: asNumber(event.data.epoch) ?? 0,
        observed_at: event.ts,
        ...(reason !== undefined ? { reason } : {}),
      });
      if (history === next.fallbackBodyHistory) return next;
      return { ...next, fallbackBodyHistory: history };
    }
    case 'agent.restarting':
    case 'agent.restarted':
    case 'agent.compact_forked':
      // 0.34：restart 复用 Session，compactFork 换 primary Session；都只需重拉 roster。
      return { ...next, rosterDirty: true };
    default:
      // run.* 是唯一 run 生命周期（成员状态靠它 + agent_id 刷新）；
      // agent.* 生命周期事件同样只需重新拉取，不参与正文构造。
      if (event.type.startsWith('run.') || event.type.startsWith('agent.')) {
        return { ...next, rosterDirty: true };
      }
      return next;
  }
}

/**
 * 服务端 Body 历史：字段存在（含空数组）时返回按 epoch 升序的副本；
 * 缺失时返回 null，由调用方回退到事件累积。
 */
export function serverBodyHistory(member: TeamMember | undefined): TeamBodyHistoryEntry[] | null {
  if (!member || member.body_history === undefined) return null;
  return [...member.body_history].sort((a, b) => a.epoch - b.epoch);
}

/** 事件观察到的 Body 历史副本（按 observed_at 升序）；无记录返回 []。 */
export function observedBodyHistory(state: TeamEventState, agentId: string): ObservedBody[] {
  return [...(state.fallbackBodyHistory[agentId] ?? [])].sort(
    (a, b) => a.observed_at - b.observed_at,
  );
}

export interface BodyHistorySelection {
  source: 'server' | 'observed';
  server: TeamBodyHistoryEntry[];
  observed: ObservedBody[];
}

/**
 * Body 历史单一真相源：服务端字段存在时完全忽略事件观察值，
 * 避免同一页出现“服务端历史 + 本次页面观察”两份数据。
 */
export function preferBodyHistory(
  server: TeamBodyHistoryEntry[] | null,
  observed: readonly ObservedBody[],
): BodyHistorySelection {
  if (server !== null) return { source: 'server', server, observed: [] };
  return { source: 'observed', server: [], observed: [...observed] };
}

