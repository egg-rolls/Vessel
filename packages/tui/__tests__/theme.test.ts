import { describe, expect, it } from 'bun:test';
import { createTheme, detectColorLevel } from '../src/theme.js';

describe('detectColorLevel', () => {
  it('默认 16 色', () => {
    expect(detectColorLevel({})).toBe(1);
  });

  it('NO_COLOR / FORCE_COLOR=0 / TERM=dumb -> 无色', () => {
    expect(detectColorLevel({ NO_COLOR: '1', TERM: 'xterm-256color' })).toBe(0);
    expect(detectColorLevel({ FORCE_COLOR: '0', TERM: 'xterm-256color' })).toBe(0);
    expect(detectColorLevel({ TERM: 'dumb' })).toBe(0);
  });

  it('FORCE_COLOR 覆盖 NO_COLOR', () => {
    expect(detectColorLevel({ NO_COLOR: '1', FORCE_COLOR: '1' })).toBe(1);
  });

  it('truecolor 检测', () => {
    expect(detectColorLevel({ COLORTERM: 'truecolor' })).toBe(3);
    expect(detectColorLevel({ COLORTERM: '24bit' })).toBe(3);
    expect(detectColorLevel({ TERM: 'xterm-direct' })).toBe(1);
    expect(detectColorLevel({ FORCE_COLOR: '3' })).toBe(3);
  });

  it('256 色检测', () => {
    expect(detectColorLevel({ TERM: 'xterm-256color' })).toBe(2);
    expect(detectColorLevel({ WT_SESSION: 'session-id' })).toBe(2);
    expect(detectColorLevel({ FORCE_COLOR: '2' })).toBe(2);
  });
});

const ANSI16_NAMES = new Set([
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'blackBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
  'gray',
  'grey',
]);

describe('createTheme', () => {
  it('level 0 关闭全部颜色', () => {
    const fallback = createTheme(0);
    expect(Object.values(fallback).every((value) => value === undefined)).toBe(true);
  });

  it('level 1 全部使用命名 ANSI 色', () => {
    for (const color of Object.values(createTheme(1))) {
      expect(typeof color).toBe('string');
      expect(ANSI16_NAMES.has(color as string)).toBe(true);
    }
  });

  it('level 2/3 使用 hex 真彩色', () => {
    expect(createTheme(2)).toEqual(createTheme(3));
    for (const color of Object.values(createTheme(3))) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('selectedInk 是彩色选中底上的可读前景，selectedBg 只作背景', () => {
    expect(createTheme(3).selectedInk).toBe('#1c1a17');
    expect(createTheme(1).selectedInk).toBe('black');
    expect(createTheme(0).selectedInk).toBeUndefined();
    // 前景与选中背景不能是同一个 token（ConfirmDialog 的对比度回归）
    expect(createTheme(3).selectedInk).not.toBe(createTheme(3).selectedBg);
  });
});
