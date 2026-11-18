/**
 * 头像字符：单字 / 双字母 / 无身份三种输出。改坏这一处的表现是「空圆圈」或「半截 emoji」。
 */

import { describe, expect, test } from 'bun:test';
import { avatarInitial, avatarMonogram } from './avatar-initial';

describe('avatarInitial', () => {
  test('拉丁字母取首字母并大写', () => {
    expect(avatarInitial('ada')).toBe('A');
    expect(avatarInitial('Ada Lovelace')).toBe('A');
  });

  test('CJK 取第一个字（不按 UTF-16 单元切）', () => {
    expect(avatarInitial('张三')).toBe('张');
  });

  test('emoji / 代理对只取一个码点', () => {
    expect(avatarInitial('🐙 octopus')).toBe('🐙');
  });

  test('空值 / 全空白 ⇒ 占位符', () => {
    expect(avatarInitial('')).toBe('?');
    expect(avatarInitial('   ')).toBe('?');
    expect(avatarInitial(null)).toBe('?');
    expect(avatarInitial(undefined)).toBe('?');
  });
});

describe('avatarMonogram', () => {
  test('中文只取首字（不拼双字）', () => {
    expect(avatarMonogram('张三')).toBe('张');
    expect(avatarMonogram('张三 Zhang')).toBe('张');
    expect(avatarMonogram('欧阳修')).toBe('欧');
  });

  test('英文多词取前两个首字母（大写）', () => {
    expect(avatarMonogram('Ada Lovelace')).toBe('AL');
    expect(avatarMonogram('ada lovelace')).toBe('AL');
    expect(avatarMonogram('Grace Brewster Hopper')).toBe('GB');
  });

  test('单词只取首字母', () => {
    expect(avatarMonogram('ada')).toBe('A');
    expect(avatarMonogram('Ada')).toBe('A');
  });

  test('`-` / `_` / `.` 也算词分隔（GitHub 那种登录名）', () => {
    expect(avatarMonogram('ada-lovelace')).toBe('AL');
    expect(avatarMonogram('ada_lovelace')).toBe('AL');
    expect(avatarMonogram('ada.lovelace')).toBe('AL');
  });

  test('第二个词不是字母时退回单字母（`u_1` 不该变成 `U1`）', () => {
    expect(avatarMonogram('u_1')).toBe('U');
    expect(avatarMonogram(null, 'u_1')).toBe('U');
  });

  test('没有 name 时用 id', () => {
    expect(avatarMonogram('', 'ada-lovelace')).toBe('AL');
    expect(avatarMonogram(null, 'zhang')).toBe('Z');
  });

  test('两者都没有 / 全是空白 ⇒ null（组件画通用人形，不显示问号）', () => {
    expect(avatarMonogram(null, null)).toBeNull();
    expect(avatarMonogram('', '')).toBeNull();
    expect(avatarMonogram('   ', '  ')).toBeNull();
    expect(avatarMonogram(undefined)).toBeNull();
  });

  test('emoji 名只取一个码点', () => {
    expect(avatarMonogram('🐙 octopus')).toBe('🐙');
  });
});
