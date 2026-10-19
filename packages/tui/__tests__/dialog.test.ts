import { describe, expect, it } from 'bun:test';
import {
  computeDialogWidth,
  DIALOG_MAX_WIDTH,
  displayWidth,
  truncateToWidth,
} from '../src/utils/dialog.js';

describe('computeDialogWidth', () => {
  it('宽终端封顶 72 列', () => {
    expect(computeDialogWidth(200)).toBe(DIALOG_MAX_WIDTH);
    expect(computeDialogWidth(76)).toBe(72);
  });

  it('窄终端按 columns - 4 收缩', () => {
    expect(computeDialogWidth(80)).toBe(72);
    expect(computeDialogWidth(60)).toBe(56);
    expect(computeDialogWidth(40)).toBe(36);
  });

  it('拿不到宽度时回退 80 列（封顶 72）', () => {
    expect(computeDialogWidth(undefined)).toBe(72);
    expect(computeDialogWidth(Number.NaN)).toBe(72);
    expect(computeDialogWidth(0)).toBe(72);
    expect(computeDialogWidth(-10)).toBe(72);
  });

  it('异常窄终端也有正宽度', () => {
    expect(computeDialogWidth(1)).toBe(1);
    expect(computeDialogWidth(4)).toBe(1);
  });
});

describe('displayWidth / truncateToWidth', () => {
  it('CJK 与 emoji 按 2 列计', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('🚀')).toBe(2);
  });

  it('未超宽时原样返回', () => {
    expect(truncateToWidth('/resume 恢复会话', 20)).toBe('/resume 恢复会话');
  });

  it('超宽时按显示宽度截断并保留 …', () => {
    const out = truncateToWidth('恢复会话并继续之前的上下文', 10);
    expect(displayWidth(out)).toBeLessThanOrEqual(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('宽度 <= 0 返回空串', () => {
    expect(truncateToWidth('abc', 0)).toBe('');
    expect(truncateToWidth('abc', -1)).toBe('');
  });
});
