import { describe, expect, it } from 'bun:test';
import {
  CLEAR_ON_START_SEQUENCE,
  maybeClearOnStart,
  shouldClearOnStart,
} from '../src/repl/clear-on-start.js';

describe('进入 REPL 清屏', () => {
  it('TTY + 默认（undefined）写一次清屏 + 光标归位', () => {
    const writes: string[] = [];
    const written = maybeClearOnStart({
      isTTY: true,
      clearOnStart: undefined,
      write: (text) => writes.push(text),
    });

    expect(written).toBe(true);
    expect(writes).toEqual(['\x1b[2J\x1b[H']);
    expect(CLEAR_ON_START_SEQUENCE).toBe('\x1b[2J\x1b[H');
  });

  it('ui.clearOnStart=false 不清屏', () => {
    const writes: string[] = [];
    const written = maybeClearOnStart({
      isTTY: true,
      clearOnStart: false,
      write: (text) => writes.push(text),
    });

    expect(written).toBe(false);
    expect(writes).toEqual([]);
  });

  it('非 TTY 不清屏（即使 clearOnStart=true）', () => {
    const writes: string[] = [];
    const written = maybeClearOnStart({
      isTTY: false,
      clearOnStart: true,
      write: (text) => writes.push(text),
    });

    expect(written).toBe(false);
    expect(writes).toEqual([]);
  });

  it('shouldClearOnStart 只在 TTY 且未显式关闭时为 true', () => {
    expect(shouldClearOnStart(true, undefined)).toBe(true);
    expect(shouldClearOnStart(true, true)).toBe(true);
    expect(shouldClearOnStart(true, false)).toBe(false);
    expect(shouldClearOnStart(false, undefined)).toBe(false);
  });
});
