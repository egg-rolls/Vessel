import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AskCard } from '../src/domains/chat/AskCard';
import { AskPrompt, PermissionPrompt } from '../src/domains/chat/PromptSlots';
import {
  nextPending,
  pendingPermissionsOutsideView,
  pendingQueue,
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
          requestedAt: 1_000,
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

  test('compares asks and permissions by requestedAt', () => {
    const earlyAsk = ask({ requestId: 'early-ask', requestedAt: 1_000 });
    const latePermission = permission({ requestId: 'late-perm', requestedAt: 2_000 });
    expect(nextPending([latePermission], [earlyAsk])?.kind).toBe('ask');
    expect(nextPending([latePermission], [earlyAsk])?.request.requestId).toBe('early-ask');

    const earlyPermission = permission({ requestId: 'early-perm', requestedAt: 500 });
    expect(nextPending([earlyPermission], [earlyAsk])?.kind).toBe('permission');
  });

  test('returns null when nothing is pending', () => {
    expect(nextPending([], [])).toBeNull();
  });
});

describe('pendingQueue (S3 queue)', () => {
  test('splits one ask into one item per question with stable keys', () => {
    const items = pendingQueue(
      [],
      [
        ask({
          requestId: 'ask-multi',
          questions: [
            { header: 'Q1', question: 'First?' },
            { header: 'Q2', question: 'Second?' },
            { header: 'Q3', question: 'Third?' },
          ],
        }),
      ],
    );

    expect(items.map((item) => item.key)).toEqual(['ask-multi:0', 'ask-multi:1', 'ask-multi:2']);
    expect(items.map((item) => (item.kind === 'ask' ? item.questionIndex : -1))).toEqual([0, 1, 2]);
    expect(items.every((item) => item.kind === 'ask')).toBe(true);
  });

  test('prefers permissions on a requestedAt tie and sorts by requestId', () => {
    const perm = permission({ requestId: 'perm-tie', requestedAt: 1_000 });
    const sameTimeAsk = ask({ requestId: 'ask-tie', requestedAt: 1_000 });
    expect(pendingQueue([perm], [sameTimeAsk]).map((item) => item.key)).toEqual([
      'perm:perm-tie',
      'ask-tie:0',
    ]);

    const first = permission({ requestId: 'perm-b', requestedAt: 2_000 });
    const second = permission({ requestId: 'perm-a', requestedAt: 2_000 });
    expect(pendingQueue([first, second], []).map((item) => item.key)).toEqual([
      'perm:perm-a',
      'perm:perm-b',
    ]);
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
});

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

describe('ask prompt (composer slot)', () => {
  test('replaces the input box with the ask card instead of a global modal', () => {
    const markup = renderToStaticMarkup(
      <AskPrompt request={ask()} onSubmit={() => {}} onCancel={() => {}} />,
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
      <AskPrompt request={ask()} onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(markup).toContain('btn-primary');
    expect(markup).toContain('disabled');
  });

  test('renders only the current question with progress and a next button', () => {
    const markup = renderToStaticMarkup(
      <AskPrompt
        request={ask({
          requestId: 'ask-multi',
          questions: [
            { header: 'Q1', question: 'First question?' },
            { header: 'Q2', question: 'Second question?' },
            { header: 'Q3', question: 'Third question?' },
          ],
        })}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(markup).toContain('第 1 / 3 题');
    expect(markup).toContain('下一题');
    expect(markup).not.toContain('提交');
    expect(markup).toContain('First question?');
    expect(markup).not.toContain('Second question?');
    expect(markup).not.toContain('Third question?');
  });
});
