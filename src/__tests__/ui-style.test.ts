import { describe, expect, it } from 'bun:test';
import { createUiStyle, DARK_GOLD, DARK_GOLD_BRIGHT, shouldUseColor, truecolor } from '../ui-style';

const GOLD = '\x1b[38;2;208;138;58m';
const GOLD_BRIGHT = '\x1b[38;2;232;169;76m';
const RESET = '\x1b[0m';

describe('ui-style', () => {
  it('dark gold truecolor 编码', () => {
    expect(DARK_GOLD).toBe('#d08a3a');
    expect(DARK_GOLD_BRIGHT).toBe('#e8a94c');
    expect(truecolor(DARK_GOLD)).toBe(GOLD);
    expect(truecolor('#E8A94C')).toBe(GOLD_BRIGHT);
    expect(truecolor('not-a-color')).toBe('');
  });

  it('TTY 下输出暗金 ANSI', () => {
    const ui = createUiStyle({ isTTY: true, env: {} });
    expect(ui.color).toBe(true);
    expect(ui.brand('x')).toBe(`${GOLD}x${RESET}`);
    expect(ui.title('t')).toContain(GOLD_BRIGHT);
    expect(ui.title('t')).toContain('\x1b[1m');
    expect(ui.ok('ok')).toBe(`\x1b[32mok${RESET}`);
    expect(ui.err('bad')).toBe(`\x1b[31mbad${RESET}`);
    expect(ui.warn('warn')).toBe(`\x1b[33mwarn${RESET}`);
    expect(ui.rule(3)).toBe(`${GOLD}───${RESET}`);
  });

  it('非 TTY 无 ANSI', () => {
    const ui = createUiStyle({ isTTY: false, env: {} });
    expect(ui.color).toBe(false);
    expect(ui.brand('x')).toBe('x');
    expect(ui.title('x')).toBe('x');
    expect(ui.ok('x')).toBe('x');
    expect(ui.warn('x')).toBe('x');
    expect(ui.err('x')).toBe('x');
    expect(ui.dim('x')).toBe('x');
    expect(ui.rule(4)).toBe('────');
    expect(ui.kv('a', 'b', 3)).toBe('a    b');
  });

  it('NO_COLOR（含空值）强制去色', () => {
    expect(shouldUseColor({ isTTY: true, env: { NO_COLOR: '' } })).toBe(false);
    expect(shouldUseColor({ isTTY: true, env: { NO_COLOR: '1' } })).toBe(false);
    expect(createUiStyle({ isTTY: true, env: { NO_COLOR: '1' } }).brand('x')).toBe('x');
  });

  it('TERM=dumb 去色', () => {
    expect(shouldUseColor({ isTTY: true, env: { TERM: 'dumb' } })).toBe(false);
    expect(shouldUseColor({ isTTY: true, env: { TERM: 'xterm-256color' } })).toBe(true);
  });

  it('状态符号：有色时带颜色，无色时只有符号', () => {
    const colored = createUiStyle({ isTTY: true, env: {} });
    const plain = createUiStyle({ isTTY: false, env: {} });
    expect(plain.symbol('ok')).toBe('✓');
    expect(plain.symbol('err')).toBe('✗');
    expect(colored.symbol('ok')).toContain('✓');
    expect(colored.symbol('ok')).toContain('\x1b[32m');
  });
});
