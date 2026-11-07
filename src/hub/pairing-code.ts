/**
 * 一次性配对 / join code 的生成器与 TTL 常量（S5 / S5.1 共用）。
 *
 * 只做纯生成，不落盘、不解析：hub 侧 `./join-store.ts` 拥有文件格式与
 * 所有权语义，这里只共享 code 形状。
 *
 * @module vessel/hub/pairing-code
 */

import { randomInt } from 'node:crypto';

/** 易读码字母表：去掉 0/O/1/I。 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export const PAIRING_DEFAULT_TTL_S = 300;
export const PAIRING_MIN_TTL_S = 60;
export const PAIRING_MAX_TTL_S = 3600;

/** 生成 `XXXX-XXXX` 的易读配对码（不含 0/O/1/I）。 */
export function createPairingCode(): string {
  let compact = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    compact += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}
