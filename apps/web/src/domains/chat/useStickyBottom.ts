/**
 * 聊天窗吸附滚动的 React 绑定。纯决策在 `sticky-bottom.ts`，这里只负责
 * rAF / timer / ResizeObserver 的接线与 pinned state。
 */
import { type HTMLAttributes, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  STICKY_BOTTOM_THRESHOLD_PX,
  STICKY_FOLLOW_INTERVAL_MS,
  StickyBottomController,
  type StickyBottomReason,
} from './sticky-bottom';

/** 手势后这段时间内的 scroll 视为用户滚动（覆盖滚动动画 / 惯性）。 */
export const STICKY_USER_INTENT_WINDOW_MS = 500;

export type ScrollUserIntentProps = Pick<
  HTMLAttributes<HTMLDivElement>,
  'onWheel' | 'onTouchStart' | 'onTouchMove' | 'onKeyDown' | 'onPointerDown'
>;

export interface UseStickyBottomOptions {
  /**
   * 打开 / 切换会话的标识（selectedId + detail session id）。
   * 变化时等布局稳定后贴底；加载更早历史不得改这个 key。
   */
  resetKey: string | null;
  /** 新内容触发器（流式版本 / 渲染项数 / 排队数）。只在 pinned 时跟随。 */
  followKey: string;
  /**
   * 「发送即贴底」序号：调用方在发送**被受理**时自增（chat: `submitText`，
   * team: `submitContent`，含排队 / 乐观发送）。序号变化 → 立即贴底并 pin，
   * 不等新内容落地。
   *
   * 只有发送会动它：上滑读旧消息时，非发送产生的流式内容仍按 `followKey` 的
   * 既有规则（未 pinned 不跟随），不打断阅读。0 / 未变化不触发。
   */
  sendTick?: number;
  threshold?: number;
  followIntervalMs?: number;
}

export interface UseStickyBottomResult {
  scrollRef: (element: HTMLDivElement | null) => void;
  /** 当前滚动容器（程序化读取 scrollTop / scrollHeight 用，例如前插补偿）。 */
  getElement: () => HTMLDivElement | null;
  pinned: boolean;
  onScroll: () => void;
  /** 「回到底部」：pinned + smooth；流式跟随不使用 smooth。 */
  scrollToBottom: () => void;
  /**
   * 语义化贴底（发送即贴底）：瞬间到位 + pin，后续流式继续跟随。
   * 页面通常只管把发送受理序号传给 `sendTick`；这个方法留给需要直接触发的调用方。
   */
  stickToBottom: (reason?: StickyBottomReason) => void;
  /** 手势监听：展开到滚动容器上，用于区分用户滚动与程序化滚动。 */
  userIntentProps: ScrollUserIntentProps;
}

export function useStickyBottom({
  resetKey,
  followKey,
  sendTick = 0,
  threshold = STICKY_BOTTOM_THRESHOLD_PX,
  followIntervalMs = STICKY_FOLLOW_INTERVAL_MS,
}: UseStickyBottomOptions): UseStickyBottomResult {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<{
    element: HTMLDivElement;
    controller: StickyBottomController;
  } | null>(null);
  const [pinned, setPinned] = useState(true);
  const followTimer = useRef<number | undefined>(undefined);
  /** 最近一次用户手势的时间戳；窗口内的 scroll 按 userInitiated 处理。 */
  const userIntentUntil = useRef(0);

  const scrollRef = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element;
  }, []);

  const getElement = useCallback(() => elementRef.current, []);

  const controller = useCallback((): StickyBottomController | null => {
    const element = elementRef.current;
    if (!element) return null;
    const current = controllerRef.current;
    if (current && current.element === element) return current.controller;
    const next = new StickyBottomController(element, { threshold, followIntervalMs });
    controllerRef.current = { element, controller: next };
    return next;
  }, [threshold, followIntervalMs]);

  const clearFollowTimer = useCallback(() => {
    if (followTimer.current === undefined) return;
    window.clearTimeout(followTimer.current);
    followTimer.current = undefined;
  }, []);

  // 打开 / 切换会话：等 scrollHeight 稳定再贴底；用户上滚会放弃本次 settle。
  useEffect(() => {
    if (!resetKey) return;
    const active = controller();
    if (!active) return;
    clearFollowTimer();
    setPinned(true);
    return active.settle({
      request: (callback) => window.requestAnimationFrame(callback),
      cancel: (id) => window.cancelAnimationFrame(id),
    });
  }, [resetKey, controller, clearFollowTimer]);

  // 新消息 / 流式 / queued：只有 pinned 且不在 settle 中才跟随，节流 ~100ms。
  // biome-ignore lint/correctness/useExhaustiveDependencies: followKey 是跟随的显式触发器
  useEffect(() => {
    const active = controller();
    if (!active) return;
    const { jump, delayMs } = active.beginFollow();
    if (jump) {
      active.jump();
      setPinned(true);
      return;
    }
    if (delayMs > 0 && followTimer.current === undefined) {
      followTimer.current = window.setTimeout(() => {
        followTimer.current = undefined;
        const latest = controller();
        if (latest?.jumpIfPinned()) setPinned(true);
      }, delayMs);
    }
  }, [followKey, controller]);

  // dock / 窗口高度变化：pinned 时贴底，未 pinned 不抢。
  useEffect(() => {
    const element = elementRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        controller()?.onResize();
      });
    });
    observer.observe(element);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [controller]);

  useEffect(() => clearFollowTimer, [clearFollowTimer]);

  const markUserIntent = useCallback(() => {
    userIntentUntil.current = Date.now() + STICKY_USER_INTENT_WINDOW_MS;
  }, []);

  const userIntentProps = useMemo<ScrollUserIntentProps>(
    () => ({
      onWheel: markUserIntent,
      onTouchStart: markUserIntent,
      onTouchMove: markUserIntent,
      onKeyDown: markUserIntent,
      onPointerDown: markUserIntent,
    }),
    [markUserIntent],
  );

  const onScroll = useCallback(() => {
    const active = controller();
    if (!active) return;
    setPinned(active.onScroll(Date.now() < userIntentUntil.current));
  }, [controller]);

  const scrollToBottom = useCallback(() => {
    const active = controller();
    if (!active) return;
    active.smoothToBottom();
    setPinned(true);
  }, [controller]);

  /**
   * 发送即贴底（语义入口）。作废节流窗口里排队的跟随：这次是显式贴底，
   * 不是「流式内容等节流」的重试，让 timer 再跳一次只会多一次同值赋值。
   */
  const stickToBottom = useCallback(
    (reason: StickyBottomReason = 'send') => {
      const active = controller();
      if (!active) return;
      clearFollowTimer();
      active.stickToBottom(reason);
      setPinned(true);
    },
    [controller, clearFollowTimer],
  );

  // 发送受理序号变化 → 立即贴底（不等新内容落地）。用 ref 记录已消费的序号，
  // 组件重挂（切会话 / 抽屉）时不会因为残留序号在首帧多跳一次。
  const consumedSendTick = useRef(sendTick);
  useEffect(() => {
    if (sendTick === consumedSendTick.current) return;
    consumedSendTick.current = sendTick;
    stickToBottom('send');
  }, [sendTick, stickToBottom]);

  return {
    scrollRef,
    getElement,
    pinned,
    onScroll,
    scrollToBottom,
    stickToBottom,
    userIntentProps,
  };
}
