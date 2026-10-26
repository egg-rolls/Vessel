import { beforeEach, describe, expect, test } from 'bun:test';
import { readPermissionLists } from '../src/domains/integrations/tool-policy';
import type { GatewayClient } from '../src/gateway/client';
import type { NodeView } from '../src/gateway/NodeProvider';
import type { TeamControl } from '../src/gateway/team-control';
import type {
  ConfigResponse,
  HealthResponse,
  HelloInfo,
  TeamDetail,
  TeamSummary,
} from '../src/gateway/types';
import { resourceData } from '../src/state/useResource';
import { useAgentStore } from '../src/stores/agentStore';
import { useConfigStore } from '../src/stores/configStore';
import { nodeHealthEntry, nodeHealthNames, useNodeStore } from '../src/stores/nodeStore';
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
