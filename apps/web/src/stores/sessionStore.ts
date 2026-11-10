/**
 * Session domain store: single source for the session list, the selected id
 * and the current session detail.
 *
 * ChatView drives selection from the route and fetches through `GatewayClient`;
 * `SessionList` renders the same snapshot. Real-time event state (snapshot,
 * streaming chunks, group cache) stays in `state/events.ts` / `event-store.ts`
 * and is deliberately not copied here.
 *
 * CONTRACT-msg-system §4.3：`detail` 不是完整 transcript，而是一段连续窗口
 * `[start, end)`（绝对下标）+ `next_before`。`messages` 保持未过滤数组；
 * `runtimeMessageKind` / role 的可见性过滤仍在 UI 层。
 */
import { create } from 'zustand';
import type { GatewayClient } from '../gateway/client';
import { isHistoryChangedError } from '../gateway/errors';
import type { SessionDetail, SessionInfo } from '../gateway/types';
import { removeSessionFromList, renameSessionInList } from '../state/sessions';
import { invalidateGeneration, isCurrentGeneration, nextGeneration } from './store-resource';

/** Sentinel error so ChatView can distinguish a deleted session from a real failure. */
export const SESSION_NOT_FOUND_MESSAGE = 'chat.notFound';

/** 首屏 / 每次「加载更早」的页大小（CONTRACT-msg-system §4.3）。 */
export const TRANSCRIPT_WINDOW = 50;

/**
 * 历史前缀被改写（`before` 游标锚点失效）后的一次性提示。
 * S3 接线 i18n；本轮不改主 checkout WIP 里的 i18n catalog。
 */
export const HISTORY_CHANGED_NOTICE = 'chat.historyChanged';

/** `detail.messages` 对应的绝对窗口 `[start, end)`（未做可见性过滤）。 */
export interface SessionDetailWindow {
  sessionId: string;
  /** 窗口首条消息在完整 `state.messages` 中的下标（含）。 */
  start: number;
  /** 窗口末尾下标（不含）。 */
  end: number;
  /** 取自服务端的上一页游标；缺失 = 已到会话头 / 旧 gateway。 */
  next_before?: string;
}

/** `hasEarlier` 的唯一推导（§4.3）：本地窗口还有上一条，或服务端还有上一页。 */
export function windowHasEarlier(window: SessionDetailWindow | null): boolean {
  return window !== null && (window.start > 0 || window.next_before !== undefined);
}

export interface SessionLoadOptions {
  /** Bypass the "already loaded" guard (poll / explicit refresh). */
  force?: boolean;
  /** Connection epoch; a new epoch invalidates the cached detail. */
  epoch?: number;
  /** New sessions may 404 before their first message is persisted. */
  allowMissing?: boolean;
  /** 本次请求的页大小；缺省 `TRANSCRIPT_WINDOW`。 */
  message_limit?: number;
  /** 前页游标；提供时按「加载更早」处理（前插到当前窗口）。 */
  before?: string;
}

interface SessionStoreState {
  sessions: readonly SessionInfo[];
  selectedId: string | null;
  /** Current session detail; stale data is kept when a refresh fails. */
  detail: SessionDetail | null;
  /** `detail.messages` 在完整会话中的绝对窗口。 */
  detailWindow: SessionDetailWindow | null;
  /** List request in flight. */
  loading: boolean;
  /** Last list error; stale `sessions` remain available. */
  error: string | null;
  /** True once a list request succeeded (distinguishes empty from never loaded). */
  loaded: boolean;
  /** Detail request in flight for `detailId`. */
  detailLoading: boolean;
  /** Last detail error for `detailId`; stale `detail` remains available. */
  detailError: string | null;
  /** “加载更早”请求在途。 */
  earlierLoading: boolean;
  /** “加载更早”最近一次失败；成功后清空。 */
  earlierError: string | null;
  /** 历史前缀被改写的一次性提示（i18n key）；null = 无。 */
  detailNotice: string | null;
  /** Session id the current detail / error belongs to. */
  detailId: string | null;
  loadSessions: (client: GatewayClient, options?: SessionLoadOptions) => Promise<void>;
  select: (id: string | null) => void;
  loadDetail: (client: GatewayClient, id: string, options?: SessionLoadOptions) => Promise<void>;
  /** 本地窗口耗尽后取 `next_before` 上一页并前插。 */
  loadEarlier: (
    client: GatewayClient,
    id: string,
    options?: Omit<SessionLoadOptions, 'before'>,
  ) => Promise<void>;
  /** session.rewound / message.compaction：丢弃更早页并重取尾页。 */
  reloadAfterHistoryChange: (client: GatewayClient, id: string) => Promise<void>;
  dismissDetailNotice: () => void;
  /** Refresh the list and the selected session detail. */
  refresh: (client: GatewayClient, options?: SessionLoadOptions) => Promise<void>;
  /** Optimistic local rename; the caller reloads (or rolls back) afterwards. */
  renameSession: (id: string, title: string) => void;
  /** Optimistic local removal; the caller reloads afterwards. */
  removeSession: (id: string) => void;
  setSessions: (sessions: readonly SessionInfo[]) => void;
  reset: () => void;
}

const LIST_GENERATION = 'session:list';
const DETAIL_GENERATION = 'session:detail';

/** Stable client identity for "already loaded for this connection" checks. */
const clientIds = new WeakMap<GatewayClient, number>();
let nextClientId = 1;

interface CachedDetail {
  detail: SessionDetail;
  window: SessionDetailWindow;
  notice: string | null;
}

let listLoadedFor: string | null = null;
let detailLoadedFor: string | null = null;
let listInFlight: { key: string; promise: Promise<void> } | null = null;
let detailInFlight: { key: string; promise: Promise<void> } | null = null;
/** “加载更早”按 `key|cursor` 去重。 */
let earlierInFlight: { key: string; promise: Promise<void> } | null = null;
/** Successful details per `client|session|epoch`; keeps switch-back instant. */
const DETAIL_CACHE_LIMIT = 50;
const detailCache = new Map<string, CachedDetail>();

function readCachedDetail(key: string): CachedDetail | undefined {
  const data = detailCache.get(key);
  if (data !== undefined) {
    // Refresh insertion order so the least-recently-used entry is evicted first.
    detailCache.delete(key);
    detailCache.set(key, data);
  }
  return data;
}

function writeCachedDetail(key: string, data: CachedDetail): void {
  detailCache.delete(key);
  detailCache.set(key, data);
  while (detailCache.size > DETAIL_CACHE_LIMIT) {
    const oldest = detailCache.keys().next().value;
    if (oldest === undefined) break;
    detailCache.delete(oldest);
  }
}

/** 作废某会话的全部缓存（含其它 epoch / 在途请求）。 */
function invalidateDetailCacheFor(sessionId: string): void {
  for (const key of [...detailCache.keys()]) {
    const [, id] = key.split('|');
    if (id === sessionId) detailCache.delete(key);
  }
  if (detailLoadedFor !== null && detailLoadedFor.split('|')[1] === sessionId) {
    detailLoadedFor = null;
  }
  if (detailInFlight !== null && detailInFlight.key.split('|')[1] === sessionId) {
    detailInFlight = null;
  }
  invalidateGeneration(DETAIL_GENERATION);
}

/** 尾页响应的绝对窗口；旧 gateway 缺 `messages_total` 时按“本次即全量”降级。 */
function tailWindowOf(sessionId: string, detail: SessionDetail): SessionDetailWindow {
  const rawTotal = detail.messages_total;
  const total =
    typeof rawTotal === 'number' && Number.isInteger(rawTotal) && rawTotal >= detail.messages.length
      ? rawTotal
      : detail.messages.length;
  const start = Math.max(0, total - detail.messages.length);
  const next =
    start > 0 && typeof detail.next_before === 'string' && detail.next_before.length > 0
      ? detail.next_before
      : undefined;
  return { sessionId, start, end: total, ...(next !== undefined ? { next_before: next } : {}) };
}

/**
 * 刷新合并（§4.3）：
 * - 尾页起点落在当前窗口内 → 保留 `[start, tailStart)` 前缀 + 新尾页；
 * - 中间有洞（`tailStart > end`）、总长回退、或新尾页比当前窗口更早 → 丢弃更早页。
 * 前缀是否真的没变由下一次 `before` 的锚点校验兜底。
 */
function mergeTailPage(
  sessionId: string,
  page: SessionDetail,
  cached: CachedDetail | undefined,
): CachedDetail {
  const nextWindow = tailWindowOf(sessionId, page);
  if (cached === undefined || cached.window.sessionId !== sessionId) {
    return { detail: page, window: nextWindow, notice: cached?.notice ?? null };
  }
  const old = cached.window;
  if (nextWindow.end < old.end || nextWindow.start > old.end || nextWindow.start < old.start) {
    return { detail: page, window: nextWindow, notice: cached.notice };
  }
  const prefix = cached.detail.messages.slice(0, nextWindow.start - old.start);
  const detail: SessionDetail = {
    ...page,
    messages: prefix.concat(page.messages),
    messages_total: nextWindow.end,
  };
  if (old.next_before === undefined) delete detail.next_before;
  else detail.next_before = old.next_before;
  return {
    detail,
    window: {
      sessionId,
      start: old.start,
      end: nextWindow.end,
      ...(old.next_before !== undefined ? { next_before: old.next_before } : {}),
    },
    notice: cached.notice,
  };
}

/**
 * 「加载更早」前插。返回 null = 不能安全前插（尾部被截断 / 没有前进），
 * 调用方丢弃更早页并重取尾页。
 */
function mergeEarlierPage(
  sessionId: string,
  page: SessionDetail,
  cached: CachedDetail,
): CachedDetail | null {
  const old = cached.window;
  if (old.sessionId !== sessionId) return null;
  // 锚点通过后仍可能遇到尾部被截断（rewind 落在窗口内）：total < end。
  if (typeof page.messages_total === 'number' && page.messages_total < old.end) return null;
  if (page.messages.length === 0) return null;
  const start = Math.max(0, old.start - page.messages.length);
  if (start === old.start) return null;
  const detail: SessionDetail = {
    ...cached.detail,
    messages: page.messages.concat(cached.detail.messages),
  };
  if (typeof page.messages_total === 'number') detail.messages_total = page.messages_total;
  const next =
    start > 0 && typeof page.next_before === 'string' && page.next_before.length > 0
      ? page.next_before
      : undefined;
  if (next === undefined) delete detail.next_before;
  else detail.next_before = next;
  return {
    detail,
    window: {
      sessionId,
      start,
      end: old.end,
      ...(next !== undefined ? { next_before: next } : {}),
    },
    notice: cached.notice,
  };
}

function clientKey(client: GatewayClient): number {
  const known = clientIds.get(client);
  if (known !== undefined) return known;
  const id = nextClientId++;
  clientIds.set(client, id);
  return id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (code === 'not_found') return true;
  return errorMessage(error).startsWith('not_found:');
}

function resetModuleState(): void {
  invalidateGeneration(LIST_GENERATION);
  invalidateGeneration(DETAIL_GENERATION);
  listLoadedFor = null;
  detailLoadedFor = null;
  listInFlight = null;
  detailInFlight = null;
  earlierInFlight = null;
  detailCache.clear();
}

const initialState = {
  sessions: [] as readonly SessionInfo[],
  selectedId: null as string | null,
  detail: null as SessionDetail | null,
  detailWindow: null as SessionDetailWindow | null,
  loading: false,
  error: null as string | null,
  loaded: false,
  detailLoading: false,
  detailError: null as string | null,
  earlierLoading: false,
  earlierError: null as string | null,
  detailNotice: null as string | null,
  detailId: null as string | null,
};

export const useSessionStore = create<SessionStoreState>()((set, get) => ({
  ...initialState,

  loadSessions: async (client, options = {}) => {
    const { force = false, epoch = 0 } = options;
    const key = `${clientKey(client)}|${epoch}`;
    if (!force && listLoadedFor === key) return;
    if (listInFlight?.key === key) return listInFlight.promise;

    const generation = nextGeneration(LIST_GENERATION);
    set({ loading: true, error: null });
    const promise = (async () => {
      try {
        const data = await client.listSessions();
        if (!isCurrentGeneration(LIST_GENERATION, generation)) return;
        listLoadedFor = key;
        set({ sessions: data, loading: false, error: null, loaded: true });
      } catch (error) {
        if (!isCurrentGeneration(LIST_GENERATION, generation)) return;
        // Stale sessions stay visible; only `error` changes.
        set({ loading: false, error: errorMessage(error) });
      }
    })();
    listInFlight = { key, promise };
    void promise.finally(() => {
      if (listInFlight?.promise === promise) listInFlight = null;
    });
    return promise;
  },

  select: (id) => {
    if (get().selectedId === id) return;
    // Drop the transient detail flags; the previous detail is kept for stale
    // rendering but is gated by `detailId` in the view.
    set({
      selectedId: id,
      // 一次性提示只属于上一个会话的历史改写，切走即清，避免串到新会话。
      detailNotice: null,
      detailLoading: false,
      detailError: null,
      earlierLoading: false,
      earlierError: null,
    });
  },

  loadDetail: async (client, id, options = {}) => {
    const { force = false, epoch = 0, allowMissing = false, message_limit, before } = options;
    const key = `${clientKey(client)}|${id}|${epoch}`;
    const limit = message_limit ?? TRANSCRIPT_WINDOW;

    // ── 加载更早：前插到当前连续窗口 ──
    if (before !== undefined) {
      const inFlightKey = `${key}|${before}`;
      if (earlierInFlight?.key === inFlightKey) return earlierInFlight.promise;

      const generation = nextGeneration(DETAIL_GENERATION);
      set({ earlierLoading: true, earlierError: null });
      const promise = (async () => {
        try {
          const page = await client.getSession(id, { message_limit: limit, before });
          if (!isCurrentGeneration(DETAIL_GENERATION, generation)) return;
          if (get().selectedId !== id) return;
          const cached = readCachedDetail(key);
          const merged = cached === undefined ? null : mergeEarlierPage(id, page, cached);
          if (merged === null) {
            // 尾部被截断 / 窗口没有前进：丢弃更早页，重取尾页。
            detailCache.delete(key);
            detailLoadedFor = null;
            await get().loadDetail(client, id, { force: true, epoch, message_limit: limit });
            return;
          }
          writeCachedDetail(key, merged);
          detailLoadedFor = key;
          set({
            detail: merged.detail,
            detailWindow: merged.window,
            detailNotice: merged.notice,
            detailId: id,
            earlierLoading: false,
            earlierError: null,
          });
        } catch (error) {
          if (!isCurrentGeneration(DETAIL_GENERATION, generation)) return;
          if (get().selectedId !== id) return;
          if (isHistoryChangedError(error)) {
            // 一次性提示 + 丢弃更早页 + 重取尾页。
            set((state) => ({
              earlierLoading: false,
              earlierError: null,
              detailNotice: state.detailNotice ?? HISTORY_CHANGED_NOTICE,
            }));
            detailCache.delete(key);
            detailLoadedFor = null;
            await get().loadDetail(client, id, { force: true, epoch, message_limit: limit });
            return;
          }
          set({ earlierLoading: false, earlierError: errorMessage(error) });
        }
      })();
      earlierInFlight = { key: inFlightKey, promise };
      void promise.finally(() => {
        if (earlierInFlight?.promise !== promise) return;
        earlierInFlight = null;
        if (get().earlierLoading) set({ earlierLoading: false });
      });
      return promise;
    }

    // ── 尾页：首屏 / 刷新 ──
    if (!force) {
      if (detailLoadedFor === key && get().detailId === id && get().detailError === null) {
        return;
      }
      // Switching back to a session already loaded in this epoch must not refetch.
      const cached = readCachedDetail(key);
      if (cached !== undefined) {
        detailLoadedFor = key;
        set({
          detail: cached.detail,
          detailWindow: cached.window,
          detailNotice: cached.notice,
          detailId: id,
          detailLoading: false,
          detailError: null,
          earlierError: null,
        });
        return;
      }
    }
    if (detailInFlight?.key === key) return detailInFlight.promise;

    const generation = nextGeneration(DETAIL_GENERATION);
    set({ detailId: id, detailLoading: true, detailError: null });
    const promise = (async () => {
      try {
        const page = await client.getSession(id, { message_limit: limit });
        if (!isCurrentGeneration(DETAIL_GENERATION, generation)) return;
        if (get().selectedId !== id) return;
        const merged = mergeTailPage(id, page, readCachedDetail(key));
        // 冲突提示跨“重取尾页”保留：缓存里没有时沿用当前一次性提示。
        merged.notice = merged.notice ?? get().detailNotice;
        detailLoadedFor = key;
        writeCachedDetail(key, merged);
        set({
          detail: merged.detail,
          detailWindow: merged.window,
          detailNotice: merged.notice,
          detailId: id,
          detailLoading: false,
          detailError: null,
          earlierError: null,
        });
      } catch (error) {
        if (!isCurrentGeneration(DETAIL_GENERATION, generation)) return;
        if (get().selectedId !== id) return;
        // A failed refresh must not serve the previous success to switch-back.
        detailCache.delete(key);
        if (isNotFound(error)) {
          if (allowMissing) {
            detailLoadedFor = key;
            const empty: SessionDetail = { session_id: id, messages: [] };
            const emptyWindow: SessionDetailWindow = { sessionId: id, start: 0, end: 0 };
            writeCachedDetail(key, { detail: empty, window: emptyWindow, notice: null });
            set({
              detail: empty,
              detailWindow: emptyWindow,
              detailId: id,
              detailLoading: false,
              detailError: null,
              earlierError: null,
            });
            return;
          }
          set({
            detailId: id,
            detailLoading: false,
            detailError: SESSION_NOT_FOUND_MESSAGE,
          });
          return;
        }
        set({ detailId: id, detailLoading: false, detailError: errorMessage(error) });
      }
    })();
    detailInFlight = { key, promise };
    void promise.finally(() => {
      if (detailInFlight?.promise === promise) detailInFlight = null;
    });
    return promise;
  },

  loadEarlier: async (client, id, options = {}) => {
    const window = get().detailWindow;
    if (window === null || window.sessionId !== id || window.next_before === undefined) return;
    await get().loadDetail(client, id, { ...options, before: window.next_before });
  },

  reloadAfterHistoryChange: async (client, id) => {
    // 缓存（含更早页）全部作废；正在翻页的请求也一并失效。
    invalidateDetailCacheFor(id);
    if (get().selectedId !== id) return;
    // 强制重取尾页：mergeTailPage 读不到旧窗口，等价于“丢弃更早页”。
    await get().loadDetail(client, id, { force: true });
  },

  dismissDetailNotice: () => set({ detailNotice: null }),

  refresh: async (client, options = {}) => {
    const { selectedId } = get();
    const tasks: Promise<void>[] = [get().loadSessions(client, { ...options, force: true })];
    if (selectedId) {
      tasks.push(get().loadDetail(client, selectedId, { ...options, force: true }));
    }
    await Promise.all(tasks);
  },

  renameSession: (id, title) => {
    set((state) => ({ sessions: renameSessionInList(state.sessions, id, title) }));
  },

  removeSession: (id) => {
    set((state) => ({ sessions: removeSessionFromList(state.sessions, id) }));
  },

  setSessions: (sessions) => set({ sessions }),

  reset: () => {
    resetModuleState();
    set({ ...initialState });
  },
}));
