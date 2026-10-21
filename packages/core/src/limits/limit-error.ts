/**
 * 使用量上限命中错误
 * @module @vessel-agent/core/limits
 */

import type { LimitBlock } from '../types/limits.js';

/**
 * 保留既有文本前缀（`Usage limits exceeded` / `Termination policy triggered`），
 * 具体 key / current / max 附加在后，供日志与 error envelope 同时可读。
 */
export class LimitExceededError extends Error {
  readonly code = 'limit_blocked' as const;
  readonly details: LimitBlock;

  constructor(block: LimitBlock) {
    super(
      `${limitPrefix(block)}: ${block.key} (current ${block.current} >= max ${block.max}, ${block.source})`,
    );
    this.name = 'LimitExceededError';
    this.details = block;
  }
}

function limitPrefix(block: LimitBlock): string {
  return block.key === 'max_iterations' || block.key === 'max_runtime'
    ? 'Termination policy triggered'
    : 'Usage limits exceeded';
}
