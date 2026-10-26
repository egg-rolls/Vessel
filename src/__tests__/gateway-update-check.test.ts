import { describe, expect, it } from 'bun:test';
import type { Logger } from '@vessel-agent/core';
import type { RuntimeNotice } from '../runtime-notice';
import type { UpdateCheckCache } from '../update/cache';
import { installHint } from '../update/check';
import {
  GATEWAY_UPDATE_INITIAL_DELAY_MS,
  GATEWAY_UPDATE_TICK_MS,
  startGatewayUpdateCheck,
} from '../update/gateway-check';

type Timer = ReturnType<typeof setTimeout>;

interface FakeTimers {
  set: (fn: () => void, ms: number) => Timer;
  clear: (handle: Timer) => void;
  fire: (handle: Timer) => void;
  pending: () => number;
}

function fakeTimers(): FakeTimers {
  const tasks = new Map<Timer, () => void>();
  let next = 0;
  return {
    set(fn) {
      const handle = ++next as unknown as Timer;
      tasks.set(handle, fn);
      return handle;
    },
    clear(handle) {
      tasks.delete(handle);
    },
    fire(handle) {
      const fn = tasks.get(handle);
      tasks.delete(handle);
      fn?.();
    },
    pending: () => tasks.size,
  };
}

function noticeBus() {
  const published: RuntimeNotice[] = [];
  return {
    published,
    bus: { publish: (notice: RuntimeNotice) => published.push(notice) },
  };
}

const UP_TO_DATE = {
  current: '0.26.2',
  latest: '0.26.2',
  channel: 'latest' as const,
  upToDate: true,
  installHint: installHint('0.26.2'),
  manifest: { version: '0.26.2', channel: 'latest' as const },
};

const NEWER = {
  current: '0.26.2',
  latest: '0.27.0',
  channel: 'latest' as const,
  upToDate: false,
  installHint: installHint('0.27.0'),
  manifest: { version: '0.27.0', channel: 'latest' as const },
};

function baseOptions(overrides: Record<string, unknown> = {}) {
  const timers = fakeTimers();
  const { bus, published } = noticeBus();
  return {
    timers,
    published,
    options: {
      notice: bus,
      config: {},
      timers: { set: timers.set, clear: timers.clear },
      initialDelayMs: GATEWAY_UPDATE_INITIAL_DELAY_MS,
      intervalMs: GATEWAY_UPDATE_TICK_MS,
      cache: {
        read: async (): Promise<UpdateCheckCache | null> => null,
        write: async (): Promise<void> => {},
        due: () => true,
      },
      env: {},
      ...overrides,
    },
  };
}

describe('gateway update check', () => {
  it('newer version publishes one runtime.notice', async () => {
    const { options, published } = baseOptions({ check: async () => NEWER });
    const handle = startGatewayUpdateCheck(options);

    await handle.checkNow();

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ scope: 'update', ok: true });
    expect(published[0]?.summary).toContain('0.27.0');
    handle.stop();
  });

  it('stages the asset when one is available', async () => {
    const { options, published } = baseOptions({
      check: async () => NEWER,
      stage: async () => ({
        staged: true as const,
        path: '/tmp/vessel-0.27.0.tgz',
        version: '0.27.0',
        sha256: 'a'.repeat(64),
      }),
    });
    const handle = startGatewayUpdateCheck(options);

    await handle.checkNow();

    expect(published).toHaveLength(1);
    expect(published[0]?.summary).toContain('staged');
    expect(published[0]?.ok).toBe(true);
    expect(published[0]?.details).toContain('staged: /tmp/vessel-0.27.0.tgz');
    handle.stop();
  });

  it('reports staging failure without claiming the update is unavailable', async () => {
    const { options, published } = baseOptions({
      check: async () => NEWER,
      stage: async () => ({ staged: false as const, reason: 'sha256 mismatch' }),
    });
    const handle = startGatewayUpdateCheck(options);

    await handle.checkNow();

    expect(published).toHaveLength(1);
    expect(published[0]?.ok).toBe(false);
    expect(published[0]?.summary).toContain('0.27.0');
    expect(published[0]?.details).toContain('sha256 mismatch');
    handle.stop();
  });

  it('up-to-date publishes nothing', async () => {
    const { options, published } = baseOptions({ check: async () => UP_TO_DATE });
    const handle = startGatewayUpdateCheck(options);

    await handle.checkNow();

    expect(published).toHaveLength(0);
    handle.stop();
  });

  it('failure is silent and only logs', async () => {
    const warns: Array<[string, unknown]> = [];
    const logger = { warn: (event: string, data: unknown) => warns.push([event, data]) };
    const { options, published } = baseOptions({
      logger: logger as unknown as Logger,
      check: async () => {
        throw new Error('offline');
      },
    });
    const handle = startGatewayUpdateCheck(options);

    await handle.checkNow();

    expect(published).toHaveLength(0);
    expect(warns[0]?.[0]).toBe('update.check.failed');
    handle.stop();
  });

  it('autoCheck false and VESSEL_NO_UPDATE_CHECK skip the network', async () => {
    let calls = 0;
    const check = async () => {
      calls += 1;
      return NEWER;
    };

    const disabled = baseOptions({ check, config: { update: { autoCheck: false } } });
    const a = startGatewayUpdateCheck(disabled.options);
    await a.checkNow();
    a.stop();

    const envDisabled = baseOptions({ check, env: { VESSEL_NO_UPDATE_CHECK: '1' } });
    const b = startGatewayUpdateCheck(envDisabled.options);
    await b.checkNow();
    b.stop();

    expect(calls).toBe(0);
  });

  it('respects the 24h cache gate', async () => {
    let calls = 0;
    let due = false;
    const { options, published } = baseOptions({
      check: async () => {
        calls += 1;
        return NEWER;
      },
      cache: {
        read: async (): Promise<UpdateCheckCache | null> => null,
        write: async (): Promise<void> => {},
        due: () => due,
      },
    });
    const handle = startGatewayUpdateCheck(options);

    await handle.checkNow();
    expect(calls).toBe(0);

    due = true;
    await handle.checkNow();
    expect(calls).toBe(1);
    expect(published).toHaveLength(1);
    handle.stop();
  });

  it('stop() cancels the initial delay and later ticks', async () => {
    const { options, timers } = baseOptions({ check: async () => NEWER });
    const handle = startGatewayUpdateCheck(options);

    expect(timers.pending()).toBe(1);
    handle.stop();
    expect(timers.pending()).toBe(0);
  });
});
