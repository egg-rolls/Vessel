import { describe, expect, it } from 'bun:test';
import {
  contextBar,
  contextTone,
  formatStatusRule,
  type StatusRuleProps,
} from '../src/components/StatusBar.js';
import { displayWidth } from '../src/utils/text-layout.js';

const base: StatusRuleProps = {
  status: 'thinking',
  model: 'deepseek/deepseek-flash',
  context: { used: 12400, max: 64000 },
  durationMs: 102000,
  compactions: 3,
  sessions: 2,
  cwd: '~/work/vessel',
  branch: '0.7-tui',
};

function line(props: StatusRuleProps, columns: number): string {
  return formatStatusRule(props, columns)
    .map((segment) => segment.text)
    .join('');
}

describe('formatStatusRule', () => {
  it('80 列丢弃 cwd/branch，且不超列宽', () => {
    const text = line(base, 80);

    expect(displayWidth(text)).toBeLessThanOrEqual(76);
    expect(text).not.toContain('0.7-tui');
    expect(text).not.toContain('~/work/vessel');
    expect(text).toContain('ctx');
    expect(text).toContain('[');
  });

  it('80–99 列即使空间足够也不显示 cwd', () => {
    const text = line({ status: 'idle', model: 'v3', cwd: '~/w', branch: 'b' }, 80);

    expect(text).not.toContain('~/w');
    expect(text).not.toContain(' b');
  });

  it('60 列去掉进度条但保留 used/max 与百分比', () => {
    const text = line(base, 60);

    expect(displayWidth(text)).toBeLessThanOrEqual(56);
    expect(text).not.toContain('[');
    expect(text).toContain('12.4K/64K');
    expect(text).toContain('19%');
  });

  it('24–59 列只留状态与 model', () => {
    const text = line(base, 40);

    expect(text).toBe('─ ● thinking │ deepseek-flash');
    expect(displayWidth(text)).toBeLessThanOrEqual(36);
    expect(text).not.toContain('1m');
    expect(text).not.toContain('cmp');
    expect(text).not.toContain('sess');
    expect(text).not.toContain('ctx');
  });

  it('小于 24 列只留状态', () => {
    const text = line(base, 20);

    expect(text).toBe('● thinking');
  });

  it('100 列以上包含 cwd 与分支，且 CJK 不溢出', () => {
    const text = line({ ...base, cwd: '~/项目/vessel-终端', branch: '功能分支' }, 160);

    expect(displayWidth(text)).toBeLessThanOrEqual(156);
    expect(text).toContain('~/项目/vessel-终端');
    expect(text).toContain('功能分支');
  });

  it('无 context.max 时只显示 token 数，不画进度条', () => {
    const text = line({ ...base, context: { used: 900 } }, 100);

    expect(text).toContain('ctx 900 tok');
    expect(text).not.toContain('[');
  });
});

describe('context helpers', () => {
  it('进度条固定 10 格', () => {
    expect(displayWidth(contextBar(0))).toBe(10);
    expect(displayWidth(contextBar(100))).toBe(10);
    expect(contextBar(19)).toBe('██░░░░░░░░');
  });

  it('阈值边界：50 warn / 81 bad / 95 critical', () => {
    expect(contextTone(49)).toBe('statusGood');
    expect(contextTone(50)).toBe('statusWarn');
    expect(contextTone(80)).toBe('statusWarn');
    expect(contextTone(81)).toBe('statusBad');
    expect(contextTone(95)).toBe('statusCritical');
  });
});
