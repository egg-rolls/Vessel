/**
 * Run domain store: live/durable runs and diagnostics, keyed by node.
 *
 * Panels read the same per-node `ResourceState` contract as `state/useResource`
 * (a refresh keeps the previous data, a failure keeps stale data + error code).
 * A per-node generation guard keeps an older poll from overwriting a newer one.
 */
import { create } from 'zustand';
import type { GatewayClient } from '../gateway/client';
import type { NodeView } from '../gateway/NodeProvider';
import { nodeKeyOf } from '../gateway/nodes';
import type { DurableRunSummary, HealthResponse, RunEvent, RunStatus } from '../gateway/types';
import { DIAGNOSTIC_EVENT_TYPES } from '../state/diagnostics';
import type { ResourceState } from '../state/useResource';
import {
  beginStoreLoad,
  invalidateGeneration,
  isCurrentGeneration,
  nextGeneration,
  storeFailure,
  storeSuccess,
} from './store-resource';

/** Which run list a load targets. */
export type RunListKind = 'live' | 'durable';

/** Which half of the diagnostics resource a load targets. */
export type DiagnosticSource = 'health' | 'events';

export interface NodeRunResources {
  live: ResourceState<RunStatus[]>;
  durable: ResourceState<DurableRunSummary[]>;
}

export interface NodeDiagnosticsResources {
  health: ResourceState<HealthResponse>;
  events: ResourceState<RunEvent[]>;
}

interface RunStoreState {
  runsByNode: Record<string, NodeRunResources>;
  diagnosticsByNode: Record<string, NodeDiagnosticsResources>;
  /** Load one node's live or durable run list. Defaults to `live`. */
  loadRuns: (
    client: GatewayClient,
    node: Pick<NodeView, 'name' | 'nodeId'>,
    kind?: RunListKind,
  ) => Promise<void>;
  /** Load one node's runtime health and/or diagnostic events. Defaults to both. */
  loadDiagnostics: (
    client: GatewayClient,
    node: Pick<NodeView, 'name' | 'nodeId'>,
    source?: DiagnosticSource | 'both',
  ) => Promise<void>;
  reset: () => void;
}

type StateSetter = (updater: (state: RunStoreState) => Partial<RunStoreState>) => void;

function runGenerationKey(nodeKey: string, kind: RunListKind): string {
  return `run:${kind}:${nodeKey}`;
}

function diagnosticsGenerationKey(nodeKey: string, source: DiagnosticSource): string {
  return `diagnostics:${source}:${nodeKey}`;
}

function emptyRuns(): NodeRunResources {
  return { live: { status: 'idle' }, durable: { status: 'idle' } };
}

function emptyDiagnostics(): NodeDiagnosticsResources {
  return { health: { status: 'idle' }, events: { status: 'idle' } };
}

/** Shared load pipeline: reserve a generation, keep stale data, gate the write. */
async function loadResource<T>(
  set: StateSetter,
  generationKey: string,
  previous: ResourceState<T> | undefined,
  commit: (state: RunStoreState, next: ResourceState<T>) => Partial<RunStoreState>,
  fetchData: () => Promise<T>,
): Promise<void> {
  const generation = nextGeneration(generationKey);
  set((state) => commit(state, beginStoreLoad(previous)));
  try {
    const data = await fetchData();
    if (!isCurrentGeneration(generationKey, generation)) return;
    set((state) => commit(state, storeSuccess(data)));
  } catch (error) {
    if (!isCurrentGeneration(generationKey, generation)) return;
    set((state) => commit(state, storeFailure(previous, error)));
  }
}

export const useRunStore = create<RunStoreState>()((set, get) => {
  const loadHealth = (
    client: GatewayClient,
    nodeKey: string,
    generationKey: string,
  ): Promise<void> => {
    const previous = get().diagnosticsByNode[nodeKey]?.health;
    return loadResource<HealthResponse>(
      set,
      generationKey,
      previous,
      (state, next) => {
        const entry = state.diagnosticsByNode[nodeKey] ?? emptyDiagnostics();
        return {
          diagnosticsByNode: {
            ...state.diagnosticsByNode,
            [nodeKey]: { ...entry, health: next },
          },
        };
      },
      () => client.getHealth(),
    );
  };

  const loadEvents = (
    client: GatewayClient,
    nodeKey: string,
    generationKey: string,
  ): Promise<void> => {
    const previous = get().diagnosticsByNode[nodeKey]?.events;
    return loadResource<RunEvent[]>(
      set,
      generationKey,
      previous,
      (state, next) => {
        const entry = state.diagnosticsByNode[nodeKey] ?? emptyDiagnostics();
        return {
          diagnosticsByNode: {
            ...state.diagnosticsByNode,
            [nodeKey]: { ...entry, events: next },
          },
        };
      },
      () => client.readEvents({ types: [...DIAGNOSTIC_EVENT_TYPES], limit: 200 }),
    );
  };

  return {
    runsByNode: {},
    diagnosticsByNode: {},

    loadRuns: async (client, node, kind = 'live') => {
      const nodeKey = nodeKeyOf(node);
      if (kind === 'durable') {
        const previous = get().runsByNode[nodeKey]?.durable;
        await loadResource<DurableRunSummary[]>(
          set,
          runGenerationKey(nodeKey, 'durable'),
          previous,
          (state, next) => {
            const entry = state.runsByNode[nodeKey] ?? emptyRuns();
            return {
              runsByNode: {
                ...state.runsByNode,
                [nodeKey]: { ...entry, durable: next },
              },
            };
          },
          () => client.listDurableRuns({ limit: 200 }),
        );
        return;
      }
      const previous = get().runsByNode[nodeKey]?.live;
      await loadResource<RunStatus[]>(
        set,
        runGenerationKey(nodeKey, 'live'),
        previous,
        (state, next) => {
          const entry = state.runsByNode[nodeKey] ?? emptyRuns();
          return {
            runsByNode: {
              ...state.runsByNode,
              [nodeKey]: { ...entry, live: next },
            },
          };
        },
        () => client.listRuns(),
      );
    },

    loadDiagnostics: async (client, node, source = 'both') => {
      const nodeKey = nodeKeyOf(node);
      const loads: Promise<void>[] = [];
      if (source !== 'events') {
        loads.push(loadHealth(client, nodeKey, diagnosticsGenerationKey(nodeKey, 'health')));
      }
      if (source !== 'health') {
        loads.push(loadEvents(client, nodeKey, diagnosticsGenerationKey(nodeKey, 'events')));
      }
      await Promise.all(loads);
    },

    reset: () => {
      const state = get();
      for (const nodeKey of Object.keys(state.runsByNode)) {
        invalidateGeneration(runGenerationKey(nodeKey, 'live'));
        invalidateGeneration(runGenerationKey(nodeKey, 'durable'));
      }
      for (const nodeKey of Object.keys(state.diagnosticsByNode)) {
        invalidateGeneration(diagnosticsGenerationKey(nodeKey, 'health'));
        invalidateGeneration(diagnosticsGenerationKey(nodeKey, 'events'));
      }
      set({ runsByNode: {}, diagnosticsByNode: {} });
    },
  };
});

/** Read one node's run lists without subscribing to other nodes. */
export function useNodeRuns(
  node: Pick<NodeView, 'name' | 'nodeId'> | null,
): NodeRunResources | undefined {
  return useRunStore((state) => (node ? state.runsByNode[nodeKeyOf(node)] : undefined));
}

/** Read one node's diagnostics without subscribing to other nodes. */
export function useNodeDiagnostics(
  node: Pick<NodeView, 'name' | 'nodeId'> | null,
): NodeDiagnosticsResources | undefined {
  return useRunStore((state) => (node ? state.diagnosticsByNode[nodeKeyOf(node)] : undefined));
}
