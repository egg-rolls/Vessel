import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PendingPermissionsBar } from '../src/components/PendingPermissionsBar';
import {
  interactionSessionId,
  pendingBarSummary,
  pendingBarTarget,
  pendingForSession,
  pendingPermissionsOutsideView,
} from '../src/domains/chat/pending-permissions';
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
      <PendingPermissionsBar requests={permissions} asks={asks} onOpenSession={() => {}} />,
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
      <PendingPermissionsBar requests={permissions} asks={asks} onOpenSession={() => {}} />,
    );

    expect(markup).toContain('其他会话有 2 个待处理请求');
    expect(markup).toContain('无法定位所属会话');
    expect(markup).not.toContain('前往处理');
    expect(markup).not.toContain('<button');
    expect(pendingBarTarget(pendingBarSummary(permissions, asks))).toBeNull();
  });

  test('bar is absent when nothing is pending', () => {
    expect(
      renderToStaticMarkup(
        <PendingPermissionsBar requests={[]} asks={[]} onOpenSession={() => {}} />,
      ),
    ).toBe('');
  });
});

describe('member bridge grouping (parentSessionId)', () => {
  test('interactionSessionId prefers the parent chat, then session, then undefined', () => {
    expect(interactionSessionId({ sessionId: 'member-1', parentSessionId: 'chat-1' })).toBe(
      'chat-1',
    );
    expect(interactionSessionId({ sessionId: 'session-1' })).toBe('session-1');
    expect(interactionSessionId({})).toBeUndefined();
  });

  test('pendingForSession groups a member request under its parent chat', () => {
    const member = permission({
      requestId: 'member',
      sessionId: 'member-1',
      parentSessionId: 'chat-1',
    });
    expect(pendingForSession([member], 'chat-1', new Set())).toEqual([member]);
    expect(pendingForSession([member], 'member-1', new Set())).toEqual([]);
  });

  test('pendingPermissionsOutsideView does not list parent-chat requests as other', () => {
    const member = permission({
      requestId: 'member',
      sessionId: 'member-1',
      parentSessionId: 'chat-1',
    });
    const other = permission({ requestId: 'other', sessionId: 'chat-2' });
    expect(
      pendingPermissionsOutsideView([member, other], {
        domain: 'chat',
        sessionId: 'chat-1',
      }).map((item) => item.requestId),
    ).toEqual(['other']);
  });

  test('asks use the same parent grouping', () => {
    const memberAsk = ask({ sessionId: 'member-1', parentSessionId: 'chat-1' });
    expect(pendingForSession([memberAsk], 'chat-1', new Set())).toEqual([memberAsk]);
    expect(
      pendingPermissionsOutsideView([memberAsk], { domain: 'chat', sessionId: 'chat-1' }),
    ).toEqual([]);
  });
});
