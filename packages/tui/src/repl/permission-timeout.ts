/**
 * 权限确认超时控制器
 *
 * 与 core 的 120s waitFor 对齐。核心约束：
 * - 同一时刻只有一个待确认请求，新请求会替换旧计时器；
 * - 用户已答（allow/deny）后必须取消计时器，并记录 requestId——
 *   即使旧计时器回调已经被排队，也不能再向 scrollback 追加超时提示。
 *
 * 计时器可注入，便于单测复现「已答后旧定时器仍触发」的竞态。
 */

/** 与 core PermissionPolicy 的等待时限一致（ms）。gateway interaction TTL 同值。 */
export const PERMISSION_TIMEOUT_MS = 120_000;

/**
 * 0.11.1（DECISION-022 §2.1）：过期时间必须由事件时间计算。
 * 用接收时刻 `Date.now()` 会把事件延迟送达的余量重新补满，弹窗寿命被拉长。
 */
export function permissionExpiresAt(
  eventTs: number,
  timeoutMs: number = PERMISSION_TIMEOUT_MS,
): number {
  return eventTs + timeoutMs;
}

/** 过期判定：到点即过期（与 gateway `expiresAt <= now` 丢弃语义一致）。 */
export function isPermissionExpired(expiresAt: number, now: number = Date.now()): boolean {
  return expiresAt <= now;
}

/** 收到请求时的决策：过期请求不得加入弹窗队列。 */
export function decidePermissionRequest(
  eventTs: number,
  now: number = Date.now(),
  timeoutMs: number = PERMISSION_TIMEOUT_MS,
): 'show' | 'expired' {
  return isPermissionExpired(permissionExpiresAt(eventTs, timeoutMs), now) ? 'expired' : 'show';
}

/**
 * 用户提交时的决策：已过期的弹窗只关闭，不发布 response、不重试。
 * 缺省 `expiresAt`（防御性兼容旧载荷）按可提交处理。
 */
export function decidePermissionAnswer(
  expiresAt: number | undefined,
  now: number = Date.now(),
): 'submit' | 'expired' {
  if (expiresAt === undefined) return 'submit';
  return isPermissionExpired(expiresAt, now) ? 'expired' : 'submit';
}

export interface PermissionTimeoutOptions {
  /** 超时时间（ms） */
  timeoutMs: number;
  /** 真正超时时回调（已答的 requestId 不会触发） */
  onTimeout: (requestId: string) => void;
  /** 注入计时器（测试用；默认真实 setTimeout） */
  setTimeoutFn?: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
  /** 注入清理函数（测试用；默认真实 clearTimeout） */
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class PermissionTimeoutController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private currentRequestId: string | null = null;
  private readonly answeredRequests = new Set<string>();
  private readonly timeoutMs: number;
  private readonly onTimeout: (requestId: string) => void;
  private readonly setTimeoutFn: (
    callback: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(options: PermissionTimeoutOptions) {
    this.timeoutMs = options.timeoutMs;
    this.onTimeout = options.onTimeout;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  /** 开始等待某个 requestId 的确认；替换掉旧计时器 */
  start(requestId: string, timeoutMs: number = this.timeoutMs): void {
    this.startAt(requestId, Date.now() + timeoutMs);
  }

  /**
   * 按绝对过期时间开始计时（0.11.1）：事件延迟送达时只等剩余时间，
   * 不会比 core 的等待窗口活得更久。
   */
  startAt(requestId: string, expiresAt: number, now: number = Date.now()): void {
    this.clearTimer();
    this.currentRequestId = requestId;
    // 防御：同 id 重新发起时视为未答（正常情况下 requestId 唯一）。
    this.answeredRequests.delete(requestId);
    const remainingMs = Math.max(0, expiresAt - now);
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.currentRequestId = null;
      if (this.answeredRequests.has(requestId)) return;
      this.onTimeout(requestId);
    }, remainingMs);
  }

  /** 记录该请求已答，并取消它的计时器 */
  answer(requestId: string): void {
    this.answeredRequests.add(requestId);
    if (this.currentRequestId === requestId) this.clearTimer();
  }

  /** 放弃当前等待（run 结束 / 组件卸载），不记为已答 */
  clear(): void {
    this.clearTimer();
  }

  /** 组件卸载时清理 */
  dispose(): void {
    this.clearTimer();
  }

  isAnswered(requestId: string): boolean {
    return this.answeredRequests.has(requestId);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    this.currentRequestId = null;
  }
}
