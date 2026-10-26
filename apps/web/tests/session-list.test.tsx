import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToastProvider } from '../src/components/ToastProvider';
import { SessionList, sessionAgentAddresses } from '../src/domains/chat/SessionList';
import type { NodeView } from '../src/gateway/NodeProvider';
import type { NodeRoster } from '../src/gateway/team-roster';
import type { SessionInfo, TeamMember, TeamSummary } from '../src/gateway/types';

const node: NodeView = { name: 'main', nodeId: 'node-1', url: '', current: true };

const team: TeamSummary = {
  team_id: 'core',
  name: 'Core',
  tenant_id: 'default',
  member_count: 2,
  created_at: 1,
};

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    agent_id: 'agent-1',
    name: 'Alice',
    session_id: 's1',
    membership: 'present',
    presence: 'live',
    visibility: 'team',
    role: 'member',
    ...overrides,
  };
}

function roster(members: TeamMember[], overrides: Partial<NodeRoster> = {}): NodeRoster {
  return {
    node,
    ok: true,
    teams: [team],
    rosters: [{ team, members }],
    partialErrors: 0,
    ...overrides,
  };
}

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    session_id: 's1',
    title: 'Member chat',
    preview: 'hello preview',
    status: 'idle',
    started_at: 1,
    updated_at: 2,
    message_count: 1,
    ...overrides,
  };
}

function render(
  sessions: readonly SessionInfo[],
  agentAddresses?: ReadonlyMap<string, string>,
): string {
  return renderToStaticMarkup(
    <ToastProvider>
      <SessionList
        sessions={sessions}
        hiddenCount={0}
        selectedId={null}
        draftActive={false}
        agentAddresses={agentAddresses}
        query=""
        onQueryChange={() => undefined}
        loading={false}
        error={null}
        onRetry={() => undefined}
        hasToken
        onSelect={() => undefined}
        onNew={() => undefined}
        onRename={async () => true}
        onDelete={() => undefined}
        onViewRuns={() => undefined}
        onShowMore={() => undefined}
        compact={false}
        onCloseDrawer={() => undefined}
        onOpenConnection={() => undefined}
        writesDisabled={false}
        renameSignal={0}
      />
    </ToastProvider>,
  );
}

describe('sessionAgentAddresses', () => {
  test('maps member sessions to name@node:team', () => {
    const addresses = sessionAgentAddresses([roster([member()])]);
    expect(addresses.get('s1')).toBe('Alice@main:core');
  });

  test('skips temporary, single, unknown roles and missing fields', () => {
    const addresses = sessionAgentAddresses([
      roster([
        member({ session_id: 'temp', name: 'Temp', role: 'temporary' }),
        member({ session_id: 'single', name: 'Solo', role: 'single' }),
        member({ session_id: 'unknown', name: 'Unknown', role: undefined }),
        member({ session_id: 'no-name', name: undefined }),
        member({ session_id: undefined, name: 'NoSession' }),
      ]),
    ]);
    expect(addresses.size).toBe(0);
  });

  test('ignores roster entries from other nodes', () => {
    const addresses = sessionAgentAddresses([
      roster([member()], { node: { ...node, current: false } }),
    ]);
    expect(addresses.size).toBe(0);
  });
});

describe('SessionList agent row', () => {
  test('shows the agent address and hides time/preview for member sessions', () => {
    const markup = render([session()], new Map([['s1', 'Alice@main:core']]));
    expect(markup).toContain('session-agent');
    expect(markup).toContain('Alice@main:core');
    // 时间 / preview 不再占行内布局。
    expect(markup).not.toContain('session-time');
    expect(markup).not.toContain('session-preview');
    expect(markup).not.toContain('hello preview');
  });

  test('temporary sessions keep a single line', () => {
    const markup = render([session({ session_id: 's2', title: 'Temp chat' })]);
    expect(markup).not.toContain('session-agent');
    expect(markup).not.toContain('@main:');
  });
});
