/**
 * Config domain store: single source for `config.get`, `config.sources` and
 * `capabilities.list`.
 *
 * Tool cards and the tool-policy dialog both read from this store, so a saved
 * policy is reflected in both immediately (applyPermissionLists) without a
 * second `config.get`. All other config consumers (chat visibility, hub,
 * gateway, diagnostics, display settings) share the same snapshot.
 */
import { create } from 'zustand';
import type { GatewayClient } from '../gateway/client';
import type { CapabilityManifest, ConfigResponse, ConfigSourcesResponse } from '../gateway/types';
import { type ResourceState, resourceData } from '../state/useResource';
import {
  beginStoreLoad,
  invalidateGeneration,
  isCurrentGeneration,
  nextGeneration,
  storeFailure,
  storeSuccess,
} from './store-resource';

/** Minimal shape written back after `permissions.setToolPolicy`. */
export interface PermissionArrays {
  autoApprove: readonly string[];
  neverAutoApprove: readonly string[];
}

interface LoadedFor {
  key: string;
}

interface ConfigStoreState {
  config: ResourceState<ConfigResponse>;
  sources: ResourceState<ConfigSourcesResponse>;
  capabilities: ResourceState<CapabilityManifest>;
  configLoadedFor: LoadedFor | null;
  sourcesLoadedFor: LoadedFor | null;
  capabilitiesLoadedFor: LoadedFor | null;
  loadConfig: (
    client: GatewayClient,
    options?: { tenantId?: string; epoch?: number; force?: boolean },
  ) => Promise<void>;
  loadSources: (
    client: GatewayClient,
    options?: { tenantId?: string; force?: boolean },
  ) => Promise<void>;
  loadCapabilities: (client: GatewayClient, options?: { force?: boolean }) => Promise<void>;
  /** Reflect a successful policy write locally; cards + dialog share this state. */
  applyPermissionLists: (lists: PermissionArrays) => void;
  reset: () => void;
}

/** Stable client identity for "already loaded for this connection" checks. */
const clientIds = new WeakMap<GatewayClient, number>();
let nextClientId = 1;

function clientKey(client: GatewayClient): number {
  const known = clientIds.get(client);
  if (known !== undefined) return known;
  const id = nextClientId++;
  clientIds.set(client, id);
  return id;
}

function configKey(client: GatewayClient, tenantId: string | undefined, epoch: number): string {
  return `${clientKey(client)}|${tenantId ?? ''}|${epoch}`;
}

let configInFlight: { key: string; promise: Promise<void> } | null = null;
let sourcesInFlight: { key: string; promise: Promise<void> } | null = null;
let capabilitiesInFlight: { key: string; promise: Promise<void> } | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const useConfigStore = create<ConfigStoreState>()((set, get) => {
  const resetResource = <T>(state: ResourceState<T>): ResourceState<T> =>
    state.status === 'idle' ? state : beginStoreLoad(state);

  return {
    config: { status: 'idle' },
    sources: { status: 'idle' },
    capabilities: { status: 'idle' },
    configLoadedFor: null,
    sourcesLoadedFor: null,
    capabilitiesLoadedFor: null,

    loadConfig: async (client, options = {}) => {
      const { tenantId, epoch = 0, force = false } = options;
      const key = configKey(client, tenantId, epoch);
      const current = get();
      if (!force && current.configLoadedFor?.key === key) return;
      if (configInFlight?.key === key) return configInFlight.promise;

      const previous = current.config;
      const generation = nextGeneration('config');
      set({ config: resetResource(previous) });
      const promise = (async () => {
        try {
          const data = await client.getConfig(tenantId);
          if (!isCurrentGeneration('config', generation)) return;
          set({ config: storeSuccess(data), configLoadedFor: { key } });
        } catch (error) {
          if (!isCurrentGeneration('config', generation)) return;
          set({ config: storeFailure(previous, error) });
        }
      })();
      configInFlight = { key, promise };
      void promise.finally(() => {
        if (configInFlight?.promise === promise) configInFlight = null;
      });
      return promise;
    },

    loadSources: async (client, options = {}) => {
      const { tenantId, force = false } = options;
      const key = configKey(client, tenantId, 0);
      const current = get();
      if (!force && current.sourcesLoadedFor?.key === key) return;
      if (sourcesInFlight?.key === key) return sourcesInFlight.promise;

      const previous = current.sources;
      const generation = nextGeneration('config:sources');
      set({ sources: resetResource(previous) });
      const promise = (async () => {
        try {
          const data = await client.getConfigSources(tenantId);
          if (!isCurrentGeneration('config:sources', generation)) return;
          set({ sources: storeSuccess(data), sourcesLoadedFor: { key } });
        } catch (error) {
          if (!isCurrentGeneration('config:sources', generation)) return;
          set({ sources: storeFailure(previous, error) });
        }
      })();
      sourcesInFlight = { key, promise };
      void promise.finally(() => {
        if (sourcesInFlight?.promise === promise) sourcesInFlight = null;
      });
      return promise;
    },

    loadCapabilities: async (client, options = {}) => {
      const { force = false } = options;
      const key = `capabilities|${clientKey(client)}`;
      if (!force && get().capabilitiesLoadedFor?.key === key) return;
      if (capabilitiesInFlight?.key === key) return capabilitiesInFlight.promise;

      const previous = get().capabilities;
      const generation = nextGeneration('capabilities');
      set({ capabilities: resetResource(previous) });
      const promise = (async () => {
        try {
          const data = await client.getCapabilities();
          if (!isCurrentGeneration('capabilities', generation)) return;
          set({
            capabilities: storeSuccess(data),
            capabilitiesLoadedFor: { key },
          });
        } catch (error) {
          if (!isCurrentGeneration('capabilities', generation)) return;
          set({ capabilities: storeFailure(previous, error) });
        }
      })();
      capabilitiesInFlight = { key, promise };
      void promise.finally(() => {
        if (capabilitiesInFlight?.promise === promise) capabilitiesInFlight = null;
      });
      return promise;
    },

    applyPermissionLists: (lists) => {
      set((state) => {
        const data = resourceData(state.config);
        if (!data) return state;
        const permission = isRecord(data.config.permission) ? data.config.permission : {};
        const next: ConfigResponse = {
          ...data,
          config: {
            ...data.config,
            permission: {
              ...permission,
              autoApprove: [...lists.autoApprove],
              neverAutoApprove: [...lists.neverAutoApprove],
            },
          },
        };
        return {
          config:
            state.config.status === 'success'
              ? storeSuccess(next)
              : { ...state.config, data: next },
        };
      });
    },

    reset: () => {
      invalidateGeneration('config');
      invalidateGeneration('config:sources');
      invalidateGeneration('capabilities');
      configInFlight = null;
      sourcesInFlight = null;
      capabilitiesInFlight = null;
      set({
        config: { status: 'idle' },
        sources: { status: 'idle' },
        capabilities: { status: 'idle' },
        configLoadedFor: null,
        sourcesLoadedFor: null,
        capabilitiesLoadedFor: null,
      });
    },
  };
});
