import { describe, expect, it } from 'bun:test';
import { PermissionPendingController } from '../src/repl/permission-pending.js';

describe('PermissionPendingController（无超时）', () => {
  it('长时间无应答也不自动关闭：控制器没有任何计时器', async () => {
    const controller = new PermissionPendingController();
    controller.start('req-1');

    // 等待远超过旧 120s 的“时间流逝”语义：没有回调可触发，挂起状态保持。
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(controller.current()).toBe('req-1');
    expect(controller.isAnswered('req-1')).toBe(false);
  });

  it('用户应答后立即关闭并记录已答', () => {
    const controller = new PermissionPendingController();
    controller.start('req-1');
    controller.answer('req-1');

    expect(controller.current()).toBeNull();
    expect(controller.isAnswered('req-1')).toBe(true);
  });

  it('Esc / Ctrl+C / abort / 卸载（clear/dispose）立即关闭，且不记为已答', () => {
    const controller = new PermissionPendingController();
    controller.start('req-1');
    controller.clear();
    expect(controller.current()).toBeNull();
    expect(controller.isAnswered('req-1')).toBe(false);

    controller.start('req-2');
    controller.dispose();
    expect(controller.current()).toBeNull();
    expect(controller.isAnswered('req-2')).toBe(false);
  });

  it('新请求替换旧的挂起请求；旧 id 应答不影响新请求', () => {
    const controller = new PermissionPendingController();
    controller.start('req-old');
    controller.start('req-new');
    expect(controller.current()).toBe('req-new');

    controller.answer('req-old');
    expect(controller.current()).toBe('req-new');
    expect(controller.isAnswered('req-old')).toBe(true);
    expect(controller.isAnswered('req-new')).toBe(false);
  });

  it('同 id 重新发起时视为未答', () => {
    const controller = new PermissionPendingController();
    controller.start('req-1');
    controller.answer('req-1');
    controller.start('req-1');

    expect(controller.current()).toBe('req-1');
    expect(controller.isAnswered('req-1')).toBe(false);
  });
});
