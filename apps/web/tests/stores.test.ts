import { beforeEach, describe, expect, test } from 'bun:test';
import { readPermissionLists } from '../src/domains/integrations/tool-policy';
import type { GatewayClient } from '../src/gateway/client';
import type { HydrationSnapshot } from '../src/gateway/interaction-hydration';
import type { NodeView } from '../src/gateway/NodeProvider';
import type { TeamControl } from '../src/gateway/team-control';
import type {
  AskUserRequest,
  ConfigResponse,
  HealthResponse,
  HelloInfo,
  PermissionRequest,
  SessionDetail,
  SessionInfo,
  TeamDetail,
  TeamSummary,
} from '../src/gateway/types';
import { resourceData } from '../src/state/useResource';
import { useAgentStore } from '../src/stores/agentStore';
import { useConfigStore } from '../src/stores/configStore';
import { useInteractionStore } from '../src/stores/interactionStore';
import { nodeHealthEntry, nodeHealthNames, useNodeStore } from '../src/stores/nodeStore';
import { SESSION_NOT_FOUND_MESSAGE, useSessionStore } from '../src/stores/sessionStore';
import { teamDetailKey, useTeamStore } from '../src/stores/teamStore';

function configWithPermission(lists: {
  autoApprove: string[];
  neverAutoApprove: string[];
}): ConfigResponse {
  return {
    schema_version: 1,
    config: {
      permission: lists,
      ui: { verbosity: 'normal' },
    },
    paths: { user: '/user', project: '/project' },
    tenant_id: 'default',
    version: '0.28.0',
  };
}

const hello: HelloInfo = {
  protocol: { name: 'vessel.gateway', version: 1, min: 1, features: [] },
  node: {
    node_id: 'node-1',
    name: 'Main',
    pid: 1,
    started_at: 1,
    endpoint: 'http://127.0.0.1:1',
    role: 'standalone',
    status: 'idle',
    capabilities: { tools: [], max_concurrency: 1, protocol: 1 },
  },
  from_seq: 0,
  latest_seq: 0,
};

const extraNode: NodeView = {
  name: 'Sidecar',
  url: 'http://127.0.0.1:2',
  current: false,
};

describe('configStore', () => {
  beforeEach(() => {
    useConfigStore.getState().reset();
  });

  test('dedupes config.get and applyPermissionLists updates the shared snapshot', async () => {
    let calls = 0;
    const client = {
      getConfig: async () => {
        calls += 1;
        return configWithPermission({ autoApprove: ['bash'], neverAutoApprove: [] });
      },
      getCapabilities: async () => ({
        version: '1',
        config_schema_version: 1,
        methods: [],
        tools: [],
        plugins: [],
      }),
      getConfigSources: async () => ({ sources: { user: '/user' } }),
    } as unknown as GatewayClient;

    await Promise.all([
      useConfigStore.getState().loadConfig(client, { epoch: 0 }),
      useConfigStore.getState().loadConfig(client, { epoch: 0 }),
    ]);
    expect(calls).toBe(1);

    const loaded = resourceData(useConfigStore.getState().config);
    expect(readPermissionLists(loaded?.config).autoApprove).toEqual(['bash']);

    // Both the tool card and the dialog read the same store; a write is visible
    // without another config.get.
    useConfigStore.getState().applyPermissionLists({
      autoApprove: [],
      neverAutoApprove: ['edit'],
    });
    const updated = resourceData(useConfigStore.getState().config);
    expect(readPermissionLists(updated?.config)).toEqual({
      autoApprove: [],
      neverAutoApprove: ['edit'],
    });
    expect(calls).toBe(1);

    // A non-forced load for the same connection is a no-op.
    await useConfigStore.getState().loadConfig(client, { epoch: 0 });
    expect(calls).toBe(1);

    await useConfigStore.getState().loadConfig(client, { epoch: 0, force: true });
    expect(calls).toBe(2);
  });

  test('loads capabilities once until forced', async () => {
    let calls = 0;
    const client = {
      getCapabilities: async () => {
        calls += 1;
        return { version: '1', config_schema_version: 1, methods: [], tools: [], plugins: [] };
      },
    } as unknown as GatewayClient;
    await Promise.all([
      useConfigStore.getState().loadCapabilities(client),
      useConfigStore.getState().loadCapabilities(client),
    ]);
    expect(calls).toBe(1);
    await useConfigStore.getState().loadCapabilities(client);
    expect(calls).toBe(1);
    await useConfigStore.getState().loadCapabilities(client, { force: true });
    expect(calls).toBe(2);
  });
});

describe('nodeStore', () => {
  beforeEach(() => {
    useNodeStore.getState().reset();
  });

  test('merges the current connection node with persisted extras', () => {
    useNodeStore.getState().setExtras([extraNode]);
    useNodeStore
      .getState()
      .setConnection({ hasToken: true, hello, gatewayUrl: 'http://127.0.0.1:1' });
    const state = useNodeStore.getState();
    expect(state.nodes.map((node) => node.name)).toEqual(['Main', 'Sidecar']);
    expect(state.current?.current).toBe(true);
    useNodeStore.getState().select('node-1');
    expect(useNodeStore.getState().selectedKey).toBe('node-1');
  });

  test('records per-node health and exposes names', async () => {
    useNodeStore.getState().setExtras([extraNode]);
    useNodeStore
      .getState()
      .setConnection({ hasToken: true, hello, gatewayUrl: 'http://127.0.0.1:1' });
    const nodes = useNodeStore.getState().nodes;
    await useNodeStore.getState().loadHealth(nodes, async (node) => {
      if (node.name === 'Sidecar') throw new Error('down');
      return {
        status: 'ok',
        clients: 0,
        latest_seq: 0,
        protocol: hello.protocol,
        node: hello.node,
        started_at: 1,
        tenant_id: 'default',
      } satisfies HealthResponse;
    });
    const health = useNodeStore.getState().health;
    expect(nodeHealthEntry(health, { name: 'Main', nodeId: 'node-1' })?.health?.node.name).toBe(
      'Main',
    );
    expect(nodeHealthEntry(health, extraNode)?.error).toBe('down');
    expect(nodeHealthNames(health).get('node-1')).toBe('Main');
  });
});

describe('teamStore', () => {
  beforeEach(() => {
    useTeamStore.getState().reset();
  });

  const summary: TeamSummary = {
    team_id: 'core',
    name: 'Core',
    tenant_id: 'default',
    member_count: 1,
    created_at: 1,
  };
  const detail: TeamDetail = { team: summary, members: [], messages: [] };
  const control = {
    listTeams: async () => [summary],
    getTeam: async () => detail,
  } as unknown as TeamControl;
  const node: NodeView = { name: 'Main', nodeId: 'node-1', url: '', current: true };

  test('loads per-node lists and per-variant team details', async () => {
    await useTeamStore.getState().loadList(node, control);
    expect(teamListDataOf('node-1')?.teams.map((team) => team.team_id)).toEqual(['core']);

    await useTeamStore.getState().loadDetail('node-1', 'core', control, { limit: 1 }, 'summary');
    const state = useTeamStore.getState();
    expect(resourceData(state.details[teamDetailKey('node-1', 'core', 'summary')])?.team.name).toBe(
      'Core',
    );
  });

  test('keeps summary and chat windows independent', async () => {
    await useTeamStore.getState().loadDetail('node-1', 'core', control, { limit: 1 }, 'summary');
    await useTeamStore
      .getState()
      .loadDetail('node-1', 'core', control, { members_limit: 50 }, 'chat');
    const details = useTeamStore.getState().details;
    expect(details[teamDetailKey('node-1', 'core', 'summary')]?.status).toBe('success');
    expect(details[teamDetailKey('node-1', 'core', 'chat')]?.status).toBe('success');
  });

  function teamListDataOf(key: string) {
    return resourceData(useTeamStore.getState().lists[key]);
  }
});

describe('agentStore', () => {
  beforeEach(() => {
    useAgentStore.getState().reset();
  });

  test('loads a roster and remembers the current agent', async () => {
    const summary: TeamSummary = {
      team_id: 'core',
      name: 'Core',
      tenant_id: 'default',
      member_count: 1,
      created_at: 1,
    };
    const control = {
      listTeams: async () => [summary],
      getTeam: async () => ({
        team: summary,
        members: [
          {
            agent_id: 'a1',
            name: 'Alice',
            membership: 'present' as const,
            presence: 'live' as const,
            visibility: 'team' as const,
          },
        ],
        messages: [],
      }),
    } as unknown as TeamControl;
    const node: NodeView = { name: 'Main', nodeId: 'node-1', url: '', current: true };
    await useAgentStore.getState().loadRoster([node], () => control);
    const roster = resourceData(useAgentStore.getState().roster);
    expect(roster).toHaveLength(1);
    expect(roster?.[0]?.rosters[0]?.members[0]?.name).toBe('Alice');
    useAgentStore.getState().selectAgent('a1');
    expect(useAgentStore.getState().currentAgentId).toBe('a1');
  });
});

function permission(
  requestId: string,
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    requestId,
    tool: 'bash',
    input: { cmd: 'ls' },
    runId: 'run-1',
    requestedAt: 1,
    ...overrides,
  };
}

function ask(requestId: string, overrides: Partial<AskUserRequest> = {}): AskUserRequest {
  return {
    requestId,
    runId: 'run-1',
    requestedAt: 1,
    questions: [{ header: 'Q', question: 'Which?' }],
    ...overrides,
  };
}

describe('interactionStore', () => {
  beforeEach(() => {
    useInteractionStore.getState().reset();
  });

  test('holds the pending sets, orphaned ids and responding markers', () => {
    useInteractionStore.getState().setSnapshot({
      permissions: [permission('p1')],
      asks: [ask('a1')],
      orphanedIds: ['o1', 'o2'],
    });
    useInteractionStore.getState().setResponding('p1', true);
    useInteractionStore.getState().setResponding('p1', true);

    const state = useInteractionStore.getState();
    expect(state.permissions.map((item) => item.requestId)).toEqual(['p1']);
    expect(state.asks.map((item) => item.requestId)).toEqual(['a1']);
    expect(state.orphanedIds).toEqual(['o1', 'o2']);
    expect([...state.responding]).toEqual(['p1']);

    useInteractionStore.getState().setResponding('p1', false);
    expect(useInteractionStore.getState().responding.size).toBe(0);
  });

  test('applies event increments, settle and run-finished with dedupe', () => {
    const store = useInteractionStore.getState();
    store.dispatch({ type: 'permission-request', request: permission('p1') });
    store.dispatch({ type: 'permission-request', request: permission('p1') });
    store.dispatch({ type: 'ask-request', request: ask('a1') });
    expect(useInteractionStore.getState().permissions).toHaveLength(1);
    expect(useInteractionStore.getState().asks).toHaveLength(1);

    useInteractionStore.getState().dispatch({ type: 'settle', requestId: 'p1' });
    expect(useInteractionStore.getState().permissions).toHaveLength(0);

    useInteractionStore.getState().dispatch({ type: 'run-finished', runId: 'run-1' });
    expect(useInteractionStore.getState().asks).toHaveLength(0);
  });

  test('hydrate merges pending, drops terminal ids and records orphaned ids', () => {
    useInteractionStore.getState().setSnapshot({
      permissions: [permission('live'), permission('gone')],
    });
    const snapshot: HydrationSnapshot = {
      permissions: [permission('hydrated'), permission('live')],
      asks: [ask('ask-hydrated')],
      terminalIds: ['gone'],
    };
    useInteractionStore.getState().hydrate(snapshot, new Set(), ['orphan-1', 'orphan-2']);

    const state = useInteractionStore.getState();
    expect(state.permissions.map((item) => item.requestId)).toEqual(['live', 'hydrated']);
    expect(state.asks.map((item) => item.requestId)).toEqual(['ask-hydrated']);
    expect(state.orphanedIds).toEqual(['orphan-1', 'orphan-2']);
  });

  test('reset clears pending, responding and orphaned state', () => {
    const store = useInteractionStore.getState();
    store.setSnapshot({ permissions: [permission('p1')], orphanedIds: ['o1'] });
    store.setResponding('p1', true);
    useInteractionStore.getState().reset();

    const state = useInteractionStore.getState();
    expect(state.permissions).toHaveLength(0);
    expect(state.asks).toHaveLength(0);
    expect(state.responding.size).toBe(0);
    expect(state.orphanedIds).toHaveLength(0);
  });
});

function sessionInfo(sessionId: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    session_id: sessionId,
    title: sessionId,
    preview: '',
    status: 'idle',
    started_at: 1,
    updated_at: 1,
    message_count: 0,
    ...overrides,
  };
}

function sessionDetail(sessionId: string): SessionDetail {
  return { session_id: sessionId, messages: [] };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('sessionStore', () => {
  beforeEach(() => {
    useSessionStore.getState().reset();
  });

  test('loads the list once per epoch and force reloads on demand', async () => {
    let calls = 0;
    const client = {
      listSessions: async () => {
        calls += 1;
        return [sessionInfo('a')];
      },
    } as unknown as GatewayClient;

    await Promise.all([
      useSessionStore.getState().loadSessions(client, { epoch: 0 }),
      useSessionStore.getState().loadSessions(client, { epoch: 0 }),
    ]);
    expect(calls).toBe(1);
    expect(useSessionStore.getState().sessions.map((item) => item.session_id)).toEqual(['a']);
    expect(useSessionStore.getState().loaded).toBe(true);

    await useSessionStore.getState().loadSessions(client, { epoch: 0 });
    expect(calls).toBe(1);

    await useSessionStore.getState().loadSessions(client, { epoch: 1 });
    expect(calls).toBe(2);
  });

  test('keeps stale sessions when a refresh fails', async () => {
    let fail = false;
    const client = {
      listSessions: async () => {
        if (fail) throw new Error('list down');
        return [sessionInfo('a')];
      },
    } as unknown as GatewayClient;

    await useSessionStore.getState().loadSessions(client, { epoch: 0 });
    fail = true;
    await useSessionStore.getState().loadSessions(client, { epoch: 0, force: true });

    const state = useSessionStore.getState();
    expect(state.sessions.map((item) => item.session_id)).toEqual(['a']);
    expect(state.error).toBe('list down');
    expect(state.loading).toBe(false);
    expect(state.loaded).toBe(true);
  });

  test('dedupes in-flight detail fetches for the same selection', async () => {
    let calls = 0;
    const response = deferred<SessionDetail>();
    const client = {
      getSession: async (id: string) => {
        calls += 1;
        return response.promise.then(() => sessionDetail(id));
      },
    } as unknown as GatewayClient;

    useSessionStore.getState().select('a');
    const first = useSessionStore.getState().loadDetail(client, 'a', { epoch: 0 });
    const second = useSessionStore.getState().loadDetail(client, 'a', { epoch: 0 });
    expect(calls).toBe(1);

    response.resolve(sessionDetail('a'));
    await Promise.all([first, second]);
    expect(useSessionStore.getState().detail?.session_id).toBe('a');

    // Same id + epoch after success does not fetch again.
    await useSessionStore.getState().loadDetail(client, 'a', { epoch: 0 });
    expect(calls).toBe(1);

    await useSessionStore.getState().loadDetail(client, 'a', { epoch: 0, force: true });
    expect(calls).toBe(2);
  });

  test('discards a detail response that arrives after switching sessions', async () => {
    const lateA = deferred<SessionDetail>();
    const client = {
      getSession: async (id: string) =>
        id === 'a' ? lateA.promise : Promise.resolve(sessionDetail('b')),
    } as unknown as GatewayClient;

    useSessionStore.getState().select('a');
    const pendingA = useSessionStore.getState().loadDetail(client, 'a', { epoch: 0 });
    useSessionStore.getState().select('b');
    await useSessionStore.getState().loadDetail(client, 'b', { epoch: 0 });

    lateA.resolve(sessionDetail('a'));
    await pendingA;

    const state = useSessionStore.getState();
    expect(state.selectedId).toBe('b');
    expect(state.detailId).toBe('b');
    expect(state.detail?.session_id).toBe('b');
  });

  test('reuses a loaded detail when switching back', async () => {
    let calls = 0;
    const client = {
      getSession: async (id: string) => {
        calls += 1;
        return sessionDetail(id);
      },
    } as unknown as GatewayClient;

    useSessionStore.getState().select('a');
    await useSessionStore.getState().loadDetail(client, 'a', { epoch: 0 });
    useSessionStore.getState().select('b');
    await useSessionStore.getState().loadDetail(client, 'b', { epoch: 0 });
    expect(calls).toBe(2);

    useSessionStore.getState().select('a');
    await useSessionStore.getState().loadDetail(client, 'a', { epoch: 0 });
    expect(calls).toBe(2);
    expect(useSessionStore.getState().detail?.session_id).toBe('a');
  });

  test('treats not_found as empty history only for fresh sessions', async () => {
    const missing = Object.assign(new Error('not_found: gone'), { code: 'not_found' });
    const client = {
      getSession: async () => {
        throw missing;
      },
    } as unknown as GatewayClient;

    useSessionStore.getState().select('fresh');
    await useSessionStore.getState().loadDetail(client, 'fresh', { epoch: 0, allowMissing: true });
    expect(useSessionStore.getState().detail).toEqual({ session_id: 'fresh', messages: [] });
    expect(useSessionStore.getState().detailError).toBeNull();

    useSessionStore.getState().reset();
    useSessionStore.getState().select('deleted');
    await useSessionStore.getState().loadDetail(client, 'deleted', { epoch: 0 });
    expect(useSessionStore.getState().detailError).toBe(SESSION_NOT_FOUND_MESSAGE);
  });

  test('refresh reloads the list and the selected detail, and optimistic edits update the list', async () => {
    let listCalls = 0;
    let detailCalls = 0;
    const client = {
      listSessions: async () => {
        listCalls += 1;
        return [sessionInfo('a'), sessionInfo('b')];
      },
      getSession: async (id: string) => {
        detailCalls += 1;
        return sessionDetail(id);
      },
    } as unknown as GatewayClient;

    useSessionStore.getState().select('a');
    await useSessionStore.getState().refresh(client, { epoch: 0 });
    expect(listCalls).toBe(1);
    expect(detailCalls).toBe(1);

    useSessionStore.getState().renameSession('a', 'Renamed');
    expect(useSessionStore.getState().sessions[0]?.title).toBe('Renamed');
    useSessionStore.getState().removeSession('b');
    expect(useSessionStore.getState().sessions.map((item) => item.session_id)).toEqual(['a']);

    await useSessionStore.getState().refresh(client, { epoch: 0 });
    expect(listCalls).toBe(2);
    expect(detailCalls).toBe(2);
  });
});
