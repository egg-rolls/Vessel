import { beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrphanedNoticeRow, OrphanedNotices } from '../src/domains/chat/OrphanedNotices';
import type { OrphanedInteraction } from '../src/gateway/interaction-hydration';
import { setLocale } from '../src/i18n';

beforeEach(() => {
  setLocale('zh-CN');
});

function orphan(overrides: Partial<OrphanedInteraction> = {}): OrphanedInteraction {
  return {
    kind: 'permission',
    requestId: 'perm-1',
    runId: 'run-1234567890abcdef',
    sessionId: 'session-1',
    tool: 'bash',
    createdAt: 1_000,
    ...overrides,
  };
}

describe('OrphanedNotices (SSR)', () => {
  test('shows the invalid text and a close button, with no decision buttons', () => {
    const markup = renderToStaticMarkup(
      <OrphanedNotices items={[orphan()]} onDismiss={() => {}} />,
    );

    expect(markup).toContain('已失效（run 已结束 / 进程重启）');
    expect(markup).toContain('关闭');
    expect(markup).toContain('工具 bash');
    expect(markup).toContain('run run-12345678…');
    // 失效卡片没有任何可点应答动作，也不复用可应答卡片。
    expect(markup).not.toContain('permission-card');
    expect(markup).not.toContain('ask-card');
    expect(markup).not.toContain('本次允许');
    expect(markup).not.toContain('拒绝');
    expect(markup).not.toContain('提交');
    expect(markup).not.toContain('data-request-id');
  });

  test('labels ask orphans with ask instead of a tool name', () => {
    const markup = renderToStaticMarkup(
      <OrphanedNoticeRow item={orphan({ kind: 'ask', tool: undefined })} onDismiss={() => {}} />,
    );
    expect(markup).toContain('提问');
    expect(markup).not.toContain('工具');
  });

  test('renders nothing for an empty list', () => {
    expect(renderToStaticMarkup(<OrphanedNotices items={[]} onDismiss={() => {}} />)).toBe('');
  });

  test('renders one row per orphan, newest first as given', () => {
    const markup = renderToStaticMarkup(
      <OrphanedNotices
        items={[orphan({ requestId: 'a' }), orphan({ requestId: 'b', runId: 'run-b' })]}
        onDismiss={() => {}}
      />,
    );
    expect(markup.match(/class="orphan-notice"/g)).toHaveLength(2);
    expect(markup).toContain('run-b');
  });
});
