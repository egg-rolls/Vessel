/**
 * Gateway 方法级错误（映射到协议错误码）。
 *
 * 与 `gateway.ts` 的 legacy 错误处理共享同一个类，保证 `instanceof MethodError`
 * 在拆分方法表后仍然成立。
 *
 * @module @vessel/serve
 */

import type { ProtocolError } from '../protocol.js';

/** 方法级错误（映射到协议错误码） */
export class MethodError extends Error {
  constructor(
    readonly code: ProtocolError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'MethodError';
  }
}
