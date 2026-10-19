import { describe, expect, it } from 'bun:test';
import {
  type ConfirmChoice,
  formatConfirmChoice,
  moveConfirmSelection,
} from '../src/components/ConfirmDialog.js';

describe('moveConfirmSelection', () => {
  it('左右切换', () => {
    expect(moveConfirmSelection('y', 'right')).toBe('n');
    expect(moveConfirmSelection('n', 'right')).toBe('always');
    expect(moveConfirmSelection('always', 'left')).toBe('n');
    expect(moveConfirmSelection('n', 'left')).toBe('y');
  });

  it('边界不越界', () => {
    expect(moveConfirmSelection('y', 'left')).toBe('y');
    expect(moveConfirmSelection('always', 'right')).toBe('always');
  });

  it('类型覆盖三个选项', () => {
    const choices: ConfirmChoice[] = ['y', 'n', 'always'];
    expect(choices).toHaveLength(3);
  });

  it('选中项始终带非颜色标记 ▸', () => {
    expect(formatConfirmChoice('y', true)).toBe('▸[Y]es ');
    expect(formatConfirmChoice('y', false)).toBe(' [Y]es ');
    expect(formatConfirmChoice('n', true)).toBe('▸[N]o ');
    expect(formatConfirmChoice('always', true)).toBe('▸[A]lways ');
    expect(formatConfirmChoice('always', false)).toBe(' [A]lways ');
  });
});
