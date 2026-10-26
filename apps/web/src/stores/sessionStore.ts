/**
 * Session domain store: single source for the session list, the selected id
 * and the current session detail.
 *
 * ChatView drives selection from the route and fetches through `GatewayClient`;
 * `SessionList` renders the same snapshot. Real-time event state (snapshot,
 * streaming chunks, group cache) stays in `state/events.ts` / `event-store.ts`
 * and is deliberately not copied here.
 */
import { create } from 'zustand';
import type { GatewayClient } from '../gateway/client';
import type { SessionDetail, SessionInfo } from '../gateway/types';
import { removeSessionFromList, renameSessionInList } from '../state/sessions';
import { invalidateGeneration, isCurrentGeneration, nextGeneration } from './store-resource';

/** Sentinel error so ChatView can distinguish a deleted session from a real failure. */
export const SESSION_NOT_FOUND_MESSAGE = 'chat.notFound';

export interface SessionLoadOptions {
  /** Bypass the "already loaded" guard (poll / explicit refresh). */
  force?: boolean;
  /** Connection epoch; a new epoch invalidates the cached detail. */
  epoch?: number;
  /** New sessions may 404 before their first message is persisted. */
  allowMissing?: boolean;
}

interface SessionStoreState {
  sessions: readonly SessionInfo[];
  selectedId: string | null;
  /** Current session detail; stale data is kept when a refresh fails. */
  detail: SessionDetail | null;
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
  /** Session id the current detail / error belongs to. */
  detailId: string | null;
  loadSessions: (client: GatewayClient, options?: SessionLoadOptions) => Promise<void>;
  select: (id: string | null) => void;
  loadDetail: (client: GatewayClient, id: string, options?: SessionLoadOptions) => Promise<void>;
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

let listLoadedFor: string | null = null;
let detailLoadedFor: string | null = null;
let listInFlight: { key: string; promise: Promise<void> } | null = null;
let detailInFlight: { key: string; promise: Promise<void> } | null = null;
/** Successful details per `client|session|epoch`; keeps switch-back instant. */
const DETAIL_CACHE_LIMIT = 50;
const detailCache = new Map<string, SessionDetail>();

function readCachedDetail(key: string): SessionDetail | undefined {
  const data = detailCache.get(key);
  if (data !== undefined) {
    // Refresh insertion order so the least-recently-used entry is evicted first.
    detailCache.delete(key);
    detailCache.set(key, data);
  }
  return data;
}

function writeCachedDetail(key: string, data: SessionDetail): void {
  detailCache.delete(key);
  detailCache.set(key, data);
  while (detailCache.size > DETAIL_CACHE_LIMIT) {
    const oldest = detailCache.keys().next().value;
    if (oldest === undefined) break;
    detailCache.delete(oldest);
  }
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
  detailCache.clear();
}

const initialState = {
  sessions: [] as readonly SessionInfo[],
  selectedId: null as string | null,
  detail: null as SessionDetail | null,
  loading: false,
  error: null as string | null,
  loaded: false,
  detailLoading: false,
  detailError: null as string | null,
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
    set({ selectedId: id, detailLoading: false, detailError: null });
  },

  loadDetail: async (client, id, options = {}) => {
    const { force = false, epoch = 0, allowMissing = false } = options;
    const key = `${clientKey(client)}|${id}|${epoch}`;
    if (!force) {
      if (detailLoadedFor === key && get().detailId === id && get().detailError === null) {
        return;
      }
      // Switching back to a session already loaded in this epoch must not refetch.
      const cached = readCachedDetail(key);
      if (cached !== undefined) {
        detailLoadedFor = key;
        set({ detail: cached, detailId: id, detailLoading: false, detailError: null });
        return;
      }
    }
    if (detailInFlight?.key === key) return detailInFlight.promise;

    const generation = nextGeneration(DETAIL_GENERATION);
    set({ detailId: id, detailLoading: true, detailError: null });
    const promise = (async () => {
      try {
        const data = await client.getSession(id);
        if (!isCurrentGeneration(DETAIL_GENERATION, generation)) return;
        if (get().selectedId !== id) return;
        detailLoadedFor = key;
        writeCachedDetail(key, data);
        set({ detail: data, detailId: id, detailLoading: false, detailError: null });
      } catch (error) {
        if (!isCurrentGeneration(DETAIL_GENERATION, generation)) return;
        if (get().selectedId !== id) return;
        // A failed refresh must not serve the previous success to switch-back.
        detailCache.delete(key);
        if (isNotFound(error)) {
          if (allowMissing) {
            detailLoadedFor = key;
            const empty: SessionDetail = { session_id: id, messages: [] };
            writeCachedDetail(key, empty);
            set({ detail: empty, detailId: id, detailLoading: false, detailError: null });
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
