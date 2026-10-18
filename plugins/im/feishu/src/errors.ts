/**
 * 稳定错误码（DECISION-009 §5.3.4）。
 */

import type { FeishuErrorCode, FeishuErrorPhase } from './types.js';

export class FeishuError extends Error {
  readonly code: FeishuErrorCode;
  /**
   * config：缺凭据/配置非法/未启用（asm 映射退出码 2）；
   * runtime：连接/SDK 运行期失败（asm 映射退出码 1）。
   */
  readonly phase: FeishuErrorPhase;

  constructor(code: FeishuErrorCode, message: string, phase: FeishuErrorPhase) {
    super(message);
    this.name = 'FeishuError';
    this.code = code;
    this.phase = phase;
  }
}
