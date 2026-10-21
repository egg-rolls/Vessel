import { describe, expect, it } from 'bun:test';
import { buildToolCard, formatDuration, formatTokens } from '../src/components/UiItemView.js';
import type { ToolCallView } from '../src/repl/project/ui-item.js';

function view(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: 'c1',
    name: 'bash',
    args: { command: 'ls -la' },
    status: 'completed',
    title: 'bash',
    subtitle: 'ls -la',
    result: 'a\nb\nc\nd\ne',
    durationMs: 42,
    ...overrides,
  };
}

describe('buildToolCard', () => {
  it('参数永远显示：subtitle 出现在头行', () => {
    const card = buildToolCard(view());
    expect(card.header).toContain('bash');
    expect(card.header).toContain('ls -la');
  });

  it('状态字形与色调：running ◐ warn / completed ✓ / failed ✗ danger', () => {
    expect(buildToolCard(view({ status: 'running' })).header.startsWith('◐')).toBe(true);
    expect(buildToolCard(view({ status: 'running' })).headerTone).toBe('warn');
    expect(buildToolCard(view()).header.startsWith('✓')).toBe(true);
    const failed = buildToolCard(view({ status: 'failed' }));
    expect(failed.header.startsWith('✗')).toBe(true);
    expect(failed.headerTone).toBe('danger');
  });

  it('耗时右对齐到 columns - 1', () => {
    const card = buildToolCard(view(), { columns: 40 });
    expect(card.header.endsWith('42ms')).toBe(true);
    expect(card.header.length).toBeLessThanOrEqual(39);
  });

  it('结果默认 3 行 + 折叠提示；expanded 展示完整原文', () => {
    const collapsed = buildToolCard(view());
    const resultLines = collapsed.lines.filter((line) => line.text.startsWith('  │ '));
    expect(resultLines).toHaveLength(3);
    expect(collapsed.lines.some((line) => line.text.includes('2 more lines'))).toBe(true);

    const expanded = buildToolCard(view(), { expanded: true });
    const expandedLines = expanded.lines.filter((line) => line.text.startsWith('  │ '));
    expect(expandedLines).toHaveLength(5);
    expect(expanded.lines.some((line) => line.text.includes('more lines'))).toBe(false);
  });

  it('error envelope 显示 code / category / phase / retryable / http', () => {
    const card = buildToolCard(
      view({
        status: 'failed',
        result: undefined,
        error: 'rate limited',
        errorEnvelope: {
          error_code: 'provider_rate_limit',
          category: 'provider',
          phase: 'llm',
          retryable: true,
          http_status: 429,
        },
      }),
    );
    expect(card.lines[0]?.text).toContain('provider_rate_limit · provider · llm');
    expect(card.lines[0]?.text).toContain('retryable');
    expect(card.lines[0]?.text).toContain('http 429');
    expect(card.lines.some((line) => line.text.includes('rate limited'))).toBe(true);
  });

  it('permission 决定显示在头行与正文', () => {
    const card = buildToolCard(
      view({ permission: { requestId: 'p1', decision: 'always', at: 0 } }),
    );
    expect(card.header).toContain('always');
    expect(card.lines.some((line) => line.text.includes('always'))).toBe(true);
  });
});

describe('formatDuration / formatTokens', () => {
  it('毫秒与秒', () => {
    expect(formatDuration(42)).toBe('42ms');
    expect(formatDuration(1200)).toBe('1.2s');
    expect(formatDuration(undefined)).toBe('');
  });

  it('token 千分位压缩', () => {
    expect(formatTokens(900)).toBe('900');
    expect(formatTokens(12_345)).toBe('12.3k');
  });
});
