import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PendingPermissionsBar } from '../src/components/PendingPermissionsBar';
import {
  pendingPermissionsOutsideView,
  pendingPermissionTarget,
} from '../src/domains/chat/pending-permissions';
import { RunCard } from '../src/domains/chat/RunCard';
import type { PermissionRequest } from '../src/gateway/types';
import type { RunGroup } from '../src/state/events';

function permission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'perm-1',
    tool: 'bash',
    input: { cmd: 'ls -la' },
    runId: 'run-1',
    sessionId: 'session-1',
    toolCallId: 'call-1',
    requestedAt: 1_000,
    expiresAt: 10_000,
    ...overrides,
  };
}

function runningGroup(): RunGroup {
  return { runId: 'run-1', sessionId: 'session-1', status: 'running', items: [] };
}

describe('inline permission card', () => {
  test('renders inside the matching RunCard instead of the global modal', () => {
    const markup = renderToStaticMarkup(
      <RunCard
        group={runningGroup()}
        cancelled={false}
        cancelling={false}
        onCancel={() => {}}
        permissions={[permission()]}
        permissionNow={7_500}
        permissionBusy={new Set()}
        onDecidePermission={() => {}}
      />,
    );

    expect(markup).toContain('permission-card');
    expect(markup).toContain('data-request-id="perm-1"');
    expect(markup).toContain('bash');
    expect(markup).toContain('ls -la');
    // 倒计时来自 deadline_at - now（2.5s → ceil 3s）。
    expect(markup).toContain('3s');
    // 四个动作都在卡片内。
    expect(markup.split('<button').length - 1).toBeGreaterThanOrEqual(4);
    // 不再渲染全局权限 Modal。
    expect(markup).not.toContain('permission-modal');
  });

  test('disables every action once the deadline passed', () => {
    const markup = renderToStaticMarkup(
      <RunCard
        group={runningGroup()}
        cancelled={false}
        cancelling={false}
        onCancel={() => {}}
        permissions={[permission()]}
        permissionNow={10_000}
        onDecidePermission={() => {}}
      />,
    );
    expect(markup).toContain('permission-card expired');
    expect(markup).toContain('disabled');
  });

  test('does not render a permission block without pending requests', () => {
    const markup = renderToStaticMarkup(
      <RunCard group={runningGroup()} cancelled={false} cancelling={false} onCancel={() => {}} />,
    );
    expect(markup).not.toContain('permission-card');
    expect(markup).not.toContain('run-permissions');
  });
});

describe('cross-session pending bar', () => {
  test('counts and names requests outside the current session', () => {
    const markup = renderToStaticMarkup(
      <PendingPermissionsBar
        requests={[
          permission({ requestId: 'perm-a', sessionId: 'session-abcdefghijk' }),
          permission({ requestId: 'perm-b', sessionId: 'session-2', runId: 'run-2' }),
        ]}
        onOpen={() => {}}
      />,
    );
    expect(markup).toContain('pending-permissions-bar');
    expect(markup).toContain('2');
    expect(markup).toContain('session-abcd');
    expect(markup).toContain('link-btn');
  });

  test('is absent when there is nothing pending', () => {
    expect(renderToStaticMarkup(<PendingPermissionsBar requests={[]} onOpen={() => {}} />)).toBe(
      '',
    );
  });
});

describe('pendingPermissionsOutsideView', () => {
  const now = 5_000;

  test('hides requests of the current session on chat', () => {
    const items = [
      permission({ requestId: 'same', sessionId: 'session-1' }),
      permission({ requestId: 'other', sessionId: 'session-2' }),
    ];
    expect(
      pendingPermissionsOutsideView(items, { domain: 'chat', sessionId: 'session-1' }, now).map(
        (item) => item.requestId,
      ),
    ).toEqual(['other']);
  });

  test('treats a new/draft chat as having no visible run', () => {
    const items = [permission({ requestId: 'same', sessionId: 'session-1' })];
    expect(pendingPermissionsOutsideView(items, { domain: 'chat', sessionId: 'new' }, now)).toEqual(
      items,
    );
  });

  test('on non-chat pages every live request is outside the view', () => {
    const items = [
      permission({ requestId: 'live', expiresAt: 6_000 }),
      permission({ requestId: 'expired', expiresAt: 5_000 }),
    ];
    expect(
      pendingPermissionsOutsideView(items, { domain: 'runs' }, now).map((item) => item.requestId),
    ).toEqual(['live']);
  });

  test('jumps to the session when known, otherwise to the run detail', () => {
    expect(pendingPermissionTarget(permission())).toEqual({
      domain: 'chat',
      sessionId: 'session-1',
    });
    expect(pendingPermissionTarget(permission({ sessionId: undefined }))).toEqual({
      domain: 'runs',
      tab: 'live',
      runId: 'run-1',
    });
  });
});
