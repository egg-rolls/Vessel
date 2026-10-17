/**
 * CancellationScope 实现（A2）
 *
 * 父作用域取消时，所有子作用域自动中止；子作用域取消不影响父。
 * 基于原生 AbortController，不引入新的取消机制。
 *
 * @module @vessel/core/kernel
 */

import type { CancellationScope } from './types.js';

class CancellationScopeImpl implements CancellationScope {
  private readonly controller = new AbortController();

  constructor(private readonly parent?: AbortSignal) {
    if (!parent) return;
    if (parent.aborted) {
      this.controller.abort(parent.reason);
      return;
    }
    parent.addEventListener('abort', this.onParentAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  cancel(reason?: string): void {
    this.parent?.removeEventListener('abort', this.onParentAbort);
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
    }
  }

  child(): CancellationScope {
    return new CancellationScopeImpl(this.controller.signal);
  }

  /** 父取消回调（箭头函数保证 this 绑定） */
  private readonly onParentAbort = (): void => {
    if (!this.controller.signal.aborted) {
      this.controller.abort(this.parent?.reason);
    }
  };
}

/** 创建根取消作用域；传 parent 时随父取消自动中止 */
export function createCancellationScope(parent?: AbortSignal): CancellationScope {
  return new CancellationScopeImpl(parent);
}
