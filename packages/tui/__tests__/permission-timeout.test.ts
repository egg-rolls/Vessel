import { describe, expect, it } from 'bun:test';
import { PermissionTimeoutController } from '../src/repl/permission-timeout.js';

const TIMEOUT_MS = 120_000;

/** 可控计时器：捕获回调，clearTimeout 不阻止测试手动触发（模拟旧回调已排队） */
function makeScheduler() {
  let callback: (() => void) | null = null;
  let scheduled = 0;
  let cleared = 0;
  return {
    setTimeoutFn: (fn: () => void) => {
      callback = fn;
      scheduled += 1;
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
  };
}

describe('PermissionTimeoutController', () => {
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
