import { describe, expect, it } from 'bun:test';
import {
  decidePermissionAnswer,
  decidePermissionRequest,
  isPermissionExpired,
  PERMISSION_TIMEOUT_MS,
  PermissionTimeoutController,
  permissionExpiresAt,
} from '../src/repl/permission-timeout.js';

const TIMEOUT_MS = 120_000;

/** 可控计时器：捕获回调，clearTimeout 不阻止测试手动触发（模拟旧回调已排队） */
function makeScheduler() {
  let callback: (() => void) | null = null;
  let scheduled = 0;
  let cleared = 0;
  let lastDelayMs: number | null = null;
  return {
    setTimeoutFn: (fn: () => void, delayMs: number) => {
      callback = fn;
      scheduled += 1;
      lastDelayMs = delayMs;
      return scheduled as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: () => {
      cleared += 1;
    },
    fire: () => callback?.(),
    get scheduled() {
      return scheduled;
    },
    get cleared() {
      return cleared;
    },
    get lastDelayMs() {
      return lastDelayMs;
    },
  };
}

describe('permission expiry（DECISION-022 §2.1）', () => {
  it('expiresAt 由事件时间 + TTL 计算，而不是接收时刻', () => {
    expect(permissionExpiresAt(1_000)).toBe(1_000 + PERMISSION_TIMEOUT_MS);
    expect(permissionExpiresAt(1_000, 5_000)).toBe(6_000);
  });

  it('到点即过期（expiresAt <= now）', () => {
    expect(isPermissionExpired(1_000, 999)).toBe(false);
    expect(isPermissionExpired(1_000, 1_000)).toBe(true);
    expect(isPermissionExpired(1_000, 1_001)).toBe(true);
  });

  it('延迟送达但仍在窗口内的请求会展示，剩余时间按事件时间计算', () => {
    const now = 50_000;
    const eventTs = 20_000;
    expect(decidePermissionRequest(eventTs, now)).toBe('show');
    expect(permissionExpiresAt(eventTs)).toBe(140_000);
  });

  it('超过 TTL 才送达的请求直接丢弃（不重新排队）', () => {
    const now = 200_000;
    expect(decidePermissionRequest(now - PERMISSION_TIMEOUT_MS, now)).toBe('expired');
    expect(decidePermissionRequest(now - PERMISSION_TIMEOUT_MS - 1, now)).toBe('expired');
  });

  it('过期弹窗提交只关闭，不发布 response', () => {
    expect(decidePermissionAnswer(1_000, 1_000)).toBe('expired');
    expect(decidePermissionAnswer(1_000, 2_000)).toBe('expired');
    expect(decidePermissionAnswer(2_000, 1_000)).toBe('submit');
    // 兼容旧载荷：无 expiresAt 时可提交。
    expect(decidePermissionAnswer(undefined, 1_000)).toBe('submit');
  });
});

describe('PermissionTimeoutController', () => {
  it('startAt 按绝对过期时间只等剩余时间', () => {
    const scheduler = makeScheduler();
    const controller = new PermissionTimeoutController({
      timeoutMs: TIMEOUT_MS,
      onTimeout: () => undefined,
      setTimeoutFn: scheduler.setTimeoutFn,
      clearTimeoutFn: scheduler.clearTimeoutFn,
    });

    controller.startAt('req-late', 140_000, 50_000);

    expect(scheduler.lastDelayMs).toBe(90_000);
  });

  it('startAt 已过期时按 0ms 计时（不延长窗口）', () => {
    const scheduler = makeScheduler();
    const controller = new PermissionTimeoutController({
      timeoutMs: TIMEOUT_MS,
      onTimeout: () => undefined,
      setTimeoutFn: scheduler.setTimeoutFn,
      clearTimeoutFn: scheduler.clearTimeoutFn,
    });

    controller.startAt('req-old', 10_000, 20_000);

    expect(scheduler.lastDelayMs).toBe(0);
  });

  it('已答后旧计时器回调仍触发，也不会追加超时提示', () => {
    const scheduler = makeScheduler();
    const timedOut: string[] = [];
    const controller = new PermissionTimeoutController({
      timeoutMs: TIMEOUT_MS,
      onTimeout: (requestId) => timedOut.push(requestId),
      setTimeoutFn: scheduler.setTimeoutFn,
      clearTimeoutFn: scheduler.clearTimeoutFn,
    });

    controller.start('req-1');
    controller.answer('req-1');
    // 模拟 clearTimeout 之前已经排队的旧回调
    scheduler.fire();

    expect(timedOut).toEqual([]);
    expect(controller.isAnswered('req-1')).toBe(true);
    expect(scheduler.cleared).toBe(1);
  });

  it('未答时到点触发一次超时', () => {
    const scheduler = makeScheduler();
    const timedOut: string[] = [];
    const controller = new PermissionTimeoutController({
      timeoutMs: TIMEOUT_MS,
      onTimeout: (requestId) => timedOut.push(requestId),
      setTimeoutFn: scheduler.setTimeoutFn,
      clearTimeoutFn: scheduler.clearTimeoutFn,
    });

    controller.start('req-2');
    scheduler.fire();

    expect(timedOut).toEqual(['req-2']);
  });

  it('新请求替换旧计时器；clear 后不再触发', () => {
    const scheduler = makeScheduler();
    const timedOut: string[] = [];
    const controller = new PermissionTimeoutController({
      timeoutMs: TIMEOUT_MS,
      onTimeout: (requestId) => timedOut.push(requestId),
      setTimeoutFn: scheduler.setTimeoutFn,
      clearTimeoutFn: scheduler.clearTimeoutFn,
    });

    controller.start('req-old');
    controller.start('req-new');
    // 当前捕获的是新回调（旧计时器已被 clear）
    scheduler.fire();
    expect(timedOut).toEqual(['req-new']);

    controller.start('req-cleared');
    controller.clear();
    // 两次实际 clear：req-new 替换 req-old、clear() 取消 req-cleared。
    // clear() 只停表、不记为已答；answer() 才负责旧回调的兜底。
    expect(scheduler.cleared).toBe(2);
  });

  it('answer 只取消当前请求的计时器', () => {
    const scheduler = makeScheduler();
    const timedOut: string[] = [];
    const controller = new PermissionTimeoutController({
      timeoutMs: TIMEOUT_MS,
      onTimeout: (requestId) => timedOut.push(requestId),
      setTimeoutFn: scheduler.setTimeoutFn,
      clearTimeoutFn: scheduler.clearTimeoutFn,
    });

    controller.start('req-live');
    controller.answer('req-stale');
    scheduler.fire();

    expect(timedOut).toEqual(['req-live']);
    expect(controller.isAnswered('req-stale')).toBe(true);
  });
});
