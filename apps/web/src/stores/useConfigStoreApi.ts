/**
 * React binding for configStore. Kept separate from the pure store so store
 * unit tests do not load ConnectionProvider (which reads `window` at module
 * scope).
 */
import { useCallback, useEffect } from 'react';
import { useConnection } from '../gateway/ConnectionProvider';
import type { CapabilityManifest, ConfigResponse, ConfigSourcesResponse } from '../gateway/types';
import { type ResourceState, resourceData } from '../state/useResource';
import { type PermissionArrays, useConfigStore } from './configStore';
import { usePolledAction } from './usePolledAction';

export interface UseConfigStoreOptions {
  /** Load `config.get` (default true). */
  config?: boolean;
  /** Load `capabilities.list`. */
  capabilities?: boolean;
  /** Load `config.sources`. */
  sources?: boolean;
  /** Refresh config snapshot on this interval (manual force reload). */
  pollMs?: number;
}

export interface ConfigStoreApi {
  config: ResourceState<ConfigResponse>;
  sources: ResourceState<ConfigSourcesResponse>;
  capabilities: ResourceState<CapabilityManifest>;
  reloadConfig: () => void;
  /** Force-reload and resolve with the snapshot that landed (or undefined when offline). */
  reloadConfigAsync: () => Promise<ConfigResponse | undefined>;
  reloadSources: () => void;
  reloadCapabilities: () => void;
  applyPermissionLists: (lists: PermissionArrays) => void;
}

export function useConfigStoreApi(options: UseConfigStoreOptions = {}): ConfigStoreApi {
  const { client, hasToken, epoch } = useConnection();
  const loadConfigEnabled = options.config !== false;
  const loadCapabilitiesEnabled = options.capabilities === true;
  const loadSourcesEnabled = options.sources === true;
  const pollMs = options.pollMs;

  const config = useConfigStore((state) => state.config);
  const sources = useConfigStore((state) => state.sources);
  const capabilities = useConfigStore((state) => state.capabilities);

  useEffect(() => {
    if (!hasToken || !loadConfigEnabled) return;
    void useConfigStore.getState().loadConfig(client, { epoch });
  }, [client, epoch, hasToken, loadConfigEnabled]);

  usePolledAction(
    () => {
      if (!hasToken) return;
      void useConfigStore.getState().loadCapabilities(client);
    },
    {
      enabled: hasToken && loadCapabilitiesEnabled,
      deps: [epoch, hasToken],
    },
  );

  usePolledAction(
    () => {
      if (!hasToken) return;
      void useConfigStore.getState().loadSources(client);
    },
    {
      enabled: hasToken && loadSourcesEnabled,
      deps: [epoch, hasToken],
    },
  );

  usePolledAction(
    () => {
      if (!hasToken) return;
      void useConfigStore.getState().loadConfig(client, { epoch, force: true });
    },
    {
      enabled: hasToken && loadConfigEnabled && pollMs !== undefined,
      ...(pollMs !== undefined ? { pollMs } : {}),
      deps: [epoch, hasToken],
    },
  );

  const reloadConfigAsync = useCallback(async (): Promise<ConfigResponse | undefined> => {
    if (!hasToken) return undefined;
    await useConfigStore.getState().loadConfig(client, { epoch, force: true });
    return resourceData(useConfigStore.getState().config);
  }, [client, epoch, hasToken]);

  const reloadConfig = useCallback(() => {
    void reloadConfigAsync();
  }, [reloadConfigAsync]);

  const reloadSources = useCallback(() => {
    if (!hasToken) return;
    void useConfigStore.getState().loadSources(client, { force: true });
  }, [client, hasToken]);

  const reloadCapabilities = useCallback(() => {
    if (!hasToken) return;
    void useConfigStore.getState().loadCapabilities(client, { force: true });
  }, [client, hasToken]);

  return {
    config,
    sources,
    capabilities,
    reloadConfig,
    reloadConfigAsync,
    reloadSources,
    reloadCapabilities,
    applyPermissionLists: useConfigStore.getState().applyPermissionLists,
  };
}
