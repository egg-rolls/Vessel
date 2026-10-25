/**
 * `interactions.list` hydration：把 pending / orphaned 映射成事件卡片模型，
 * 并用纯 reducer 原子合并。
 *
 * 合并约束：按 `requestId` 去重且事件先到者优先；`answered` / `orphaned` 为终态，
 * 移除同 id pending；settled id 不复活；list 缺席不删除现有卡片。
 */
import type { AskUserQuestion, AskUserRequest, PermissionRequest, PermissionScope } from './types';

/** 镜像 serve `ListedInteraction`（packages/serve/src/gateway/methods/interactions.ts）。 */
export interface ListedInteractionAnswer {
  decision: 'allow' | 'deny';
  scope: PermissionScope;
  answered_at: number;
}

export interface ListedInteraction {
  kind: 'permission' | 'ask';
  request_id: string;
  run_id: string;
  /** 0.19 S4 additive：请求所属成员 / Team；缺失时 Web 不反查。 */
  agent_id?: string;
  team_id?: string;
  session_id?: string;
  parent_session_id?: string;
  tool_call_id?: string;
  tool?: string;
  input?: unknown;
  questions?: unknown;
  created_at: number;
  status: 'pending' | 'answered' | 'orphaned';
  answer?: ListedInteractionAnswer;
}

/** `interactions.list` 分页结果（DECISION-038 §2.2：cursor additive）。 */
export interface ListedInteractionPage {
  interactions: ListedInteraction[];
  /** 过滤后的总条数，不受 limit / cursor 影响。 */
  total: number;
  /** 还有下一页时返回；否则缺失。 */
  next_cursor?: string;
}

export interface InteractionState {
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
}

export const emptyInteractionState: InteractionState = {
  permissions: [],
  asks: [],
};

export interface HydrationSnapshot {
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
  /** orphaned / answered 的终态 id：只用于移除旧卡片，不再渲染本地失效列表。 */
  terminalIds: readonly string[];
}

export interface HydrationSources {
  pending: readonly ListedInteraction[];
  orphaned: readonly ListedInteraction[];
  settled?: ReadonlySet<string>;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * 复用 `askFromEvent` 的校验语义：非数组 -> 丢弃整条；过滤无 `question` 的项；
 * 过滤完为空 -> 丢弃整条。
 */
function listedQuestions(value: unknown): AskUserQuestion[] | null {
  if (!Array.isArray(value)) return null;
  const questions = value.filter(
    (item): item is AskUserQuestion =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as { question?: unknown }).question === 'string',
  );
  return questions.length > 0 ? questions : null;
}

/**
 * 把两次 list 的结果映射成可合并快照。
 *
 * `orphaned` 只充当终态集合：同一 id 即使在 pending 结果里也不复活；
 * 终态 id 交给 reducer 移除旧卡片，本地不再渲染 orphaned 列表。
 * 卡片归属只读 list 的 `session_id`；缺失保持 undefined，不做反查 / join。
 */
export function buildHydrationSnapshot(sources: HydrationSources): HydrationSnapshot {
  const settled = sources.settled ?? EMPTY_IDS;
  const permissions: PermissionRequest[] = [];
  const asks: AskUserRequest[] = [];
  const terminalIds: string[] = [];
  const terminal = new Set<string>();

  for (const item of sources.orphaned) {
    if (item.status !== 'orphaned' || !item.request_id) continue;
    if (terminal.has(item.request_id)) continue;
    terminal.add(item.request_id);
    if (!settled.has(item.request_id)) terminalIds.push(item.request_id);
  }

  const seen = new Set<string>(terminal);
  for (const item of sources.pending) {
    if (item.status !== 'pending' || !item.request_id) continue;
    // 同 id 已在 orphaned 终态集合里：pending 不覆盖终态。
    if (seen.has(item.request_id) || settled.has(item.request_id)) continue;
    const sessionId = item.session_id;

    if (item.kind === 'permission') {
      seen.add(item.request_id);
      permissions.push({
        requestId: item.request_id,
        tool: item.tool ?? 'tool',
        input: item.input,
        runId: item.run_id,
        requestedAt: item.created_at,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(item.parent_session_id ? { parentSessionId: item.parent_session_id } : {}),
        ...(item.tool_call_id !== undefined && item.tool_call_id.length > 0
          ? { toolCallId: item.tool_call_id }
          : {}),
      });
      continue;
    }

    const questions = listedQuestions(item.questions);
    if (!questions) continue;
    seen.add(item.request_id);
    asks.push({
      requestId: item.request_id,
      questions,
      runId: item.run_id,
      requestedAt: item.created_at,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(item.parent_session_id ? { parentSessionId: item.parent_session_id } : {}),
    });
  }

  return { permissions, asks, terminalIds };
}

export type InteractionAction =
  | { type: 'permission-request'; request: PermissionRequest }
  | { type: 'ask-request'; request: AskUserRequest }
  | { type: 'settle'; requestId: string }
  | { type: 'run-finished'; runId: string }
  | { type: 'hydrate'; snapshot: HydrationSnapshot; settled?: ReadonlySet<string> }
  | { type: 'reset' };

function removeById<T extends { requestId: string }>(
  items: readonly T[],
  requestId: string,
): readonly T[] {
  return items.some((item) => item.requestId === requestId)
    ? items.filter((item) => item.requestId !== requestId)
    : items;
}

function hasId(state: InteractionState, requestId: string): boolean {
  return (
    state.permissions.some((item) => item.requestId === requestId) ||
    state.asks.some((item) => item.requestId === requestId)
  );
}

/** 事件增量、应答移除、run 终态、hydration 合并共用；终态优先、settled 不复活。 */
export function interactionReducer(
  state: InteractionState,
  action: InteractionAction,
): InteractionState {
  switch (action.type) {
    case 'permission-request': {
      if (hasId(state, action.request.requestId)) return state;
      return { ...state, permissions: [...state.permissions, action.request] };
    }
    case 'ask-request': {
      if (hasId(state, action.request.requestId)) return state;
      return { ...state, asks: [...state.asks, action.request] };
    }
    case 'settle': {
      const permissions = removeById(state.permissions, action.requestId);
      const asks = removeById(state.asks, action.requestId);
      if (permissions === state.permissions && asks === state.asks) return state;
      return { permissions, asks };
    }
    case 'run-finished': {
      const permissions = state.permissions.filter((item) => item.runId !== action.runId);
      const asks = state.asks.filter((item) => item.runId !== action.runId);
      if (permissions.length === state.permissions.length && asks.length === state.asks.length) {
        return state;
      }
      return { ...state, permissions, asks };
    }
    case 'reset':
      return emptyInteractionState;
    case 'hydrate': {
      // 终态在应用时才判定：快照生成后本端结算的 id 也不能复活。
      const settled = action.settled ?? EMPTY_IDS;
      const terminal = new Set(
        action.snapshot.terminalIds.filter((requestId) => !settled.has(requestId)),
      );

      const permissions = state.permissions.filter(
        (item) => !settled.has(item.requestId) && !terminal.has(item.requestId),
      );
      const asks = state.asks.filter(
        (item) => !settled.has(item.requestId) && !terminal.has(item.requestId),
      );

      const taken = new Set<string>();
      for (const item of permissions) taken.add(item.requestId);
      for (const item of asks) taken.add(item.requestId);

      const nextPermissions = [...permissions];
      for (const request of action.snapshot.permissions) {
        if (settled.has(request.requestId) || taken.has(request.requestId)) continue;
        taken.add(request.requestId);
        nextPermissions.push(request);
      }

      const nextAsks = [...asks];
      for (const request of action.snapshot.asks) {
        if (settled.has(request.requestId) || taken.has(request.requestId)) continue;
        taken.add(request.requestId);
        nextAsks.push(request);
      }

      return { permissions: nextPermissions, asks: nextAsks };
    }
    default:
      return state;
  }
}
