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
        permissionBusy={new Set()}
        onDecidePermission={() => {}}
      />,
    );

    expect(markup).toContain('permission-card');
    expect(markup).toContain('data-request-id="perm-1"');
    expect(markup).toContain('bash');
    expect(markup).toContain('ls -la');
    // Addendum A：不再显示倒计时/过期。
    expect(markup).not.toContain('permission-card expired');
    expect(markup).not.toContain('remaining');
    // 四个动作都在卡片内。
    expect(markup.split('<button').length - 1).toBeGreaterThanOrEqual(4);
    // 不再渲染全局权限 Modal。
    expect(markup).not.toContain('permission-modal');
  });

  test('disables actions only while the answer is submitting', () => {
    const markup = renderToStaticMarkup(
      <RunCard
        group={runningGroup()}
        cancelled={false}
        cancelling={false}
        onCancel={() => {}}
        permissions={[permission()]}
        permissionBusy={new Set(['perm-1'])}
        onDecidePermission={() => {}}
      />,
    );
    expect(markup).toContain('permission-card');
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
  test('hides requests of the current session on chat', () => {
    const items = [
      permission({ requestId: 'same', sessionId: 'session-1' }),
      permission({ requestId: 'other', sessionId: 'session-2' }),
    ];
    expect(
      pendingPermissionsOutsideView(items, { domain: 'chat', sessionId: 'session-1' }).map(
        (item) => item.requestId,
      ),
    ).toEqual(['other']);
  });

  test('treats a new/draft chat as having no visible run', () => {
    const items = [permission({ requestId: 'same', sessionId: 'session-1' })];
    expect(pendingPermissionsOutsideView(items, { domain: 'chat', sessionId: 'new' })).toEqual(
      items,
    );
  });

  test('on non-chat pages every pending request is outside the view (no expiry)', () => {
    const items = [permission({ requestId: 'a' }), permission({ requestId: 'b', requestedAt: 1 })];
    expect(
      pendingPermissionsOutsideView(items, { domain: 'runs' }).map((item) => item.requestId),
    ).toEqual(['a', 'b']);
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
