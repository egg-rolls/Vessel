/**
 * 0.15 port_in_use：Bun.serve 的原始 EADDRINUSE 被包在 cause 里时仍要识别。
 *
 * 故障形态：端口被外部进程占用，但 CLI 报 internal / 写到 PID 文件。
 */

import { describe, expect, it } from 'bun:test';
import { isAddressInUse } from '../port-in-use';

describe('isAddressInUse', () => {
  it('detects the cause chain', () => {
    const cause = Object.assign(new Error('listen EADDRINUSE: address already in use'), {
      code: 'EADDRINUSE',
    });
    expect(isAddressInUse(new Error('Failed to start gateway', { cause }))).toBe(true);
  });

  it('detects bun-style messages without a code', () => {
    expect(isAddressInUse(new Error('Failed to start server. Is port 8643 in use?'))).toBe(true);
  });

  it('does not treat unrelated errors as port conflicts', () => {
    expect(isAddressInUse(new Error('permission denied'))).toBe(false);
    expect(isAddressInUse(undefined)).toBe(false);
  });
});
