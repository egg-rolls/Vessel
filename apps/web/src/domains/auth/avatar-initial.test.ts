/**
 * 头像首字母：只要「第一个字」这一点被改坏，界面上就是空圆圈或半截 emoji。
 */

import { describe, expect, test } from 'bun:test';
import { avatarInitial } from './avatar-initial';

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
