import { describe, expect, it } from 'bun:test';
import { createTheme, detectColorLevel, theme } from '../src/theme.js';

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

describe('createTheme', () => {
  it('level 0 关闭全部颜色', () => {
    const fallback = createTheme(0);
    expect(Object.values(fallback).every((value) => value === undefined)).toBe(true);
  });

  it('level 1 使用命名 ANSI 色（不用黑色/暗色正文）', () => {
    const fallback = createTheme(1);
    expect(fallback.brand).toBe('yellowBright');
    expect(fallback.faint).toBe('gray');
    expect(fallback.line).toBe('gray');
    expect(fallback.danger).toBe('redBright');
    expect(fallback.selectedBg).toBe('black');
    expect(Object.values(fallback).every((value) => value !== undefined)).toBe(true);
  });

  it('level 2/3 保持 Linen hex', () => {
    expect(createTheme(2)).toEqual(createTheme(3));
    expect(createTheme(3).brand).toBe('#c2a273');
    expect(createTheme(3).line).toBe('#4a453d');
  });

  it('默认 theme 按当前环境检测', () => {
    expect(theme).toEqual(createTheme(detectColorLevel(process.env)));
  });
});
