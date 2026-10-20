/**
 * 0.10 R2-18（web 合入后）：serve 关闭顺序与 drain 去重。
 *
 * gateway.stop() 自带 interrupt + 5s drain；bundle/tenant 关闭必须传 drain:false，
 * 且顺序固定 stop → unsub/transport → beforeClose → closeAll → shutdown。
 */
import { describe, expect, it } from 'bun:test';
import { serveDrainOptions, shutdownServeStack } from '../shutdown-sequence';

describe('shutdownServeStack', () => {
  it('await gateway.stop() 后才 closeAll / shutdown，且传 drain:false', async () => {
    const order: string[] = [];
    const seen: Array<{ drain?: boolean } | undefined> = [];

    await shutdownServeStack({
      gateway: {
        async stop() {
          order.push('gateway.stop');
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push('gateway.stopped');
        },
      },
      unsubShared: () => order.push('unsub'),
      closeTransport: async () => {
        order.push('transport');
      },
      beforeClose: async () => {
        order.push('before');
      },
      closeTenants: async (options) => {
        order.push('closeTenants');
        seen.push(options);
      },
      shutdown: async (options) => {
        order.push('shutdown');
        seen.push(options);
      },
    });

    expect(order).toEqual([
      'gateway.stop',
      'gateway.stopped',
      'unsub',
      'transport',
      'before',
      'closeTenants',
      'shutdown',
    ]);
    expect(seen).toEqual([{ drain: false }, { drain: false }]);
  });

  it('没有 gateway（headless / REPL）时保留 bundle 自己的 drain', async () => {
    const seen: Array<{ drain?: boolean } | undefined> = [];
    await shutdownServeStack({
      closeTenants: async (options) => {
        seen.push(options);
      },
      shutdown: async (options) => {
        seen.push(options);
      },
    });
    expect(seen).toEqual([undefined, undefined]);
    expect(serveDrainOptions(null)).toBeUndefined();
    expect(serveDrainOptions({ stop: async () => {} })).toEqual({ drain: false });
  });

  it('总耗时只包含一次 gateway drain（不再叠加 bundle 5s 等待）', async () => {
    const started = Date.now();
    await shutdownServeStack({
      gateway: {
        async stop() {
          await new Promise((resolve) => setTimeout(resolve, 25));
        },
      },
      closeTenants: async () => {},
      shutdown: async () => {},
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(20);
    // 若 bundle 也 drain，会额外多 5s；这里给足 CI 抖动仍远低于 1s。
    expect(elapsed).toBeLessThan(1000);
  });
});
