import { describe, expect, it } from 'bun:test';
import {
  CONFIG_WATCH_DEBOUNCE_MS,
  type ConfigReloadOutcome,
  type ConfigWatchOptions,
  startConfigWatch,
  toConfigReloadOutcome,
} from '../config-watch';
import type { RuntimeNotice } from '../runtime-notice';

/** 可控的 fake：watch / schedule 都由测试推进，断言确定性。 */
function harness(overrides: Partial<ConfigWatchOptions> = {}) {
  const notices: RuntimeNotice[] = [];
  const scheduled: Array<{ fire: () => void; ms: number; cancelled: boolean }> = [];
  let listener: (() => void) | undefined;
  let watcherClosed = 0;
  let validates = 0;
  let applies = 0;
  let outcome: ConfigReloadOutcome = { valid: true, errors: [] };
  let applySummaries: string[] = ['config: applied'];
  let applyError: Error | undefined;

  const handle = startConfigWatch({
    configPath: '/tmp/config.yaml',
    validate: async () => {
      validates += 1;
      return outcome;
    },
    apply: async () => {
      applies += 1;
      if (applyError !== undefined) throw applyError;
      return applySummaries;
    },
    notify: (notice) => notices.push(notice),
    watchFactory: (_filePath, onChange) => {
      listener = onChange;
      return {
        close: () => {
          watcherClosed += 1;
        },
      };
    },
    schedule: (fn, ms) => {
      const entry = { fire: fn, ms, cancelled: false };
      scheduled.push(entry);
      return entry;
    },
    cancelSchedule: (entry) => {
      (entry as { cancelled: boolean }).cancelled = true;
    },
    ...overrides,
  });

  return {
    handle,
    notices,
    scheduled,
    /** 触发一次「文件变了」 */
    change: () => listener?.(),
    /** 触发最后一次未被取消的 debounce 回调 */
    flush: () =>
      scheduled
        .filter((entry) => !entry.cancelled)
        .at(-1)
        ?.fire(),
    counts: () => ({ validates, applies, watcherClosed }),
    setOutcome: (next: ConfigReloadOutcome) => {
      outcome = next;
    },
    setSummaries: (next: string[]) => {
      applySummaries = next;
    },
    setApplyError: (error: Error | undefined) => {
      applyError = error;
    },
  };
}

describe('startConfigWatch', () => {
  it('缺省 debounce 是 300ms，多次写入合并为一次', async () => {
    const h = harness();
    expect(CONFIG_WATCH_DEBOUNCE_MS).toBe(300);

    h.change();
    h.change();
    h.change();
    // 三次写入只留一个未取消的定时器。
    expect(h.scheduled.length).toBe(3);
    expect(h.scheduled.filter((entry) => !entry.cancelled).length).toBe(1);
    expect(h.scheduled.at(-1)?.ms).toBe(300);

    expect(h.counts().applies).toBe(0);
    h.flush();
    await h.handle?.trigger();
    // 合并后只跑一次；手动 trigger 是第二次（它不受 debounce 约束）。
    expect(h.counts().validates).toBe(2);
    expect(h.counts().applies).toBe(2);
    expect(h.notices).toEqual([
      { scope: 'config', summary: 'config: applied', ok: true },
      { scope: 'config', summary: 'config: applied', ok: true },
    ]);
  });

  it('debounce 可注入 0（测试模式下不合并）', () => {
    const h = harness({ debounceMs: 0 });
    h.change();
    expect(h.scheduled.at(-1)?.ms).toBe(0);
  });

  it('校验失败：不应用，只发一条失败 notice', async () => {
    const h = harness();
    h.setOutcome({ valid: false, errors: ['permission.auto_approve: must be an array'] });
    await h.handle?.trigger();

    expect(h.counts().applies).toBe(0);
    expect(h.notices).toEqual([
      {
        scope: 'config',
        summary: 'config not applied: permission.auto_approve: must be an array',
        details: ['permission.auto_approve: must be an array'],
        ok: false,
      },
    ]);
  });

  it('连续失败后一旦校验通过仍能正常应用（不锁死）', async () => {
    const h = harness();
    h.setOutcome({ valid: false, errors: ['bad yaml'] });
    await h.handle?.trigger();
    await h.handle?.trigger();
    expect(h.counts().applies).toBe(0);

    h.setOutcome({ valid: true, errors: [] });
    await h.handle?.trigger();
    expect(h.counts().applies).toBe(1);
    expect(h.notices.at(-1)).toMatchObject({ ok: true });
  });

  it('校验抛错等价于校验失败', async () => {
    const h = harness({
      validate: async () => {
        throw new Error('yaml parse error');
      },
    });
    await h.handle?.trigger();
    expect(h.counts().applies).toBe(0);
    expect(h.notices.at(-1)).toMatchObject({
      ok: false,
      summary: 'config not applied: yaml parse error',
    });
  });

  it('apply 抛错：发失败 notice，不假装成功', async () => {
    const h = harness();
    h.setApplyError(new Error('unknown reload scope: tools'));
    await h.handle?.trigger();
    expect(h.notices.at(-1)).toMatchObject({
      ok: false,
      summary: 'config apply failed: unknown reload scope: tools',
    });
  });

  it('多行摘要进 details', async () => {
    const h = harness();
    h.setSummaries(['config: provider requires restart', 'permission: bash always ask']);
    await h.handle?.trigger();
    expect(h.notices.at(-1)).toEqual({
      scope: 'config',
      summary: 'config: provider requires restart',
      details: ['config: provider requires restart', 'permission: bash always ask'],
      ok: true,
    });
  });

  it('close 取消监听与未到期的 debounce，且幂等', async () => {
    const h = harness();
    h.change();
    expect(h.handle?.watching).toBe(true);
    h.handle?.close();
    expect(h.handle?.watching).toBe(false);
    expect(h.counts().watcherClosed).toBe(1);
    expect(h.scheduled.filter((entry) => !entry.cancelled).length).toBe(0);

    // 幂等：再关一次不再触碰 watcher。
    h.handle?.close();
    expect(h.counts().watcherClosed).toBe(1);
  });

  it('文件不可监听时返回 undefined（不影响 gateway）', () => {
    const handle = startConfigWatch({
      configPath: '/definitely/missing.yaml',
      validate: async () => ({ valid: true, errors: [] }),
      apply: async () => [],
      notify: () => {},
      watchFactory: () => undefined,
    });
    expect(handle).toBeUndefined();
  });
});

describe('toConfigReloadOutcome', () => {
  it('valid 且无 errors 才算通过', () => {
    expect(toConfigReloadOutcome({ validation: { valid: true, errors: [] } })).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      toConfigReloadOutcome({
        validation: { valid: true, errors: [{ path: 'a.b', message: 'nope' }] },
      }),
    ).toEqual({ valid: false, errors: ['a.b: nope'] });
    expect(toConfigReloadOutcome({ validation: { valid: false, errors: [] } })).toEqual({
      valid: false,
      errors: [],
    });
    expect(toConfigReloadOutcome({})).toEqual({ valid: false, errors: [] });
  });
});
