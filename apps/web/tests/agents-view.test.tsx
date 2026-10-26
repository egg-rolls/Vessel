import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToastProvider } from '../src/components/ToastProvider';
import { AgentListRow } from '../src/domains/agents/AgentListRow';
import { SessionHeader } from '../src/domains/chat/SessionHeader';
import type { RosterAgent } from '../src/gateway/team-roster';
import type { AgentNode } from '../src/state/agents';

const agents: AgentNode[] = [
  {
    id: 'd1',
    role: 'subagent',
    depth: 0,
    state: 'running',
    task: 'research',
    currentTool: 'bash',
    sessionId: 's1',
    runId: 'r1',
    startedAt: 10,
  },
  {
    id: 'd2',
    role: 'subagent',
    parentId: 'd1',
    depth: 1,
    state: 'completed',
    task: 'nested',
    sessionId: 's1',
    runId: 'r2',
    usage: { total_tokens: 7 },
  },
];

function render(
  extra: {
    agents?: AgentNode[];
    activeAgentId?: string;
    onSelectAgent?: (id: string | undefined) => void;
  } = {},
): string {
  return renderToStaticMarkup(
    <ToastProvider>
      <SessionHeader
        session={null}
        sessionId="s1"
        detail={{ session_id: 's1', messages: [] }}
        refreshing={false}
        onRefresh={() => undefined}
        onRename={async () => true}
        onDelete={() => undefined}
        onViewRuns={() => undefined}
        showInternal={false}
        onToggleInternal={() => undefined}
        writesDisabled={false}
        agents={extra.agents ?? []}
        activeAgentId={extra.activeAgentId}
        onSelectAgent={extra.onSelectAgent}
      />
    </ToastProvider>,
  );
}

describe('AgentListRow', () => {
  const node = { name: 'node-a', url: 'https://node-a.test', current: true };
  const single: RosterAgent = {
    node,
    member: {
      agent_id: 'solo-1',
      name: 'Solo',
      membership: 'present',
      presence: 'live',
      visibility: 'private',
      state: 'idle',
      role: 'single',
    },
  };

  test('renders a Team-less single with the node only', () => {
    const markup = renderToStaticMarkup(
      <AgentListRow agent={single} nodeName="Node A" onOpen={() => undefined} />,
    );

    expect(markup).toContain('Solo');
    expect(markup).toContain('Node A');
    expect(markup).not.toContain(' · ');
  });

  test('keeps the Team label for roster members', () => {
    const markup = renderToStaticMarkup(
      <AgentListRow
        agent={{
          ...single,
          team: {
            team_id: 'team-1',
            name: 'Team One',
            tenant_id: 'default',
            member_count: 1,
            created_at: 1,
          },
        }}
        nodeName="Node A"
        onOpen={() => undefined}
      />,
    );

    expect(markup).toContain('Node A · Team One');
  });
});

describe('SessionHeader subagent tree', () => {
  test('shows a summary with counts and current tool by default', () => {
    const markup = render({ agents });
    expect(markup).toContain('subagent-tree');
    expect(markup).toContain('子 agent · 2');
    expect(markup).toContain('1 运行中');
    expect(markup).toContain('research');
    expect(markup).toContain('bash');
    expect(markup).toContain('nested');
    // 详情在折叠区里，不在摘要中铺开 usage 明细。
    expect(markup).toContain('subagent-node-details');
    expect(markup).toContain('7 tok');
  });

  test('renders breadcrumb and back action for the active deep link', () => {
    const markup = render({ agents, activeAgentId: 'd2' });
    expect(markup).toContain('subagent-breadcrumb');
    expect(markup).toContain('返回主会话');
    expect(markup).toContain('子 agent · research');
    expect(markup).toContain('子 agent · nested');
  });

  test('renders nothing subagent-related when there are no children', () => {
    const markup = render();
    expect(markup).not.toContain('subagent-tree');
    expect(markup).not.toContain('subagent-breadcrumb');
  });
});
