/**
 * Interaction domain store: the single source for pending permissions / asks,
 * in-flight response ids and orphaned request ids.
 *
 * `ConnectionProvider` is the only writer (WS events, `interactions.list`
 * hydration, respond lifecycle); the composer slot, Team bar, global pending
 * bar and sidebar counters read this store directly or through
 * `useConnection()`. The pure merge rules stay in `gateway/interaction-hydration`.
 */
import { create } from 'zustand';
import {
  type HydrationSnapshot,
  type InteractionAction,
  type InteractionState,
  interactionReducer,
} from '../gateway/interaction-hydration';
import type { AskUserRequest, PermissionRequest } from '../gateway/types';

export interface InteractionSnapshotInput {
  permissions?: readonly PermissionRequest[];
  asks?: readonly AskUserRequest[];
  orphanedIds?: readonly string[];
}

export interface InteractionStoreState extends InteractionState {
  /** Request ids with an in-flight answer; UI disables their buttons. */
  responding: ReadonlySet<string>;
  /** `interactions.list(status=orphaned)` ids seen during hydration. */
  orphanedIds: readonly string[];
  /** Replace the pending sets (tests / explicit snapshots). */
  setSnapshot: (input: InteractionSnapshotInput) => void;
  /** Apply one incremental reducer action (request / settle / run-finished). */
  dispatch: (action: InteractionAction) => void;
  /** Merge a hydration snapshot and record the server's orphaned ids. */
  hydrate: (
    snapshot: HydrationSnapshot,
    settled: ReadonlySet<string>,
    orphanedIds: readonly string[],
  ) => void;
  /** Mark one request as being answered (true) or settled (false). */
  setResponding: (requestId: string, active: boolean) => void;
  reset: () => void;
}

const EMPTY_RESPONDING: ReadonlySet<string> = new Set();
const EMPTY_ORPHANED: readonly string[] = [];

export const useInteractionStore = create<InteractionStoreState>()((set, get) => ({
  permissions: [],
  asks: [],
  responding: EMPTY_RESPONDING,
  orphanedIds: EMPTY_ORPHANED,

  setSnapshot: (input) => {
    set((state) => ({
      permissions: input.permissions ?? state.permissions,
      asks: input.asks ?? state.asks,
      orphanedIds: input.orphanedIds ?? state.orphanedIds,
    }));
  },

  dispatch: (action) => {
    set((state) => interactionReducer(state, action));
  },

  hydrate: (snapshot, settled, orphanedIds) => {
    set((state) => ({
      ...interactionReducer(state, { type: 'hydrate', snapshot, settled }),
      orphanedIds: [...orphanedIds],
    }));
  },

  setResponding: (requestId, active) => {
    const previous = get().responding;
    if (active) {
      if (previous.has(requestId)) return;
      const next = new Set(previous);
      next.add(requestId);
      set({ responding: next });
      return;
    }
    if (!previous.has(requestId)) return;
    const next = new Set(previous);
    next.delete(requestId);
    set({ responding: next });
  },

  reset: () => {
    set({
      permissions: [],
      asks: [],
      responding: EMPTY_RESPONDING,
      orphanedIds: EMPTY_ORPHANED,
    });
  },
}));
