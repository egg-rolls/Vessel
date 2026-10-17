import { describe, expect, it } from 'bun:test';
import { type ConfirmChoice, moveConfirmSelection } from '../src/components/ConfirmDialog.js';

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
});
