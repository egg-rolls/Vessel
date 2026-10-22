/**
 * `interactions.list` hydration：把 pending / orphaned 映射成事件卡片模型，
 * 并用纯 reducer 原子合并。
 *
 * 合并约束：按 `requestId` 去重且事件先到者优先；`answered` / `orphaned` 为终态，
 * 移除同 id pending；settled id 不复活；list 缺席不删除现有卡片。
 */
import type {
  AskUserQuestion,
  AskUserRequest,
  PermissionRequest,
  PermissionScope,
  RunStatus,
} from './types';

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
  session_id?: string;
  tool_call_id?: string;
  tool?: string;
  input?: unknown;
  questions?: unknown;
  created_at: number;
  status: 'pending' | 'answered' | 'orphaned';
  answer?: ListedInteractionAnswer;
}

/** 只用于失效提示，不构造可应答卡片。 */
export interface OrphanedInteraction {
  kind: 'permission' | 'ask';
  requestId: string;
  runId: string;
  sessionId?: string;
  tool?: string;
  createdAt: number;
}

export interface InteractionState {
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
  orphaned: readonly OrphanedInteraction[];
}

export const emptyInteractionState: InteractionState = {
  permissions: [],
  asks: [],
  orphaned: [],
};

/** 服务端拉 100，状态里最多保留 20。 */
export const ORPHANED_LIMIT = 20;

export interface HydrationSnapshot {
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
  orphaned: readonly OrphanedInteraction[];
}

export interface HydrationSources {
  pending: readonly ListedInteraction[];
  orphaned: readonly ListedInteraction[];
  runs?: readonly RunStatus[];
  /** 从已接收事件反查 run 归属（ConnectionProvider 的 sessionIdForRun）。 */
  sessionForRun?: (runId: string) => string | undefined;
  settled?: ReadonlySet<string>;
  dismissed?: ReadonlySet<string>;
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
 * ask 事件不带 `session_id`：先查事件反查，再用 `runs.list` 按
 * `interaction.run_id === run.core_run_id` join（不能用 `run.run_id`）。
 */
function resolveSessionId(
  item: ListedInteraction,
  runs: readonly RunStatus[],
  sessionForRun?: (runId: string) => string | undefined,
): string | undefined {
  if (item.session_id) return item.session_id;
  const fromEvents = sessionForRun?.(item.run_id);
  if (fromEvents) return fromEvents;
  return runs.find((run) => run.core_run_id === item.run_id)?.session_id;
}

function toOrphaned(
  item: ListedInteraction,
  runs: readonly RunStatus[],
  sessionForRun?: (runId: string) => string | undefined,
): OrphanedInteraction {
  const sessionId = resolveSessionId(item, runs, sessionForRun);
  return {
    kind: item.kind,
    requestId: item.request_id,
    runId: item.run_id,
    createdAt: item.created_at,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(item.tool !== undefined ? { tool: item.tool } : {}),
  };
}

/**
 * 把两次 list 的结果映射成可合并快照。
 *
 * `orphaned` 同时充当终态集合：同一 id 即使在 pending 结果里也按 orphaned 处理。
 * 缺 `session_id` 的 ask / permission 依次用 `sessionForRun`、`runs` 补全。
 */
export function buildHydrationSnapshot(sources: HydrationSources): HydrationSnapshot {
  const settled = sources.settled ?? EMPTY_IDS;
  const dismissed = sources.dismissed ?? EMPTY_IDS;
  const runs = sources.runs ?? [];
  const permissions: PermissionRequest[] = [];
  const asks: AskUserRequest[] = [];
  const orphaned: OrphanedInteraction[] = [];
  const seen = new Set<string>();

  for (const item of sources.orphaned) {
    if (item.status !== 'orphaned' || !item.request_id) continue;
    if (seen.has(item.request_id)) continue;
    if (settled.has(item.request_id) || dismissed.has(item.request_id)) continue;
    seen.add(item.request_id);
    if (orphaned.length < ORPHANED_LIMIT)
      orphaned.push(toOrphaned(item, runs, sources.sessionForRun));
  }

  for (const item of sources.pending) {
    if (item.status !== 'pending' || !item.request_id) continue;
    // 同 id 已在 orphaned 终态集合里：pending 不覆盖终态。
    if (seen.has(item.request_id) || settled.has(item.request_id)) continue;
    const sessionId = resolveSessionId(item, runs, sources.sessionForRun);

    if (item.kind === 'permission') {
      seen.add(item.request_id);
      permissions.push({
        requestId: item.request_id,
        tool: item.tool ?? 'tool',
        input: item.input,
        runId: item.run_id,
        requestedAt: item.created_at,
        ...(sessionId !== undefined ? { sessionId } : {}),
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
    });
  }

  return { permissions, asks, orphaned };
}

export type InteractionAction =
  | { type: 'permission-request'; request: PermissionRequest }
  | { type: 'ask-request'; request: AskUserRequest }
  | { type: 'settle'; requestId: string }
  | { type: 'run-finished'; runId: string }
  | { type: 'hydrate'; snapshot: HydrationSnapshot; settled?: ReadonlySet<string> }
  | { type: 'dismiss-orphaned'; requestId: string }
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
    state.asks.some((item) => item.requestId === requestId) ||
    state.orphaned.some((item) => item.requestId === requestId)
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
      const orphaned = removeById(state.orphaned, action.requestId);
      if (permissions === state.permissions && asks === state.asks && orphaned === state.orphaned) {
        return state;
      }
      return { permissions, asks, orphaned };
    }
    case 'run-finished': {
      const permissions = state.permissions.filter((item) => item.runId !== action.runId);
      const asks = state.asks.filter((item) => item.runId !== action.runId);
      if (permissions.length === state.permissions.length && asks.length === state.asks.length) {
        return state;
      }
      return { ...state, permissions, asks };
    }
    case 'dismiss-orphaned': {
      const orphaned = removeById(state.orphaned, action.requestId);
      return orphaned === state.orphaned ? state : { ...state, orphaned };
    }
    case 'reset':
      return emptyInteractionState;
    case 'hydrate': {
      // 终态在应用时才判定：快照生成后本端结算的 id 也不能复活。
      const settled = action.settled ?? EMPTY_IDS;
      const incomingOrphaned = action.snapshot.orphaned.filter(
        (item) => !settled.has(item.requestId),
      );
      const terminal = new Set(incomingOrphaned.map((item) => item.requestId));

      const permissions = state.permissions.filter(
        (item) => !settled.has(item.requestId) && !terminal.has(item.requestId),
      );
      const asks = state.asks.filter(
        (item) => !settled.has(item.requestId) && !terminal.has(item.requestId),
      );

      // 新列表在前（服务端 created_at 倒序）；快照缺席的旧条目保留，最多 20 条。
      const incomingIds = new Set(incomingOrphaned.map((item) => item.requestId));
      const retainedOrphaned = state.orphaned.filter(
        (item) => !settled.has(item.requestId) && !incomingIds.has(item.requestId),
      );
      const orphaned = [...incomingOrphaned, ...retainedOrphaned].slice(0, ORPHANED_LIMIT);

      const taken = new Set<string>();
      for (const item of permissions) taken.add(item.requestId);
      for (const item of asks) taken.add(item.requestId);
      for (const item of orphaned) taken.add(item.requestId);

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

      return { permissions: nextPermissions, asks: nextAsks, orphaned };
    }
    default:
      return state;
  }
}

// ── dismissed（按 tenant 持久化，刷新后不再弹出）────────────

export const DISMISSED_KEY_PREFIX = 'vessel.interactions.dismissed.v1.';
const DISMISSED_LIMIT = 200;

/** 只依赖 getItem / setItem，便于测试注入；`window.localStorage` 直接满足。 */
export interface DismissedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function dismissedKey(tenantId: string): string {
  return `${DISMISSED_KEY_PREFIX}${tenantId}`;
}

/** JSON 数组；损坏 / 非数组 / 读失败一律按空集。 */
export function readDismissedIds(
  storage: DismissedStorage | null | undefined,
  tenantId: string,
): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(dismissedKey(tenantId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const ids = parsed.filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    );
    return new Set(ids.slice(-DISMISSED_LIMIT));
  } catch {
    return new Set();
  }
}

/** 追加到该 tenant 的关闭列表；写失败（配额 / 隐私模式）不影响内存里的移除。 */
export function addDismissedId(
  storage: DismissedStorage | null | undefined,
  tenantId: string,
  requestId: string,
): void {
  if (!storage || !requestId) return;
  try {
    const ids = readDismissedIds(storage, tenantId);
    if (ids.has(requestId)) return;
    ids.add(requestId);
    storage.setItem(dismissedKey(tenantId), JSON.stringify([...ids].slice(-DISMISSED_LIMIT)));
  } catch {
    // localStorage 不可写时只保留本会话的 dismiss。
  }
}
