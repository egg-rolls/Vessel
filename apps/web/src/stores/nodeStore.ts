/**
 * Node domain store.
 *
 * Owns the node list (current WS node + sessionStorage extras), the selected
 * node and the last `health.get` result per node. NodeProvider is the only
 * writer: it feeds connection changes and persisted extras in, while panels
 * read nodes / health from here.
 */
import { create } from 'zustand';
import type { NodeView } from '../gateway/NodeProvider';
import type { NodeConfig } from '../gateway/nodes';
import { nodeKeyOf } from '../gateway/nodes';
import type { HealthResponse, HelloInfo } from '../gateway/types';
import { displayGatewayUrl } from '../gateway/url';
import { invalidateGeneration, isCurrentGeneration, nextGeneration } from './store-resource';

export interface NodeHealthEntry {
  node: NodeView;
  health?: HealthResponse;
  error?: string;
  updatedAt?: number;
}

interface NodeStoreState {
  extras: NodeView[];
  nodes: NodeView[];
  current: NodeView | null;
  health: Record<string, NodeHealthEntry>;
  selectedKey: string | null;
  /** Bridge from ConnectionProvider: current node identity / token availability. */
  setConnection: (input: {
    hasToken: boolean;
    hello: HelloInfo | null;
    gatewayUrl: string;
  }) => void;
  setExtras: (extras: readonly NodeConfig[]) => void;
  addExtra: (config: NodeConfig) => void;
  removeExtra: (name: string) => void;
  select: (nodeKey: string | null) => void;
  loadHealth: (
    nodes: readonly NodeView[],
    fetchHealth: (node: NodeView) => Promise<HealthResponse>,
  ) => Promise<void>;
  reset: () => void;
}

function pageOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

function extraViews(extras: readonly NodeConfig[]): NodeView[] {
  return extras.map((node) => ({ ...node, current: false }));
}

function currentView(input: {
  hasToken: boolean;
  hello: HelloInfo | null;
  gatewayUrl: string;
}): NodeView | null {
  if (!input.hasToken) return null;
  const info = input.hello?.node;
  const name =
    info?.name?.trim() || info?.node_id || displayGatewayUrl(input.gatewayUrl, pageOrigin());
  return {
    name,
    url: input.gatewayUrl,
    ...(info?.node_id ? { nodeId: info.node_id } : {}),
    current: true,
  };
}

export const useNodeStore = create<NodeStoreState>()((set, get) => ({
  extras: [],
  nodes: [],
  current: null,
  health: {},
  selectedKey: null,

  setConnection: (input) => {
    const current = currentView(input);
    const extras = get().extras;
    set({
      current,
      nodes: current ? [current, ...extras] : [...extras],
    });
  },

  setExtras: (extras) => {
    const views = extraViews(extras);
    const current = get().current;
    set({
      extras: views,
      nodes: current ? [current, ...views] : [...views],
    });
  },

  addExtra: (config) => {
    const existing = get().extras.filter((node) => node.name !== config.name);
    const next = [...existing, { ...config, current: false }];
    const current = get().current;
    set({ extras: next, nodes: current ? [current, ...next] : [...next] });
  },

  removeExtra: (name) => {
    const next = get().extras.filter((node) => node.name !== name);
    const current = get().current;
    set({ extras: next, nodes: current ? [current, ...next] : [...next] });
  },

  select: (nodeKey) => set({ selectedKey: nodeKey }),

  loadHealth: async (nodes, fetchHealth) => {
    if (nodes.length === 0) return;
    const generation = nextGeneration('node:health');
    set((state) => {
      const health = { ...state.health };
      for (const node of nodes) {
        const key = nodeKeyOf(node);
        health[key] = { node, ...(health[key]?.health ? { health: health[key].health } : {}) };
      }
      return { health };
    });
    const entries = await Promise.all(
      nodes.map(async (node): Promise<NodeHealthEntry> => {
        try {
          const health = await fetchHealth(node);
          return { node, health, updatedAt: Date.now() };
        } catch (error) {
          return { node, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    if (!isCurrentGeneration('node:health', generation)) return;
    set((state) => {
      const health = { ...state.health };
      for (const entry of entries) health[nodeKeyOf(entry.node)] = entry;
      return { health };
    });
  },

  reset: () => {
    invalidateGeneration('node:health');
    set({ extras: [], nodes: [], current: null, health: {}, selectedKey: null });
  },
}));

export function nodeHealthEntry(
  health: Record<string, NodeHealthEntry>,
  node: Pick<NodeConfig, 'name' | 'nodeId'>,
): NodeHealthEntry | undefined {
  return health[nodeKeyOf(node)];
}

export function nodeHealthNames(health: Record<string, NodeHealthEntry>): Map<string, string> {
  const names = new Map<string, string>();
  for (const [key, entry] of Object.entries(health)) {
    const name = entry.health?.node.name?.trim();
    if (name) names.set(key, name);
  }
  return names;
}

export function nodeEntryState(
  entry: NodeHealthEntry | undefined,
): 'connected' | 'unreachable' | 'pending' {
  if (!entry) return 'pending';
  if (entry.health) return 'connected';
  if (entry.error) return 'unreachable';
  return 'pending';
}

export type { NodeStoreState };
