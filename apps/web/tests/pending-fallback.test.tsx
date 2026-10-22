import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PendingPermissionsBar } from '../src/components/PendingPermissionsBar';
import { PendingRequestsPanel } from '../src/components/PendingRequests';
import { pendingForSession } from '../src/domains/chat/pending-permissions';
import type { OrphanedInteraction } from '../src/gateway/interaction-hydration';
import type { AskUserRequest, PermissionRequest } from '../src/gateway/types';

function permission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'perm-1',
    tool: 'bash',
    input: { cmd: 'ls -la' },
    runId: 'run-1',
    sessionId: 'session-1',
    requestedAt: 1_000,
    ...overrides,
  };
}

function ask(overrides: Partial<AskUserRequest> = {}): AskUserRequest {
  return {
    requestId: 'ask-1',
    questions: [{ header: 'Pick', question: 'Which one?' }],
    runId: 'run-1',
    sessionId: 'session-1',
    requestedAt: 2_000,
    ...overrides,
  };
}

function orphaned(overrides: Partial<OrphanedInteraction> = {}): OrphanedInteraction {
  return {
    kind: 'permission',
    requestId: 'orphan-1',
    runId: 'run-9',
    sessionId: undefined,
    tool: 'bash',
    createdAt: 500,
    ...overrides,
  };
}

describe('pendingForSession (composer slot)', () => {
  test('keeps every request belonging to the current session', () => {
    const items = [permission({ requestId: 'a' }), ask({ requestId: 'b' })];
    expect(pendingForSession(items, 'session-1', new Set()).map((item) => item.requestId)).toEqual([
      'a',
      'b',
    ]);
  });

  test('takes legacy requests whose run belongs to the current session', () => {
    const items = [permission({ requestId: 'legacy', sessionId: undefined })];
    expect(pendingForSession(items, 'session-1', new Set(['run-1']))).toHaveLength(1);
  });

  test('excludes other sessions, unattributable runs and drafts', () => {
    const other = permission({ requestId: 'other', sessionId: 'session-2' });
    const orphan = permission({ requestId: 'orphan', sessionId: undefined, runId: 'run-9' });
    expect(pendingForSession([other, orphan], 'session-1', new Set(['run-1']))).toEqual([]);
    expect(pendingForSession([permission()], null, new Set())).toEqual([]);
  });
});

describe('PendingRequestsPanel (shared non-modal cards)', () => {
  test('renders an unmatched permission with tool, input and decision actions', () => {
    const markup = renderToStaticMarkup(
      <PendingRequestsPanel
        className="pending-panel"
        title="待处理请求"
        permissions={[permission()]}
        responding={new Set()}
        onDecidePermission={() => {}}
        onRespondAsk={() => {}}
      />,
    );

    expect(markup).toContain('pending-panel');
    expect(markup).toContain('permission-card');
    expect(markup).toContain('data-request-id="perm-1"');
    expect(markup).toContain('bash');
    expect(markup).toContain('ls -la');
    // once / session / always / deny 四个动作。
    expect(markup).toContain('本次允许');
    expect(markup).toContain('本会话允许');
    expect(markup).toContain('始终允许');
    expect(markup).toContain('拒绝');
    // 不恢复全局遮罩。
    expect(markup).not.toContain('permission-modal');
  });

  test('shows the agent breadcrumb from agentId', () => {
    const markup = renderToStaticMarkup(
      <PendingRequestsPanel
        title="待处理"
        permissions={[permission({ agentId: 'delegate-abcdefghijklmnop' })]}
        responding={new Set()}
        onDecidePermission={() => {}}
        onRespondAsk={() => {}}
      />,
    );
    expect(markup).toContain('agent delegate-abc…');
    expect(markup).toContain('run run-1');
  });

  test('renders old streams without agentId (no breadcrumb, no crash)', () => {
    const markup = renderToStaticMarkup(
      <PendingRequestsPanel
        title="待处理"
        permissions={[permission()]}
        responding={new Set()}
        onDecidePermission={() => {}}
        onRespondAsk={() => {}}
      />,
    );
    expect(markup).toContain('permission-card');
    expect(markup).not.toContain('agent ');
  });

  test('disables actions while a request is submitting', () => {
    const markup = renderToStaticMarkup(
      <PendingRequestsPanel
        title="待处理"
        permissions={[permission()]}
        responding={new Set(['perm-1'])}
        onDecidePermission={() => {}}
        onRespondAsk={() => {}}
      />,
    );
    expect(markup).toContain('disabled');
  });
});

describe('AppShell fallback panel (cross-session / no sessionId)', () => {
  test('renders a request without sessionId as an actionable card', () => {
    const markup = renderToStaticMarkup(
      <PendingRequestsPanel
        id="pending-requests-panel"
        className="pending-panel"
        title="其他会话 / 未归属的待处理请求"
        showSession
        permissions={[permission({ sessionId: undefined })]}
        responding={new Set()}
        onDecidePermission={() => {}}
        onRespondAsk={() => {}}
      />,
    );
    expect(markup).toContain('id="pending-requests-panel"');
    expect(markup).toContain('pending-panel');
    expect(markup).toContain('permission-card');
    expect(markup).toContain('data-request-id="perm-1"');
    expect(markup).not.toContain('permission-modal');
  });

  test('shows the owning session for cross-session requests', () => {
    const markup = renderToStaticMarkup(
      <PendingRequestsPanel
        title="待处理"
        showSession
        permissions={[permission({ agentId: 'agent-1' })]}
        responding={new Set()}
        onDecidePermission={() => {}}
        onRespondAsk={() => {}}
      />,
    );
    expect(markup).toContain('session session-1');
    expect(markup).toContain('agent agent-1');
  });

  test('renders asks in the fallback panel with submit/cancel', () => {
    const markup = renderToStaticMarkup(
      <PendingRequestsPanel
        title="待处理"
        asks={[ask({ sessionId: undefined })]}
        responding={new Set()}
        onDecidePermission={() => {}}
        onRespondAsk={() => {}}
      />,
    );
    expect(markup).toContain('ask-card');
    expect(markup).toContain('Which one?');
    expect(markup).toContain('提交');
    expect(markup).toContain('取消');
    expect(markup).not.toContain('permission-modal');
  });

  test('unattributed orphaned item is dismissible in the fallback panel', () => {
    const dismissed: string[] = [];
    const markup = renderToStaticMarkup(
      <PendingRequestsPanel
        id="pending-requests-panel"
        title="其他会话 / 未归属的待处理请求"
        showSession
        orphaned={[orphaned()]}
        responding={new Set()}
        onDecidePermission={() => {}}
        onRespondAsk={() => {}}
        onDismissOrphaned={(requestId) => dismissed.push(requestId)}
      />,
    );

    expect(markup).toContain('id="pending-requests-panel"');
    expect(markup).toContain('orphan-notice');
    expect(markup).toContain('已失效（run 已结束 / 进程重启）');
    expect(markup).toContain('关闭');
    // 只读：不复用可应答卡片，也没有 allow / deny / submit。
    expect(markup).not.toContain('permission-card');
    expect(markup).not.toContain('ask-card');
    expect(markup).not.toContain('本次允许');
    expect(markup).not.toContain('拒绝');
    expect(markup).not.toContain('提交');
    expect(dismissed).toEqual([]);
  });

  test('pending count excludes orphaned items', () => {
    const markup = renderToStaticMarkup(
      <PendingRequestsPanel
        title="待处理"
        permissions={[permission()]}
        orphaned={[orphaned({ requestId: 'orphan-2' })]}
        responding={new Set()}
        onDecidePermission={() => {}}
        onRespondAsk={() => {}}
      />,
    );
    expect(markup).toContain('共 1 个');
    expect(markup).not.toContain('共 2 个');
    expect(markup).toContain('共 1 个已失效');
  });

  test('the bar renders for orphaned only and counts them separately', () => {
    const markup = renderToStaticMarkup(
      <PendingPermissionsBar requests={[]} orphaned={[orphaned()]} onOpen={() => {}} />,
    );
    expect(markup).toContain('其他会话有 1 个已失效');
    expect(markup).not.toContain('待处理权限请求');
    expect(markup).not.toContain('待处理提问');

    const empty = renderToStaticMarkup(<PendingPermissionsBar requests={[]} onOpen={() => {}} />);
    expect(empty).toBe('');
  });

  test('the bar exposes a non-modal panel toggle only when wired', () => {
    const withToggle = renderToStaticMarkup(
      <PendingPermissionsBar
        requests={[permission({ sessionId: undefined })]}
        onOpen={() => {}}
        panelOpen
        onTogglePanel={() => {}}
      />,
    );
    expect(withToggle).toContain('aria-controls="pending-requests-panel"');
    expect(withToggle).toContain('aria-expanded="true"');
    expect(withToggle).toContain('收起');

    const withoutToggle = renderToStaticMarkup(
      <PendingPermissionsBar requests={[permission()]} onOpen={() => {}} />,
    );
    expect(withoutToggle).not.toContain('aria-controls');
  });
});
