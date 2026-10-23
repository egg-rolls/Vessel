import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import type { HubControlClient, HubControlClientOptions } from '../hub/control-client';
import { createHubRegistry, type HubRegistry } from '../hub/registry';
import { type HubRuntimeFactories, startHubRuntime } from '../hub/runtime';
import type { CreateHubServerOptions, HubServer, HubServerPointerInput } from '../hub/server';
import {
  type HubJoinStoreLike,
  type HubNodeCredentialStoreLike,
  type HubNodeInboundDeps,
  type HubNodeRecord,
  type HubTokenBrokerLike,
  pairingSecretKey,
  type SecretStore,
} from '../hub/types';

const dirs: string[] = [];
const HUB_ID = 'hub-runtime-test';

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-hub-runtime-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

function makeRecord(overrides: Partial<HubNodeRecord> = {}): HubNodeRecord {
  return {
    pairing_id: 'node-1:tenant-1',
    node_id: 'node-1',
    tenant_id: 'tenant-1',
    direction: 'hub',
    url: 'http://127.0.0.1:8642',
    data_plane: 'direct',
    status: 'connecting',
    truncated: false,
    counts: { teams: 0, agents: 0, live_agents: 0 },
    teams: [],
    agents: [],
    ...overrides,
  };
}

function makeConfig(gatewayDir: string): VesselConfig {
  return { dataDir: gatewayDir, hub: { direction: 'hub' } } as unknown as VesselConfig;
}

async function seedRegistry(hubDir: string, records: HubNodeRecord[]): Promise<void> {
  const seed = createHubRegistry({ dataDir: hubDir, hubId: HUB_ID });
  await seed.load();
  for (const record of records) seed.upsert(record);
  await seed.flush();
}

interface Harness {
  factories: HubRuntimeFactories;
  registry(): HubRegistry | undefined;
  inbound(): HubNodeInboundDeps | undefined;
  clientPairings: string[];
  closedClients: string[];
  secretsRead: string[];
  pointers: HubServerPointerInput[];
  directoryPublishes(): number;
  serverStopped(): boolean;
}

interface HarnessOptions {
  secretValues?: Record<string, string>;
  withInbound?: boolean;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const clientPairings: string[] = [];
  const closedClients: string[] = [];
  const secretsRead: string[] = [];
  const pointers: HubServerPointerInput[] = [];
  let directoryPublishes = 0;
  let serverStopped = false;
  let runtimeRegistry: HubRegistry | undefined;
  let inboundDeps: HubNodeInboundDeps | undefined;

  const secretStore: SecretStore = {
    async get(key: string): Promise<string | undefined> {
      secretsRead.push(key);
      return options.secretValues?.[key];
    },
    async set(): Promise<void> {},
    async delete(): Promise<void> {},
  };

  const joinStore: HubJoinStoreLike = {
    async issue() {
      return { code: 'ABCD-EFGH', expires_at: 0 };
    },
    async consume() {
      return {
        hub_id: HUB_ID,
        tenant_id: 'tenant-1',
        node_id: 'node-2',
        pairing_id: 'node-2:tenant-1',
      };
    },
  };

  const credentials: HubNodeCredentialStoreLike = {
    async issue() {
      throw new Error('unused');
    },
    authenticate() {
      return null;
    },
    async revoke() {
      return null;
    },
    async revokePairing() {
      return 0;
    },
    list() {
      return [];
    },
    onRevoke() {
      return () => undefined;
    },
  };

  const tokenBroker: HubTokenBrokerLike = {
    async exchangeForTeam() {
      throw new Error('unused');
    },
  };

  const factories: HubRuntimeFactories = {
    resolveHubId: async () => HUB_ID,
    createRegistry: (registryOptions) => {
      runtimeRegistry = createHubRegistry({ ...registryOptions, debounceMs: 0 });
      return runtimeRegistry;
    },
    createSecretStore: () => secretStore,
    createTokenBroker: () => tokenBroker,
    createControlClient: (clientOptions: HubControlClientOptions): HubControlClient => {
      clientPairings.push(clientOptions.record.pairing_id);
      return {
        close(): void {
          closedClients.push(clientOptions.record.pairing_id);
        },
        status: () => 'connecting',
        lastSeen: () => undefined,
        attempt: () => 0,
      };
    },
    createServer: (serverOptions: CreateHubServerOptions) => {
      const withInbound = serverOptions as CreateHubServerOptions & {
        nodeControl?: HubNodeInboundDeps;
      };
      inboundDeps = withInbound.nodeControl;
      const server: HubServer = {
        hostname: '127.0.0.1',
        port: 0,
        url: 'http://127.0.0.1:0',
        publishPointer(pointer: HubServerPointerInput): void {
          pointers.push(pointer);
        },
        publishDirectory(): void {
          directoryPublishes += 1;
        },
        publishSnapshot(): void {},
        async stop(): Promise<void> {
          serverStopped = true;
        },
      };
      return server;
    },
  };

  if (options.withInbound === true) {
    factories.createJoinStore = () => joinStore;
    factories.createNodeCredentials = async () => credentials;
  }

  return {
    factories,
    registry: () => runtimeRegistry,
    inbound: () => inboundDeps,
    clientPairings,
    closedClients,
    secretsRead,
    pointers,
    directoryPublishes: () => directoryPublishes,
    serverStopped: () => serverStopped,
  };
}

describe('startHubRuntime startup', () => {
  it('does not dial node-direction records and marks them waiting', async () => {
    const hubDir = await tempDataDir();
    const gatewayDir = await tempDataDir();
    await seedRegistry(hubDir, [
      makeRecord({
        pairing_id: 'hub-node:tenant-1',
        node_id: 'hub-node',
        direction: 'hub',
        status: 'healthy',
      }),
      makeRecord({
        pairing_id: 'node-2:tenant-1',
        node_id: 'node-2',
        direction: 'node',
        url: undefined,
        data_plane: undefined,
        status: 'healthy',
      }),
    ]);
    const harness = createHarness({
      withInbound: true,
      secretValues: {
        [pairingSecretKey('hub-node:tenant-1', 'view')]: 'view-token',
      },
    });

    const runtime = await startHubRuntime({
      config: makeConfig(gatewayDir),
      dataDir: hubDir,
      hubId: HUB_ID,
      factories: harness.factories,
    });

    try {
      expect(harness.clientPairings).toEqual(['hub-node:tenant-1']);

      const registry = harness.registry();
      expect(registry).toBeDefined();
      expect(registry?.get('node-2:tenant-1')).toMatchObject({
        direction: 'node',
        status: 'unreachable',
        last_error: 'waiting_for_node',
        data_plane: 'unreachable',
      });
      expect(registry?.get('hub-node:tenant-1')?.status).toBe('unreachable');
      expect(registry?.get('hub-node:tenant-1')?.last_error).toBe('reconnecting');

      // node-dial 记录不读 view token；hub-dial 记录照旧读取。
      expect(harness.secretsRead).not.toContain(pairingSecretKey('node-2:tenant-1', 'view'));
      expect(harness.secretsRead).toContain(pairingSecretKey('hub-node:tenant-1', 'view'));

      // 两个入站端口工厂都在时才装配 nodeControl。
      expect(harness.inbound()).toBeDefined();
    } finally {
      await runtime.stop();
    }
  });

  it('leaves nodeControl undefined when inbound factories are missing', async () => {
    const hubDir = await tempDataDir();
    const gatewayDir = await tempDataDir();
    const harness = createHarness();

    const runtime = await startHubRuntime({
      config: makeConfig(gatewayDir),
      dataDir: hubDir,
      hubId: HUB_ID,
      factories: harness.factories,
    });

    try {
      expect(harness.inbound()).toBeUndefined();
    } finally {
      await runtime.stop();
    }
  });
});

describe('startHubRuntime inbound hooks', () => {
  it('upserts a direction:node record on join with derived data_plane and node_token_id', async () => {
    const hubDir = await tempDataDir();
    const gatewayDir = await tempDataDir();
    const harness = createHarness({ withInbound: true });

    const runtime = await startHubRuntime({
      config: makeConfig(gatewayDir),
      dataDir: hubDir,
      hubId: HUB_ID,
      factories: harness.factories,
    });

    try {
      const inbound = harness.inbound();
      if (inbound === undefined) throw new Error('nodeControl is not wired');
      const onJoined = inbound.hooks.onJoined;
      if (onJoined === undefined) throw new Error('onJoined is not wired');

      const publishesBefore = harness.directoryPublishes();
      onJoined({
        pairing_id: 'node-3:tenant-1',
        node_id: 'node-3',
        tenant_id: 'tenant-1',
        node_token_id: 'token-3',
        public_url: 'https://node3.example',
        alias: 'Edge',
      });

      expect(harness.registry()?.get('node-3:tenant-1')).toEqual({
        pairing_id: 'node-3:tenant-1',
        node_id: 'node-3',
        tenant_id: 'tenant-1',
        direction: 'node',
        url: 'https://node3.example',
        public_url: 'https://node3.example',
        data_plane: 'direct',
        node_token_id: 'token-3',
        alias: 'Edge',
        status: 'connecting',
        truncated: false,
        counts: { teams: 0, agents: 0, live_agents: 0 },
        teams: [],
        agents: [],
      });
      expect(harness.directoryPublishes()).toBeGreaterThan(publishesBefore);

      // 再次 join 覆盖旧记录；没有 public_url 时数据面不可达。
      onJoined({
        pairing_id: 'node-3:tenant-1',
        node_id: 'node-3',
        tenant_id: 'tenant-1',
        node_token_id: 'token-4',
      });
      const replaced = harness.registry()?.get('node-3:tenant-1');
      expect(replaced).toMatchObject({
        direction: 'node',
        node_token_id: 'token-4',
        data_plane: 'unreachable',
      });
      expect(replaced?.url).toBeUndefined();
      expect(replaced?.public_url).toBeUndefined();
      expect(replaced?.alias).toBeUndefined();
    } finally {
      await runtime.stop();
    }
  });

  it('publishes pointers and re-derives status from inbound callbacks', async () => {
    const hubDir = await tempDataDir();
    const gatewayDir = await tempDataDir();
    const harness = createHarness({ withInbound: true });

    const runtime = await startHubRuntime({
      config: makeConfig(gatewayDir),
      dataDir: hubDir,
      hubId: HUB_ID,
      factories: harness.factories,
    });

    try {
      const inbound = harness.inbound();
      if (inbound === undefined) throw new Error('nodeControl is not wired');
      if (inbound.hooks.onJoined === undefined) throw new Error('onJoined is not wired');
      inbound.hooks.onJoined({
        pairing_id: 'node-4:tenant-1',
        node_id: 'node-4',
        tenant_id: 'tenant-1',
        node_token_id: 'token-5',
      });

      inbound.hooks.onSnapshot('node-4:tenant-1', {
        node_id: 'node-4',
        hub_id: HUB_ID,
        incarnation: 'inc-9',
        revision: 3,
        observed_at: 1234,
        truncated: false,
        counts: { teams: 1, agents: 1, live_agents: 1 },
        teams: [{ team_id: 't1', name: 'Team', member_count: 1, agent_count: 1 }],
        agents: [
          {
            agent_id: 'a1',
            team_id: 't1',
            membership: 'present',
            presence: 'live',
          },
        ],
      });
      expect(harness.registry()?.get('node-4:tenant-1')).toMatchObject({
        status: 'healthy',
        last_seen: 1234,
        incarnation: 'inc-9',
        revision: 3,
        counts: { teams: 1, agents: 1, live_agents: 1 },
      });
      expect(harness.registry()?.get('node-4:tenant-1')?.last_error).toBeUndefined();

      inbound.hooks.onStatus('node-4:tenant-1', 'unreachable', 'disconnected');
      expect(harness.registry()?.get('node-4:tenant-1')).toMatchObject({
        status: 'unreachable',
        last_error: 'disconnected',
      });

      inbound.hooks.onPointer({
        node_id: 'node-4',
        hub_id: HUB_ID,
        team_id: 't1',
        reason: 'team.message',
        request_id: 'm1',
        ts: 99,
      });
      expect(harness.pointers).toEqual([
        {
          node_id: 'node-4',
          team_id: 't1',
          reason: 'team.message',
          request_id: 'm1',
          ts: 99,
        },
      ]);
    } finally {
      await runtime.stop();
    }
  });
});

describe('startHubRuntime removal', () => {
  it('closes outbound clients when a pairing is removed from the registry', async () => {
    const hubDir = await tempDataDir();
    const gatewayDir = await tempDataDir();
    await seedRegistry(hubDir, [
      makeRecord({
        pairing_id: 'hub-node:tenant-1',
        node_id: 'hub-node',
        direction: 'hub',
      }),
    ]);
    const harness = createHarness({
      secretValues: {
        [pairingSecretKey('hub-node:tenant-1', 'view')]: 'view-token',
      },
    });

    const runtime = await startHubRuntime({
      config: makeConfig(gatewayDir),
      dataDir: hubDir,
      hubId: HUB_ID,
      factories: harness.factories,
    });

    try {
      expect(harness.clientPairings).toEqual(['hub-node:tenant-1']);
      harness.registry()?.remove('hub-node:tenant-1');
      expect(harness.closedClients).toContain('hub-node:tenant-1');
    } finally {
      await runtime.stop();
    }
  });
});
