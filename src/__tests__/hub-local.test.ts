import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HubControlChange, HubControlLike, HubNodeSnapshotInput } from '@vessel-agent/serve';
import type { HubConfig, VesselConfig } from '../../packages/config/src/index';
import { createHubRegistry, type HubRegistry } from '../hub/registry';
import type { HubRuntimeFactories } from '../hub/runtime';
import type { CreateHubServerOptions, HubServer, HubServerPointerInput } from '../hub/server';
import type {
  HubJoinStoreLike,
  HubNodeCredentialStoreLike,
  HubTokenBrokerLike,
  SecretStore,
} from '../hub/types';
import { startLocalHub } from '../hub-local';

const dirs: string[] = [];

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-hub-local-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

function makeConfig(gatewayDir: string, hub: HubConfig = {}): VesselConfig {
  return { dataDir: gatewayDir, hub } as unknown as VesselConfig;
}

function snapshotInput(input: {
  teams: number;
  agents: number;
  liveAgents: number;
}): HubNodeSnapshotInput {
  return {
    truncated: false,
    counts: {
      teams: input.teams,
      agents: input.agents,
      live_agents: input.liveAgents,
    },
    teams: [],
    agents: [],
  };
}

interface FakeServer extends HubServer {
  options: CreateHubServerOptions;
  readonly stopped: boolean;
  readonly directoryPublishes: number;
  readonly pointers: HubServerPointerInput[];
}

interface Harness {
  factories: HubRuntimeFactories;
  servers: FakeServer[];
  registries: HubRegistry[];
}

const joinStore: HubJoinStoreLike = {
  async issue() {
    return { code: 'ABCD-EFGH', expires_at: 0 };
  },
  async consume() {
    return {
      hub_id: 'local-hub',
      tenant_id: 'tenant-a',
      node_id: 'node-a',
      pairing_id: 'node-a:tenant-a',
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

function memorySecretStore(): SecretStore {
  const values = new Map<string, string>();
  return {
    async get(key: string) {
      return values.get(key);
    },
    async set(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
}

function createHarness(): Harness {
  const servers: FakeServer[] = [];
  const registries: HubRegistry[] = [];

  const factories: HubRuntimeFactories = {
    resolveHubId: async () => 'local-hub',
    createRegistry: (options) => {
      const registry = createHubRegistry({ ...options, debounceMs: 0 });
      registries.push(registry);
      return registry;
    },
    createSecretStore: () => memorySecretStore(),
    createTokenBroker: () => tokenBroker,
    createJoinStore: () => joinStore,
    createNodeCredentials: async () => credentials,
    createServer: (options) => {
      const pointers: HubServerPointerInput[] = [];
      let directoryPublishes = 0;
      let stopped = false;
      const server: FakeServer = {
        options,
        hostname: '127.0.0.1',
        port: 0,
        url: `http://127.0.0.1:${41_000 + servers.length}`,
        get stopped() {
          return stopped;
        },
        get directoryPublishes() {
          return directoryPublishes;
        },
        get pointers() {
          return pointers;
        },
        publishPointer(pointer: HubServerPointerInput): void {
          pointers.push(pointer);
        },
        publishDirectory(): void {
          directoryPublishes += 1;
        },
        publishSnapshot(): void {},
        async stop(): Promise<void> {
          stopped = true;
        },
      };
      servers.push(server);
      return server;
    },
  };

  return { factories, servers, registries };
}

interface ControlledHubControl {
  control: HubControlLike;
  setSnapshot(input: HubNodeSnapshotInput): void;
  emit(change: HubControlChange): void;
  snapshotCount(): number;
  isSubscribed(): boolean;
}

function createHubControl(initial: HubNodeSnapshotInput): ControlledHubControl {
  let current = initial;
  let listener: ((change: HubControlChange) => void) | undefined;
  let snapshots = 0;
  const control: HubControlLike = {
    async snapshot() {
      snapshots += 1;
      return current;
    },
    subscribe(_tenantId, next) {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
  };
  return {
    control,
    setSnapshot(input) {
      current = input;
    },
    emit(change) {
      listener?.(change);
    },
    snapshotCount: () => snapshots,
    isSubscribed: () => listener !== undefined,
  };
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, '-e', '0'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await child.exited;
  return child.pid;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not met before timeout');
}

describe('startLocalHub', () => {
  it('starts a loopback hub by default and registers the local node', async () => {
    const gatewayDir = await tempDataDir();
    const harness = createHarness();
    const hub = createHubControl(snapshotInput({ teams: 2, agents: 3, liveAgents: 1 }));

    const handle = await startLocalHub({
      config: makeConfig(gatewayDir),
      gatewayDataDir: gatewayDir,
      nodeId: 'node-a',
      tenantId: 'tenant-a',
      hubControl: hub.control,
      factories: harness.factories,
    });

    try {
      expect(handle.status).toBe('started');
      expect(handle.url).toBe('http://127.0.0.1:41000');
      expect(harness.servers).toHaveLength(1);
      const server = harness.servers[0];
      expect(server).toBeDefined();
      if (server === undefined) throw new Error('server was not created');
      // 固定回环；端口缺省 0，避免与 gateway / 其它 hub 撞端口。
      expect(server.options.config.listen).toEqual({ hostname: '127.0.0.1', port: 0 });
      expect(server.options.config.allowRemote).toBe(false);
      expect(hub.isSubscribed()).toBe(true);
      expect(hub.snapshotCount()).toBeGreaterThanOrEqual(1);

      const registry = harness.registries[0];
      expect(registry).toBeDefined();
      expect(registry?.get('node-a:tenant-a')).toMatchObject({
        pairing_id: 'node-a:tenant-a',
        node_id: 'node-a',
        tenant_id: 'tenant-a',
        direction: 'node',
        status: 'healthy',
        truncated: false,
        counts: { teams: 2, agents: 3, live_agents: 1 },
      });
      expect(typeof registry?.get('node-a:tenant-a')?.last_seen).toBe('number');

      const lockPath = join(gatewayDir, 'hub', 'hub.lock');
      const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
        pid?: number;
        url?: string;
      };
      expect(lock.pid).toBe(process.pid);
      expect(lock.url).toBe('http://127.0.0.1:41000');
    } finally {
      await handle.stop();
    }

    expect(harness.servers[0]?.stopped).toBe(true);
    expect(existsSync(join(gatewayDir, 'hub', 'hub.lock'))).toBe(false);
  });

  it('skips auto-start when hub.autoStart is false', async () => {
    const gatewayDir = await tempDataDir();
    const harness = createHarness();
    const hub = createHubControl(snapshotInput({ teams: 0, agents: 0, liveAgents: 0 }));

    const handle = await startLocalHub({
      config: makeConfig(gatewayDir, { autoStart: false }),
      gatewayDataDir: gatewayDir,
      nodeId: 'node-a',
      tenantId: 'tenant-a',
      hubControl: hub.control,
      factories: harness.factories,
    });

    expect(handle.status).toBe('skipped');
    expect(handle.reason).toBe('auto_start_disabled');
    expect(harness.servers).toHaveLength(0);
    await handle.stop();
  });

  it('skips auto-start when the gateway joins a remote hub', async () => {
    const gatewayDir = await tempDataDir();
    const harness = createHarness();
    const hub = createHubControl(snapshotInput({ teams: 0, agents: 0, liveAgents: 0 }));

    const handle = await startLocalHub({
      config: makeConfig(gatewayDir, {
        direction: 'node',
        url: 'https://hub.example.test',
      }),
      gatewayDataDir: gatewayDir,
      nodeId: 'node-a',
      tenantId: 'tenant-a',
      hubControl: hub.control,
      factories: harness.factories,
    });

    expect(handle.status).toBe('skipped');
    expect(handle.reason).toBe('direction_node');
    expect(harness.servers).toHaveLength(0);
    await handle.stop();
  });

  it('returns reused when another live hub holds the same data dir', async () => {
    const gatewayDir = await tempDataDir();
    const first = createHarness();
    const firstControl = createHubControl(snapshotInput({ teams: 0, agents: 0, liveAgents: 0 }));
    const handle = await startLocalHub({
      config: makeConfig(gatewayDir),
      gatewayDataDir: gatewayDir,
      nodeId: 'node-a',
      tenantId: 'tenant-a',
      hubControl: firstControl.control,
      factories: first.factories,
    });

    try {
      expect(handle.status).toBe('started');
      const second = createHarness();
      const secondControl = createHubControl(snapshotInput({ teams: 0, agents: 0, liveAgents: 0 }));
      const reused = await startLocalHub({
        config: makeConfig(gatewayDir),
        gatewayDataDir: gatewayDir,
        nodeId: 'node-a',
        tenantId: 'tenant-a',
        hubControl: secondControl.control,
        factories: second.factories,
      });

      expect(reused.status).toBe('reused');
      expect(reused.reason).toBe('hub_already_running');
      // 单实例锁先于监听端口获取：复用时第二个装配点根本不绑定端口。
      expect(second.servers).toHaveLength(0);
      await reused.stop();
    } finally {
      await handle.stop();
    }
  });

  it('reclaims a stale lock left by a dead process', async () => {
    const gatewayDir = await tempDataDir();
    const hubDir = join(gatewayDir, 'hub');
    await mkdir(hubDir, { recursive: true });
    const pid = await deadPid();
    const lockPath = join(hubDir, 'hub.lock');
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid, started_at: 1, url: 'http://127.0.0.1:1' })}\n`,
      'utf8',
    );

    const harness = createHarness();
    const hub = createHubControl(snapshotInput({ teams: 0, agents: 0, liveAgents: 0 }));
    const handle = await startLocalHub({
      config: makeConfig(gatewayDir),
      gatewayDataDir: gatewayDir,
      nodeId: 'node-a',
      tenantId: 'tenant-a',
      hubControl: hub.control,
      factories: harness.factories,
    });

    try {
      expect(handle.status).toBe('started');
      const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: number };
      expect(lock.pid).toBe(process.pid);
    } finally {
      await handle.stop();
    }
  });

  it('refreshes the local node on directory changes and forwards pointers', async () => {
    const gatewayDir = await tempDataDir();
    const harness = createHarness();
    const hub = createHubControl(snapshotInput({ teams: 1, agents: 0, liveAgents: 0 }));
    const handle = await startLocalHub({
      config: makeConfig(gatewayDir),
      gatewayDataDir: gatewayDir,
      nodeId: 'node-a',
      tenantId: 'tenant-a',
      hubControl: hub.control,
      factories: harness.factories,
    });

    try {
      const registry = harness.registries[0];
      expect(registry?.get('node-a:tenant-a')?.counts.teams).toBe(1);

      hub.setSnapshot(snapshotInput({ teams: 4, agents: 2, liveAgents: 2 }));
      hub.emit({ directoryChanged: true });
      await waitFor(() => registry?.get('node-a:tenant-a')?.counts.teams === 4);

      hub.emit({
        pointers: [{ team_id: 'team-1', reason: 'team.message', request_id: 'req-1', ts: 1234 }],
      });
      expect(harness.servers[0]?.pointers).toEqual([
        {
          node_id: 'node-a',
          team_id: 'team-1',
          reason: 'team.message',
          request_id: 'req-1',
          ts: 1234,
        },
      ]);
    } finally {
      await handle.stop();
    }
  });
});
