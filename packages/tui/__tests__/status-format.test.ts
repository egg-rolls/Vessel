import { describe, expect, it } from 'bun:test';
import {
  applyStatusBarToggle,
  formatPathLabel,
  MARQUEE_PAUSE_MS,
  MARQUEE_TICK_MS,
  marqueeOffset,
  marqueeWindow,
  matchStatusBarHotkey,
  middleEllipsisPath,
  parseStatusBars,
  resolveInitialStatusBars,
  statusBarsValue,
  statusBarsVisibility,
} from '../src/repl/status-format.js';
import { displayWidth } from '../src/utils/text-layout.js';

describe('status bars visibility', () => {
  it('YAML 值与显隐互转', () => {
    expect(statusBarsValue(true, true)).toBe('both');
    expect(statusBarsValue(true, false)).toBe('top');
    expect(statusBarsValue(false, true)).toBe('bottom');
    expect(statusBarsValue(false, false)).toBe('none');
    expect(statusBarsVisibility('bottom')).toEqual({ top: false, bottom: true });
    expect(statusBarsVisibility('both')).toEqual({ top: true, bottom: true });
  });

  it('解析 top,bottom 兼容写法；非法值忽略', () => {
    expect(parseStatusBars('top,bottom')).toBe('both');
    expect(parseStatusBars(' BOTTOM ')).toBe('bottom');
    expect(parseStatusBars('both')).toBe('both');
    expect(parseStatusBars('none')).toBe('none');
    expect(parseStatusBars('top, none')).toBeUndefined();
    expect(parseStatusBars(undefined)).toBeUndefined();
  });

  it('初始值 env > config > 默认', () => {
    expect(resolveInitialStatusBars({ env: 'none', config: 'both' })).toEqual({
      value: 'none',
      source: 'env',
    });
    expect(resolveInitialStatusBars({ env: 'garbage', config: 'both' })).toEqual({
      value: 'both',
      source: 'config',
    });
    expect(resolveInitialStatusBars({ env: undefined, config: undefined })).toEqual({
      value: undefined,
      source: 'none',
    });
  });

  it('Ctrl 热键匹配；切换返回写回值与输入重置标记', () => {
    expect(matchStatusBarHotkey('t', { ctrl: true })).toBe('toggleTop');
    expect(matchStatusBarHotkey('g', { ctrl: true })).toBe('toggleBottom');
    expect(matchStatusBarHotkey('r', { ctrl: true })).toBe('openSessions');
    expect(matchStatusBarHotkey('t', { ctrl: false })).toBeNull();

    const offTop = applyStatusBarToggle({ top: true, bottom: true }, 'top');
    expect(offTop).toEqual({
      visibility: { top: false, bottom: true },
      value: 'bottom',
      resetInput: true,
    });
    const onBottom = applyStatusBarToggle({ top: false, bottom: false }, 'bottom');
    expect(onBottom.value).toBe('bottom');
  });
});

describe('middleEllipsisPath', () => {
  it('放得下时原样返回', () => {
    expect(middleEllipsisPath('~/work/vessel', 40)).toBe('~/work/vessel');
  });

  it('Windows 盘符：保留根 + 末两级', () => {
    expect(middleEllipsisPath('D:\\Application\\APP\\Vessel\\Vessel', 24)).toBe(
      'D:\\…\\Vessel\\Vessel',
    );
  });

  it('POSIX 绝对路径：保留 / + 末两级', () => {
    expect(middleEllipsisPath('/home/user/projects/vessel', 18)).toBe('/…/projects/vessel');
  });

  it('home 路径与末一级降级', () => {
    expect(middleEllipsisPath('~/work/projects/vessel/packages/tui', 20)).toBe('~/…/packages/tui');
    expect(middleEllipsisPath('~/alpha/beta', 9)).toBe('~/…/beta');
  });

  it('CJK 路径按显示宽度计算，不溢出', () => {
    const text = middleEllipsisPath('~/项目/文档/深层/终端/vessel', 20);
    expect(text).toContain('…');
    expect(displayWidth(text)).toBeLessThanOrEqual(20);
  });
});

describe('marqueeWindow', () => {
  it('放得下时原样返回；预算 0 返回空', () => {
    expect(marqueeWindow('abcdef', 6, 0)).toBe('abcdef');
    expect(marqueeWindow('abcdef', 0, 0)).toBe('');
  });

  it('起点右侧补 …，终点左侧补 …，中间两侧都有', () => {
    expect(marqueeWindow('abcdefghij', 5, 0)).toBe('abcd…');
    expect(marqueeWindow('abcdefghij', 5, 2)).toBe('…cde…');
    expect(marqueeWindow('abcdefghij', 5, 5)).toBe('…fghi');
  });

  it('偏移越界被钳制；结果宽度恒 <= 预算', () => {
    expect(marqueeWindow('abcdefghij', 5, 999)).toBe('…fghi');
    expect(marqueeWindow('abcdefghij', 5, -5)).toBe('abcd…');
    expect(displayWidth(marqueeWindow('abcdefghij', 4, 3))).toBeLessThanOrEqual(4);
  });

  it('CJK 宽字符跨边界时整字跳过，不打印半个字', () => {
    const text = marqueeWindow('项目文档深层终端', 5, 3);
    expect(displayWidth(text)).toBeLessThanOrEqual(5);
    expect(text).toContain('…');
  });
});

describe('marqueeOffset', () => {
  const overflow = 4;
  const travel = overflow * MARQUEE_TICK_MS;
  const cycle = 2 * (MARQUEE_PAUSE_MS + travel);

  it('首尾各停 1.2s', () => {
    expect(marqueeOffset(0, overflow)).toBe(0);
    expect(marqueeOffset(MARQUEE_PAUSE_MS - 1, overflow)).toBe(0);
    expect(marqueeOffset(MARQUEE_PAUSE_MS + travel, overflow)).toBe(4);
    expect(marqueeOffset(MARQUEE_PAUSE_MS + travel + MARQUEE_PAUSE_MS - 1, overflow)).toBe(4);
  });

  it('按 1 格 / 140ms 往返', () => {
    expect(marqueeOffset(MARQUEE_PAUSE_MS, overflow)).toBe(0);
    expect(marqueeOffset(MARQUEE_PAUSE_MS + MARQUEE_TICK_MS, overflow)).toBe(1);
    expect(marqueeOffset(MARQUEE_PAUSE_MS + travel - 1, overflow)).toBe(3);
    expect(
      marqueeOffset(MARQUEE_PAUSE_MS + travel + MARQUEE_PAUSE_MS + MARQUEE_TICK_MS, overflow),
    ).toBe(3);
  });

  it('循环取模；无溢出恒为 0', () => {
    expect(marqueeOffset(cycle, overflow)).toBe(0);
    expect(marqueeOffset(cycle + MARQUEE_PAUSE_MS + MARQUEE_TICK_MS, overflow)).toBe(1);
    expect(marqueeOffset(999999, 0)).toBe(0);
    expect(marqueeOffset(-100, overflow)).toBe(0);
  });
});

describe('formatPathLabel', () => {
  const longCwd = '~/work/projects/very/long/vessel/packages/tui';

  it('完整放得下时不省略', () => {
    expect(formatPathLabel({ cwd: '~/work/vessel', branch: 'main', budget: 40 })).toBe(
      '~/work/vessel · main',
    );
  });

  it('放不下时中间省略，branch 固定最右', () => {
    const text = formatPathLabel({ cwd: longCwd, branch: '0.13-tui', budget: 28 });
    expect(text).toContain('…/packages/tui');
    expect(text.endsWith('0.13-tui')).toBe(true);
    expect(displayWidth(text)).toBeLessThanOrEqual(28);
  });

  it('branch 自身超 24 格才尾部截断', () => {
    const branch = 'feature/very-long-branch-name-that-exceeds';
    const text = formatPathLabel({ cwd: '~/w', branch, budget: 30 });
    expect(text.endsWith('…')).toBe(true);
    expect(displayWidth(text)).toBeLessThanOrEqual(30);
  });

  it('idle + 偏移时滚动路径；运行态冻结中间省略', () => {
    const idle = formatPathLabel({
      cwd: longCwd,
      branch: 'main',
      budget: 24,
      idle: true,
      marqueeOffset: 0,
    });
    const running = formatPathLabel({
      cwd: longCwd,
      branch: 'main',
      budget: 24,
      idle: false,
      marqueeOffset: 0,
    });
    expect(idle.startsWith('~/work')).toBe(true);
    expect(running).toContain('…/packages/tui');
    expect(idle).not.toBe(running);
    expect(displayWidth(idle)).toBeLessThanOrEqual(24);
    expect(displayWidth(running)).toBeLessThanOrEqual(24);
  });

  it('CJK 路径与 branch 均不溢出', () => {
    const text = formatPathLabel({
      cwd: '~/项目/文档/深层/vessel',
      branch: '功能分支',
      budget: 22,
    });
    expect(displayWidth(text)).toBeLessThanOrEqual(22);
    expect(text).toContain('功能分支');
  });
});
