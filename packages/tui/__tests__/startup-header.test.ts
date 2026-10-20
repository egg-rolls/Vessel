import { describe, expect, it } from 'bun:test';
import { buildStartupHeader, WORDMARK_5 } from '../src/repl/startup-header.js';
import { displayWidth } from '../src/utils/text-layout.js';

const summary = {
  model: 'deepseek/deepseek-flash',
  sessionId: '20261018_230506_830174',
  tenantId: 'default',
  mcpCount: 2,
  interruptedRuns: 1,
};

describe('buildStartupHeader', () => {
  it('80x24 生成 7 行内容 + 单线边框，且每行不超过终端列数', () => {
    const lines = buildStartupHeader({ columns: 80, rows: 24, version: '0.7.0', summary });

    // viewWidth(80) = 78：上下边框 + 7 行内容。
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe(`╭${'─'.repeat(76)}╮`);
    expect(lines.at(-1)).toBe(`╰${'─'.repeat(76)}╯`);
    expect(lines[1]).toContain(WORDMARK_5[0]?.trimEnd() ?? '');
    expect(lines[6]).toContain('Agent Harness');
    expect(lines[7]).toContain('deepseek-flash');
    for (const line of lines) {
      expect(displayWidth(line)).toBe(78);
      expect(displayWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  it('60 列不渲染 wordmark，内容 3 行 + 边框', () => {
    const lines = buildStartupHeader({ columns: 60, rows: 24, version: '0.7.0', summary });

    expect(lines).toHaveLength(5);
    expect(lines.join('\n')).not.toContain('█');
    for (const line of lines) {
      expect(displayWidth(line)).toBe(58);
      expect(displayWidth(line)).toBeLessThanOrEqual(60);
    }
  });

  it('15/14 行内容 2 行，10 行 1 行，9 行隐藏（边框计入行数）', () => {
    expect(buildStartupHeader({ columns: 80, rows: 15, version: '0.7.0', summary })).toHaveLength(
      4,
    );
    expect(buildStartupHeader({ columns: 80, rows: 14, version: '0.7.0', summary })).toHaveLength(
      4,
    );
    expect(buildStartupHeader({ columns: 80, rows: 10, version: '0.7.0', summary })).toHaveLength(
      3,
    );
    expect(buildStartupHeader({ columns: 80, rows: 9, version: '0.7.0', summary })).toHaveLength(0);
  });

  it('CJK session 摘要在窄列下截断而不溢出', () => {
    const lines = buildStartupHeader({
      columns: 40,
      rows: 15,
      version: '0.7.0',
      summary: { model: '深度求索-模型', sessionId: '会话_20261018_230506_830174' },
    });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(displayWidth(line)).toBe(38);
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
    }
  });
});
