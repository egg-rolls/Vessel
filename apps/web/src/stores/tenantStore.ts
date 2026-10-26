/**
 * Tenant domain store: the `tenants.list` snapshot and the current tenant id.
 *
 * The connection still owns tenant switching (and `ConnectionProvider` stays
 * the authority for `tenantId`); this store is the shared read source and keeps
 * a mirror of the current id via `select`.
 */
import { create } from 'zustand';
import type { GatewayClient } from '../gateway/client';
import type { TenantInfo } from '../gateway/types';
import type { ResourceState } from '../state/useResource';
import {
  beginStoreLoad,
  invalidateGeneration,
  isCurrentGeneration,
  nextGeneration,
  storeFailure,
  storeSuccess,
} from './store-resource';

interface TenantStoreState {
  tenants: ResourceState<TenantInfo[]>;
  currentId: string | null;
  loadTenants: (client: GatewayClient) => Promise<void>;
  select: (tenantId: string | null) => void;
  reset: () => void;
}

const TENANTS_KEY = 'tenant:list';

export const useTenantStore = create<TenantStoreState>()((set, get) => ({
  tenants: { status: 'idle' },
  currentId: null,

  loadTenants: async (client) => {
    const previous = get().tenants;
    const generation = nextGeneration(TENANTS_KEY);
    set({ tenants: beginStoreLoad(previous) });
    try {
      const tenants = await client.listTenants();
      if (!isCurrentGeneration(TENANTS_KEY, generation)) return;
      set({ tenants: storeSuccess(tenants) });
    } catch (error) {
      if (!isCurrentGeneration(TENANTS_KEY, generation)) return;
      set({ tenants: storeFailure(previous, error) });
    }
  },

  select: (tenantId) => set({ currentId: tenantId }),

  reset: () => {
    invalidateGeneration(TENANTS_KEY);
    set({ tenants: { status: 'idle' }, currentId: null });
  },
}));
