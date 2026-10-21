import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PendingPermissionsBar } from '../src/components/PendingPermissionsBar';
import { AskCard } from '../src/domains/chat/AskCard';
import { AskPrompt, PermissionPrompt } from '../src/domains/chat/PromptSlots';
import {
  nextPending,
  pendingPermissionsOutsideView,
  pendingPermissionTarget,
} from '../src/domains/chat/pending-permissions';
import type { AskUserRequest, PermissionRequest } from '../src/gateway/types';

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

describe('permission prompt (composer slot)', () => {
  test('replaces the input box with the permission card', () => {
    const markup = renderToStaticMarkup(
      <PermissionPrompt request={permission()} onDecide={() => {}} />,
    );

    expect(markup).toContain('composer-area');
    expect(markup).toContain('prompt-slot');
    expect(markup).toContain('permission-card');
    expect(markup).toContain('data-request-id="perm-1"');
    expect(markup).toContain('bash');
    expect(markup).toContain('ls -la');
    // Addendum A：不再显示倒计时/过期。
    expect(markup).not.toContain('permission-card expired');
    expect(markup).not.toContain('remaining');
    // 四个动作都在卡片内（允许 once/session/always + 拒绝）。
    expect(markup.split('<button').length - 1).toBeGreaterThanOrEqual(4);
    // 不再渲染全局权限 Modal，也不再使用 Composer 输入框。
    expect(markup).not.toContain('permission-modal');
    expect(markup).not.toContain('composer-input');
  });

  test('disables actions only while the answer is submitting', () => {
    const markup = renderToStaticMarkup(
      <PermissionPrompt request={permission()} busy onDecide={() => {}} />,
    );
    expect(markup).toContain('permission-card');
    expect(markup).toContain('disabled');
  });

  test('shows how many requests remain for serial handling', () => {
    const markup = renderToStaticMarkup(
      <PermissionPrompt request={permission()} more={2} onDecide={() => {}} />,
    );
    expect(markup).toContain('还有 2 个待处理');
  });
});

describe('ask card (composer slot)', () => {
  test('has no countdown / expiry hint and keeps submit available (0.18)', () => {
    const markup = renderToStaticMarkup(
      <AskCard
        request={{
          requestId: 'ask-1',
          runId: 'run-1',
          expiresAt: Number.POSITIVE_INFINITY,
          questions: [{ header: 'Q', question: 'Which?' }],
        }}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(markup).toContain('ask-card');
    expect(markup).not.toContain('剩余');
    expect(markup).not.toContain('s left');
    expect(markup).toContain('提交');
  });
});

describe('nextPending (serial order)', () => {
  test('returns the earliest permission first', () => {
    const later = permission({ requestId: 'later', requestedAt: 2_000 });
    const earlier = permission({ requestId: 'earlier', requestedAt: 1_000 });
    expect(nextPending([later, earlier], [])?.request.requestId).toBe('earlier');
  });

  test('compares asks by arrival time derived from expiresAt', () => {
    const earlyAsk = ask({ requestId: 'early-ask', expiresAt: 1_000 + 120_000 });
    const latePermission = permission({ requestId: 'late-perm', requestedAt: 2_000 });
    expect(nextPending([latePermission], [earlyAsk])?.kind).toBe('ask');
    expect(nextPending([latePermission], [earlyAsk])?.request.requestId).toBe('early-ask');
  });

  test('returns null when nothing is pending', () => {
    expect(nextPending([], [])).toBeNull();
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

function ask(overrides: Partial<AskUserRequest> = {}): AskUserRequest {
  return {
    requestId: 'ask-1',
    questions: [{ header: 'Pick', question: 'Which one?' }],
    runId: 'run-1',
    sessionId: 'session-1',
    expiresAt: 2_000,
    ...overrides,
  };
}

describe('ask prompt (composer slot)', () => {
  test('replaces the input box with the ask card instead of a global modal', () => {
    const markup = renderToStaticMarkup(
      <AskPrompt request={ask()} now={1_000} onSubmit={() => {}} onCancel={() => {}} />,
    );

    expect(markup).toContain('prompt-slot');
    expect(markup).toContain('ask-card');
    expect(markup).toContain('data-request-id="ask-1"');
    expect(markup).toContain('Which one?');
    // 0.18：提问不再倒计时 / 过期。
    expect(markup).not.toContain('剩余');
    expect(markup).not.toContain('ask-card expired');
    expect(markup).not.toContain('permission-modal');
    expect(markup).not.toContain('composer-input');
  });

  test('disables submission until every question has an answer', () => {
    const markup = renderToStaticMarkup(
      <AskPrompt request={ask()} now={1_000} onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(markup).toContain('btn-primary');
    expect(markup).toContain('disabled');
  });
});

describe('cross-session pending bar with asks', () => {
  test('reports permission and ask counts separately with one jump action each', () => {
    const markup = renderToStaticMarkup(
      <PendingPermissionsBar
        requests={[permission({ requestId: 'perm-a', sessionId: 'session-aaaaaaaa' })]}
        asks={[ask({ requestId: 'ask-b', sessionId: 'session-bbbbbbbb' })]}
        onOpen={() => {}}
        onOpenAsk={() => {}}
      />,
    );

    expect(markup).toContain('其他会话有 1 个待处理权限请求');
    expect(markup).toContain('其他会话有 1 个待处理提问');
    expect(markup.split('<button').length - 1).toBe(2);
  });

  test('is absent when neither category has pending requests', () => {
    expect(
      renderToStaticMarkup(
        <PendingPermissionsBar requests={[]} asks={[]} onOpen={() => {}} onOpenAsk={() => {}} />,
      ),
    ).toBe('');
  });
});
