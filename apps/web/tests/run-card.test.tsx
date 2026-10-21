import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToastProvider } from '../src/components/ToastProvider';
import { QueuedNotice, RunItems, runDetailHref } from '../src/domains/chat/StreamItems';
import { buildGroup, type RunGroup, type StoredEvent } from '../src/state/events';

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

describe('RunItems failure notice', () => {
  test('renders the full error in an expandable details body', () => {
    const markup = renderToStaticMarkup(<RunItems group={failedGroup(LONG_ERROR)} />);

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
    const markup = renderToStaticMarkup(<RunItems group={failedGroup('boom')} />);
    expect(markup).toContain('boom');
    expect(markup).not.toContain('run-error-hint');
    expect(markup).not.toContain('展开');
  });
});

describe('RunItems error metadata', () => {
  test('renders additive code/category/phase chips and retryable hint', () => {
    const markup = renderToStaticMarkup(
      <RunItems
        group={{
          ...failedGroup('boom'),
          errorMeta: {
            code: 'provider_timeout',
            category: 'provider',
            phase: 'llm',
            retryable: true,
          },
        }}
      />,
    );
    expect(markup).toContain('error-meta');
    expect(markup).toContain('provider_timeout · provider · llm');
    expect(markup).toContain('可重试');
  });

  test('leaves 0.13 markup unchanged when metadata is absent', () => {
    const markup = renderToStaticMarkup(<RunItems group={failedGroup('boom')} />);
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

describe('RunItems verbosity', () => {
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
        <RunItems
          group={{
            runId: 'run-1',
            sessionId: 'session-1',
            status: 'running',
            items: mixedItems,
          }}
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

describe('live streaming rendering (0.17)', () => {
  function streamingGroup(overrides: Partial<RunGroup> = {}): RunGroup {
    return {
      runId: 'run-live',
      sessionId: 'session-1',
      status: 'running',
      items: [],
      ...overrides,
    };
  }

  function render(group: RunGroup, verbosity: 'minimal' | 'normal' = 'normal') {
    return renderToStaticMarkup(<RunItems group={group} verbosity={verbosity} />);
  }

  test('renders unfinished liveText while items are still empty', () => {
    const markup = render(streamingGroup({ liveText: 'partial answer' }));
    expect(markup).toContain('live-text');
    expect(markup).toContain('partial answer');
    expect(markup).not.toContain('run-footer');
  });

  test('renders liveReasoning as a streaming thinking block', () => {
    const markup = render(streamingGroup({ liveReasoning: 'live-thought' }));
    expect(markup).toContain('reasoning-block');
    expect(markup).toContain('live-thought');
    expect(markup).toContain('reasoning-live');
  });

  test('minimal keeps live body text but hides live reasoning', () => {
    const text = render(streamingGroup({ liveText: 'BODY-MARKER' }), 'minimal');
    expect(text).toContain('BODY-MARKER');
    const reasoning = render(streamingGroup({ liveReasoning: 'THINK-MARKER' }), 'minimal');
    expect(reasoning).not.toContain('THINK-MARKER');
  });

  test('after finish the text appears once: flushed item, no live duplicate', () => {
    const entries: StoredEvent[] = [
      { event: { type: 'run.started', run_id: 'run-live', data: {}, ts: 100 }, seq: 1 },
      {
        event: {
          type: 'llm.stream.chunk',
          run_id: 'run-live',
          data: { chunk: { type: 'text_delta', delta: 'Hello' } },
          ts: 101,
        },
        seq: 2,
      },
      {
        event: {
          type: 'llm.stream.chunk',
          run_id: 'run-live',
          data: { chunk: { type: 'finish' } },
          ts: 102,
        },
        seq: 3,
      },
    ];
    const group = buildGroup('run-live', entries);
    expect(group.liveText).toBeUndefined();
    const markup = render(group);
    expect(markup).toContain('Hello');
    expect(markup.split('Hello').length - 1).toBe(1);
    expect(markup).not.toContain('live-text');
  });
});

describe('running placeholder (0.17)', () => {
  function group(overrides: Partial<RunGroup> = {}): RunGroup {
    return {
      runId: 'run-wait',
      sessionId: 'session-1',
      status: 'running',
      items: [],
      ...overrides,
    };
  }

  function render(value: RunGroup, verbosity: 'minimal' | 'normal' = 'normal') {
    return renderToStaticMarkup(<RunItems group={value} verbosity={verbosity} />);
  }

  test('shows a waiting placeholder when a running run has no content', () => {
    const markup = render(group());
    expect(markup).toContain('run-waiting');
    expect(markup).toContain('正在思考…');
  });

  test('hides the placeholder once liveText or an item is visible', () => {
    expect(render(group({ liveText: 'partial' }))).not.toContain('run-waiting');
    const itemMarkup = render(group({ items: [{ kind: 'text', text: 'hello', key: 'text-1' }] }));
    expect(itemMarkup).not.toContain('run-waiting');
    expect(itemMarkup).toContain('hello');
  });

  test('hides the placeholder for live reasoning', () => {
    expect(render(group({ liveReasoning: 'thinking' }))).not.toContain('run-waiting');
  });

  test('does not show the placeholder for terminal runs', () => {
    expect(render(group({ status: 'completed' }))).not.toContain('run-waiting');
    expect(render(group({ status: 'failed' }))).not.toContain('run-waiting');
  });

  test('minimal still shows the placeholder when nothing is visible', () => {
    expect(render(group(), 'minimal')).toContain('run-waiting');
  });
});

describe('flat conversation stream (0.18)', () => {
  test('run items render without run container, divider or summary', () => {
    const markup = renderToStaticMarkup(
      <RunItems
        group={{
          runId: 'run-flat',
          sessionId: 's1',
          status: 'completed',
          items: [{ kind: 'text', text: 'FLAT-MARKER', key: 'text-1' }],
        }}
      />,
    );
    expect(markup).toContain('FLAT-MARKER');
    expect(markup).toContain('msg-assistant');
    expect(markup).not.toContain('run-section');
    expect(markup).not.toContain('run-divider');
    expect(markup).not.toContain('run-summary');
  });

  test('queued submission renders one lightweight notice', () => {
    const markup = renderToStaticMarkup(
      <QueuedNotice
        item={{
          runId: 'run-q',
          sessionId: 's1',
          input: 'QUEUED-MARKER',
          queuePosition: 2,
          submittedAt: 1_000,
          cancelling: false,
          cancelled: false,
        }}
        onCancel={() => {}}
      />,
    );
    expect(markup).toContain('stream-notice');
    expect(markup).toContain('排队中 · 第 2 位');
    expect(markup).toContain('QUEUED-MARKER');
    expect(markup).toContain('取消排队');
    expect(markup).not.toContain('run-section');
  });
});
