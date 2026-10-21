import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToastProvider } from '../src/components/ToastProvider';
import { RunCard, runDetailHref } from '../src/domains/chat/RunCard';
import type { RunGroup } from '../src/state/events';

function failedGroup(error: string): RunGroup {
  return {
    runId: 'run-1',
    sessionId: 's1',
    status: 'failed',
    error,
    items: [],
  };
}

const LONG_ERROR = `quota_exceeded: provider rejected the request\n第二行保持原样\n${'x'.repeat(300)}\n尾端标记-END`;

describe('RunCard failed footer', () => {
  test('renders the full error in an expandable details body', () => {
    const markup = renderToStaticMarkup(
      <RunCard
        group={failedGroup(LONG_ERROR)}
        cancelled={false}
        cancelling={false}
        onCancel={() => {}}
      />,
    );

    // 折叠入口 + 完整错误：字数超过 240 的部分只出现在展开后的 body。
    expect(markup).toContain('<details');
    expect(markup).toContain('run-error-body');
    expect(markup).toContain('尾端标记-END');
    expect(markup).toContain('第二行保持原样');
    expect(markup).toContain('展开');
    // 错误码映射给出可执行提示。
    expect(markup).toContain('已超出 tenant 配额。');
    // 运行详情深链。
    expect(markup).toContain('查看运行详情');
    expect(markup).toContain('#/runs?tab=live&amp;run=run-1&amp;session=s1');
  });

  test('keeps short errors visible and does not add a bogus hint', () => {
    const markup = renderToStaticMarkup(
      <RunCard
        group={failedGroup('boom')}
        cancelled={false}
        cancelling={false}
        onCancel={() => {}}
      />,
    );
    expect(markup).toContain('boom');
    expect(markup).not.toContain('run-error-hint');
    expect(markup).not.toContain('展开');
  });
});

describe('RunCard error metadata', () => {
  test('renders additive code/category/phase chips and retryable hint', () => {
    const markup = renderToStaticMarkup(
      <RunCard
        group={{
          ...failedGroup('boom'),
          errorMeta: {
            code: 'provider_timeout',
            category: 'provider',
            phase: 'llm',
            retryable: true,
          },
        }}
        cancelled={false}
        cancelling={false}
        onCancel={() => {}}
      />,
    );
    expect(markup).toContain('error-meta');
    expect(markup).toContain('provider_timeout · provider · llm');
    expect(markup).toContain('可重试');
  });

  test('leaves 0.13 markup unchanged when metadata is absent', () => {
    const markup = renderToStaticMarkup(
      <RunCard
        group={failedGroup('boom')}
        cancelled={false}
        cancelling={false}
        onCancel={() => {}}
      />,
    );
    expect(markup).not.toContain('error-meta');
  });
});

describe('runDetailHref', () => {
  test('builds the live run deep link with an optional session', () => {
    expect(runDetailHref({ runId: 'r1' })).toBe('#/runs?tab=live&run=r1');
    expect(runDetailHref({ runId: 'r1', sessionId: 's 1' })).toBe(
      '#/runs?tab=live&run=r1&session=s+1',
    );
  });
});

describe('RunCard verbosity', () => {
  const mixedItems: RunGroup['items'] = [
    { kind: 'reasoning', text: 'REASONING-MARKER', key: 'reasoning-1' },
    {
      kind: 'tool',
      key: 'tool-done',
      name: 'done-marker-tool',
      status: 'done',
      args: { command: 'ls' },
      result: 'DONE-TOOL-RESULT',
      startedAt: 1_700_000_000_000,
    },
    {
      kind: 'tool',
      key: 'tool-error',
      name: 'failed-marker-tool',
      status: 'error',
      args: { command: 'false' },
      error: 'FAILED-TOOL-ERROR',
      startedAt: 1_700_000_000_000,
    },
    { kind: 'text', text: 'ANSWER-MARKER', key: 'text-1' },
  ];

  function group(verbosity: 'minimal' | 'normal') {
    return (
      <ToastProvider>
        <RunCard
          group={{
            runId: 'run-1',
            sessionId: 'session-1',
            status: 'running',
            items: mixedItems,
          }}
          cancelled={false}
          cancelling={false}
          onCancel={() => {}}
          verbosity={verbosity}
        />
      </ToastProvider>
    );
  }

  test('normal keeps reasoning and successful tool cards', () => {
    const markup = renderToStaticMarkup(group('normal'));
    expect(markup).toContain('REASONING-MARKER');
    expect(markup).toContain('done-marker-tool');
    expect(markup).toContain('ANSWER-MARKER');
  });

  test('minimal hides reasoning and successful tools but never hides failures', () => {
    const markup = renderToStaticMarkup(group('minimal'));
    expect(markup).not.toContain('REASONING-MARKER');
    expect(markup).not.toContain('done-marker-tool');
    expect(markup).toContain('failed-marker-tool');
    expect(markup).toContain('FAILED-TOOL-ERROR');
    expect(markup).toContain('ANSWER-MARKER');
  });
});
