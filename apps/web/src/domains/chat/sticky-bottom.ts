/**
 * 聊天窗吸附滚动（Claude 式）的纯逻辑。
 *
 * 只依赖一个最小滚动容器接口，不读 DOM 全局，便于伪容器测试：
 * - 距底 ≤ 阈值视为 pinned；只有 pinned 时新内容才跟随。
 * - 打开 / 切换会话先等 `scrollHeight` 稳定（双帧）再贴底，避免布局未稳停半路。
 * - 跟随不做 smooth / 不堆积动画；节流由 `beginFollow` 返回的 delay 表达。
 * - 未 pinned 时 ResizeObserver 变化不抢位置。
 */

export const STICKY_BOTTOM_THRESHOLD_PX = 96;
export const STICKY_FOLLOW_INTERVAL_MS = 100;
/** 布局一直不稳定时的兜底：最多等 ~500ms（30 帧）。 */
export const STICKY_SETTLE_MAX_FRAMES = 30;

export interface StickyScrollBox {
  readonly scrollHeight: number;
  readonly clientHeight: number;
  scrollTop: number;
  scrollTo(options: { top: number; behavior?: ScrollBehavior }): void;
}

export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(id: number): void;
}

export interface StickyBottomOptions {
  threshold?: number;
  followIntervalMs?: number;
  /** 注入时钟，测试用；默认 `Date.now`。 */
  now?: () => number;
}

/** 容器底部剩余距离；用 max(0) 避免滚动回弹产生的负值。 */
export function distanceToBottom(
  box: Pick<StickyScrollBox, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
): number {
  return Math.max(0, box.scrollHeight - box.scrollTop - box.clientHeight);
}

export function isPinnedAtBottom(
  box: Pick<StickyScrollBox, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  threshold = STICKY_BOTTOM_THRESHOLD_PX,
): boolean {
  return distanceToBottom(box) <= threshold;
}

export class StickyBottomController {
  private pinnedValue = true;
  private lastFollowAt = 0;
  private settling = false;
  /** “回到底部”的 smooth 动画期间保持 pinned，避免按钮闪烁。 */
  private smoothActive = false;
  private lastScrollTop: number;

  constructor(
    private readonly box: StickyScrollBox,
    private readonly options: StickyBottomOptions = {},
  ) {
    this.lastScrollTop = box.scrollTop;
  }

  get pinned(): boolean {
    return this.pinnedValue;
  }

  private threshold(): number {
    return this.options.threshold ?? STICKY_BOTTOM_THRESHOLD_PX;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** 用户滚动：阈值内重新吸附，超出则脱离。smooth 动画期间不抖动。 */
  onScroll(): boolean {
    const top = this.box.scrollTop;
    // 用户上滚打断 smooth 动画：立即交还控制权，不继续吸附。
    if (this.smoothActive && top < this.lastScrollTop) this.smoothActive = false;
    this.lastScrollTop = top;
    const distance = distanceToBottom(this.box);
    if (this.smoothActive) {
      if (distance <= this.threshold()) this.smoothActive = false;
      else {
        this.pinnedValue = true;
        return true;
      }
    }
    this.pinnedValue = distance <= this.threshold();
    return this.pinnedValue;
  }

  /**
   * 新内容到达：pinned 且未在布局 settle 时才跟随。
   * `delayMs > 0` 表示节流窗口未到，调用方应稍后重试（流式不堆积动画）。
   */
  beginFollow(now = this.now()): { jump: boolean; delayMs: number } {
    if (!this.pinnedValue || this.settling) return { jump: false, delayMs: 0 };
    const interval = this.options.followIntervalMs ?? STICKY_FOLLOW_INTERVAL_MS;
    const remaining = interval - (now - this.lastFollowAt);
    if (remaining <= 0) {
      this.lastFollowAt = now;
      return { jump: true, delayMs: 0 };
    }
    return { jump: false, delayMs: remaining };
  }

  /** 立即贴底（用容器 scrollTop，不触碰滚动祖先）。 */
  jump(): void {
    this.pinnedValue = true;
    this.smoothActive = false;
    this.box.scrollTop = this.box.scrollHeight;
    this.lastScrollTop = this.box.scrollTop;
    this.lastFollowAt = this.now();
  }

  jumpIfPinned(): boolean {
    if (!this.pinnedValue) return false;
    this.jump();
    return true;
  }

  /** 「回到底部」按钮：smooth 只用于显式点击。 */
  smoothToBottom(): void {
    this.pinnedValue = true;
    this.smoothActive = true;
    this.lastFollowAt = this.now();
    this.box.scrollTo({ top: this.box.scrollHeight, behavior: 'smooth' });
  }

  /**
   * 打开 / 切换会话：等 `scrollHeight` 稳定（至少两帧且连续两帧不变）再贴底。
   * 返回取消函数；期间的新内容不会抢滚动。
   */
  settle(scheduler: FrameScheduler): () => void {
    this.pinnedValue = true;
    this.smoothActive = false;
    this.settling = true;
    let frameId: number | undefined;
    let frames = 0;
    let lastHeight = -1;
    let stableFrames = 0;
    const tick = () => {
      frameId = undefined;
      // 用户主动上滚：放弃本次“打开贴底”，不要抢回位置。
      if (!this.pinnedValue) {
        this.settling = false;
        return;
      }
      const height = this.box.scrollHeight;
      if (height === lastHeight) stableFrames += 1;
      else {
        lastHeight = height;
        stableFrames = 0;
      }
      frames += 1;
      if ((frames >= 2 && stableFrames >= 1) || frames >= STICKY_SETTLE_MAX_FRAMES) {
        this.settling = false;
        this.jump();
        return;
      }
      frameId = scheduler.request(tick);
    };
    frameId = scheduler.request(tick);
    return () => {
      if (frameId !== undefined) scheduler.cancel(frameId);
      this.settling = false;
    };
  }

  /** 容器高度变化（dock / 窗口）：pinned 时贴底，未 pinned 不抢。 */
  onResize(): void {
    if (this.settling || !this.pinnedValue) return;
    this.box.scrollTop = this.box.scrollHeight;
    this.lastScrollTop = this.box.scrollTop;
  }
}
