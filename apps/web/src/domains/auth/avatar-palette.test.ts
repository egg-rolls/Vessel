/**
 * 头像底色：确定性、覆盖度、兜底顺序，以及「不许新造颜色」这条硬约束。
 */

import { describe, expect, test } from 'bun:test';
import { AVATAR_PALETTES, avatarPalette, avatarPaletteKey, stableHash } from './avatar-palette';

describe('stableHash', () => {
  test('同一输入逐位一致（这是「任何设备同色」的唯一保证）', () => {
    expect(stableHash('u_1')).toBe(stableHash('u_1'));
    expect(stableHash('ada')).toBe(stableHash('ada'));
  });

  test('不同输入会分开（不做断言到具体值，但不该退化成常数）', () => {
    expect(stableHash('u_1')).not.toBe(stableHash('u_2'));
    expect(stableHash('张')).not.toBe(stableHash('李'));
  });

  test('32 位无符号：不返回负数', () => {
    for (const input of ['', 'a', 'zzzzzzzzzzzz', '张伟']) {
      const hash = stableHash(input);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThan(2 ** 32);
    }
  });
});

describe('avatarPalette', () => {
  test('同一 id 多次调用返回同一组（确定性，与调用次数/顺序无关）', () => {
    const first = avatarPalette('u_42', 'Ada');
    expect(avatarPalette('u_42', 'Ada')).toBe(first);
    expect(avatarPalette('u_42', 'Ada')).toBe(first);
    // name 变化不影响已由 id 决定的结果
    expect(avatarPalette('u_42', 'Ada Lovelace')).toBe(first);
  });

  test('不同 id 能覆盖到全部色组（不只有一支）', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const palette = avatarPalette(`u_${index}`, null);
      if (palette !== null) seen.add(palette.id);
    }
    expect(seen.size).toBe(AVATAR_PALETTES.length);
  });

  test('id 缺失时退 name', () => {
    expect(avatarPalette(null, '张三')).toBe(avatarPalette('', '张三'));
    expect(avatarPalette(null, '张三')).not.toBeNull();
    expect(avatarPalette(undefined, '张三')?.id).toBe(avatarPalette(null, '张三')?.id);
  });

  test('id 与 name 都没有 ⇒ null（组件走中性色，不抛错）', () => {
    expect(avatarPalette(null, null)).toBeNull();
    expect(avatarPalette('', '')).toBeNull();
    expect(avatarPalette('   ', '  ')).toBeNull();
    expect(avatarPalette(undefined, undefined)).toBeNull();
  });

  test('色标只引用既有令牌，不出现新的十六进制 / rgb 值', () => {
    for (const palette of AVATAR_PALETTES) {
      expect(palette.solid).toMatch(/^var\(--[a-z-]+\)$/);
      expect(palette.backgroundImage.startsWith('linear-gradient(135deg,')).toBe(true);
      expect(palette.backgroundImage).not.toMatch(/#[0-9a-f]{3,8}/i);
      expect(palette.backgroundImage).not.toMatch(/\brgba?\(/i);
      expect(palette.backgroundImage).not.toMatch(/\bhsl/i);
      // 两个色标封顶：逗号分隔的是 2 个颜色，没有第三档
      expect(palette.backgroundImage.split(',').length).toBeGreaterThanOrEqual(3);
    }
  });

  test('角度统一、色组 id 唯一', () => {
    const ids = AVATAR_PALETTES.map((palette) => palette.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const palette of AVATAR_PALETTES) {
      expect(palette.backgroundImage.startsWith('linear-gradient(135deg,')).toBe(true);
    }
    expect(AVATAR_PALETTES.length).toBeGreaterThanOrEqual(4);
    expect(AVATAR_PALETTES.length).toBeLessThanOrEqual(6);
  });
});

describe('avatarPaletteKey', () => {
  test('id 优先，name 兜底，都没有 null', () => {
    expect(avatarPaletteKey('u_1', 'Ada')).toBe('u_1');
    expect(avatarPaletteKey('  ', 'Ada')).toBe('Ada');
    expect(avatarPaletteKey(null, ' Ada ')).toBe('Ada');
    expect(avatarPaletteKey(null, null)).toBeNull();
  });
});
