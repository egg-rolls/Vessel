/**
 * 候选图源：顺序、去重、以及「哪些 URL 不许发出去」。
 */

import { describe, expect, test } from 'bun:test';
import { AVATAR_ENDPOINT, avatarCandidates, safeAvatarUrl } from './avatar-source';

describe('safeAvatarUrl', () => {
  test('放行 http(s) 与站点内路径', () => {
    expect(safeAvatarUrl('https://avatars.githubusercontent.com/u/1')).toBe(
      'https://avatars.githubusercontent.com/u/1',
    );
    expect(safeAvatarUrl('http://127.0.0.1:8642/a.png')).toBe('http://127.0.0.1:8642/a.png');
    expect(safeAvatarUrl('/auth/avatar')).toBe('/auth/avatar');
    expect(safeAvatarUrl('uploads/a.png')).toBe('uploads/a.png');
    expect(safeAvatarUrl('  /a.png  ')).toBe('/a.png');
  });

  test('挡掉其它 scheme 与协议相对地址（不进候选，等于静默跳过）', () => {
    expect(safeAvatarUrl('javascript:alert(1)')).toBeNull();
    expect(safeAvatarUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(safeAvatarUrl('blob:http://x/1')).toBeNull();
    expect(safeAvatarUrl('//evil.example/a.png')).toBeNull();
  });

  test('空值 ⇒ null', () => {
    expect(safeAvatarUrl('')).toBeNull();
    expect(safeAvatarUrl('   ')).toBeNull();
    expect(safeAvatarUrl(null)).toBeNull();
    expect(safeAvatarUrl(undefined)).toBeNull();
  });
});

describe('avatarCandidates', () => {
  test('优先 avatarUrl，再同源端点', () => {
    expect(avatarCandidates({ avatarUrl: 'https://cdn.example/a.png', endpoint: true })).toEqual([
      'https://cdn.example/a.png',
      AVATAR_ENDPOINT,
    ]);
  });

  test('没有 avatarUrl 时只有端点（这是「只有 /auth/avatar」那一档）', () => {
    expect(avatarCandidates({ avatarUrl: null, endpoint: true })).toEqual([AVATAR_ENDPOINT]);
  });

  test('未登录（endpoint=false）不发这一枪', () => {
    expect(avatarCandidates({ avatarUrl: null, endpoint: false })).toEqual([]);
    expect(avatarCandidates({ avatarUrl: 'https://cdn.example/a.png', endpoint: false })).toEqual([
      'https://cdn.example/a.png',
    ]);
  });

  test('avatarUrl 就是端点本身时不重复', () => {
    expect(avatarCandidates({ avatarUrl: AVATAR_ENDPOINT, endpoint: true })).toEqual([
      AVATAR_ENDPOINT,
    ]);
  });

  test('不安全的 avatarUrl 被跳过，端点照旧兜底', () => {
    expect(avatarCandidates({ avatarUrl: 'javascript:alert(1)', endpoint: true })).toEqual([
      AVATAR_ENDPOINT,
    ]);
  });
});
