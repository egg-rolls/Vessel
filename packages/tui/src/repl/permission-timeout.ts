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
  start(requestId: string): void {
    this.clearTimer();
    this.currentRequestId = requestId;
    // 防御：同 id 重新发起时视为未答（正常情况下 requestId 唯一）。
    this.answeredRequests.delete(requestId);
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.currentRequestId = null;
      if (this.answeredRequests.has(requestId)) return;
      this.onTimeout(requestId);
    }, this.timeoutMs);
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
