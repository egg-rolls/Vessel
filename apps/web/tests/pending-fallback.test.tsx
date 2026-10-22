import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PendingPermissionsBar } from '../src/components/PendingPermissionsBar';
import {
  pendingBarSummary,
  pendingBarTarget,
  pendingForSession,
} from '../src/domains/chat/pending-permissions';
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

describe('compact pending bar', () => {
  test('bar counts permissions and asks together and jumps to the earliest owning session', () => {
    const permissions = [
      permission({
        requestId: 'perm-late',
        runId: 'run-perm',
        sessionId: 'session-perm',
        requestedAt: 3_000,
      }),
    ];
    const asks = [
      ask({
        requestId: 'ask-early',
        runId: 'run-ask',
        sessionId: 'session-ask',
        requestedAt: 1_000,
        questions: [
          { header: 'Q1', question: 'First?' },
          { header: 'Q2', question: 'Second?' },
        ],
      }),
    ];
    const markup = renderToStaticMarkup(
      <PendingPermissionsBar
        requests={permissions}
        asks={asks}
        onOpenSession={() => {}}
        onDismissOrphans={() => {}}
      />,
    );

    // ask 按条计数，不按问题数拆；两类合并成一条 bar。
    expect(markup).toContain('其他会话有 2 个待处理请求');
    // 最早一条（ask）的 run 短 id，而不是权限的。
    expect(markup).toContain('run run-ask');
    expect(markup).not.toContain('run run-perm');
    expect(markup).toContain('前往处理');
    expect(pendingBarTarget(pendingBarSummary(permissions, asks))).toEqual({
      domain: 'chat',
      sessionId: 'session-ask',
    });
  });

  test('bar shows an invalid hint without a jump when the earliest request has no session', () => {
    const permissions = [
      permission({ requestId: 'perm-unowned', runId: 'run-unowned', sessionId: undefined }),
    ];
    const asks = [
      ask({
        requestId: 'ask-owned',
        runId: 'run-owned',
        sessionId: 'session-2',
        requestedAt: 2_000,
      }),
    ];
    const markup = renderToStaticMarkup(
      <PendingPermissionsBar
        requests={permissions}
        asks={asks}
        onOpenSession={() => {}}
        onDismissOrphans={() => {}}
      />,
    );

    expect(markup).toContain('其他会话有 2 个待处理请求');
    expect(markup).toContain('无法定位所属会话，请求已失效');
    expect(markup).not.toContain('前往处理');
    expect(markup).not.toContain('<button');
    expect(pendingBarTarget(pendingBarSummary(permissions, asks))).toBeNull();
  });

  test('bar dismisses orphaned items without jump or decision buttons', () => {
    const markup = renderToStaticMarkup(
      <PendingPermissionsBar
        requests={[]}
        orphaned={[orphaned(), orphaned({ requestId: 'orphan-2' })]}
        onOpenSession={() => {}}
        onDismissOrphans={() => {}}
      />,
    );

    expect(markup).toContain('有 2 个已失效请求');
    expect(markup).toContain('关闭');
    // 只读：不跳转、不复用可应答卡片。
    expect(markup).not.toContain('前往处理');
    expect(markup).not.toContain('permission-card');
    expect(markup).not.toContain('ask-card');
    expect(markup).not.toContain('本次允许');
    expect(markup).not.toContain('拒绝');
    expect(markup).not.toContain('提交');
    expect(markup.split('<button').length - 1).toBe(1);
  });

  test('bar is absent when nothing is pending', () => {
    expect(
      renderToStaticMarkup(
        <PendingPermissionsBar
          requests={[]}
          asks={[]}
          orphaned={[]}
          onOpenSession={() => {}}
          onDismissOrphans={() => {}}
        />,
      ),
    ).toBe('');
  });
});
