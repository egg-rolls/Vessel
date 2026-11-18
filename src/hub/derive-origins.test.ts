import { describe, expect, test } from 'bun:test';
import type { Logger } from '@vessel-agent/core';
import { createOriginDeriver } from './derive-origins.js';
import type { HubNodeRecord } from './types.js';

function record(overrides: Partial<HubNodeRecord> & { node_id: string }): HubNodeRecord {
  return {
    direction: 'node',
    status: 'healthy',
    truncated: false,
    counts: { teams: 0, agents: 0, live_agents: 0 },
    teams: [],
    agents: [],
    ...overrides,
  };
}

function captureLogger(): { logger: Logger; lines: Array<{ message: string; fields?: unknown }> } {
  const lines: Array<{ message: string; fields?: unknown }> = [];
  const push = (message: string, fields?: unknown): void => {
    lines.push({ message, ...(fields !== undefined ? { fields } : {}) });
  };
  return {
    logger: { debug: push, info: push, warn: push, error: push },
    lines,
  };
}

describe('createOriginDeriver', () => {
  const localAddresses = ['127.0.0.1', '::1', '192.168.1.5'];

  test('派生集来自注册表：回环 + 已证明本机的私网，公网丢弃', () => {
    const { logger } = captureLogger();
    const deriver = createOriginDeriver({
      localAddresses,
      logger,
      nodes: () => [
        record({
          node_id: 'a',
          entries: [
            { kind: 'loopback', url: 'http://127.0.0.1:8642' },
            { kind: 'private', url: 'http://192.168.1.5:8642' },
            { kind: 'public', url: 'https://node.example.com' },
          ],
        }),
      ],
    });
    expect([...deriver.get()]).toEqual(['http://127.0.0.1:8642', 'http://192.168.1.5:8642']);
    expect(deriver.stats()?.skipped_public).toBe(1);
  });

  test('`count=0` 必须有一行日志（排查白名单为空的唯一入口）', () => {
    const { logger, lines } = captureLogger();
    const deriver = createOriginDeriver({ localAddresses, logger, nodes: () => [] });
    expect([...deriver.get()]).toEqual([]);
    const derived = lines.find((line) => line.message === 'hub.origins.derived');
    expect(derived?.fields).toEqual({
      count: 0,
      loopback: 0,
      private: 0,
      skipped_public: 0,
      skipped_private: 0,
      invalid: 0,
    });
  });

  test('registry 变化后 get() 才重算（invalidate 懒失效）', () => {
    const { logger, lines } = captureLogger();
    let records: HubNodeRecord[] = [];
    const deriver = createOriginDeriver({ localAddresses, logger, nodes: () => records });

    expect([...deriver.get()]).toEqual([]);
    records = [record({ node_id: 'a', url: 'http://127.0.0.1:9000' })];
    // 没有 invalidate 时仍是旧值：证明缓存生效。
    expect([...deriver.get()]).toEqual([]);
    deriver.invalidate();
    expect([...deriver.get()]).toEqual(['http://127.0.0.1:9000']);
    expect(lines.filter((line) => line.message === 'hub.origins.derived')).toHaveLength(2);
  });

  test('派生抛错时 fail-closed 为空集（不缓存上次结果）', () => {
    const { logger, lines } = captureLogger();
    let explode = false;
    const deriver = createOriginDeriver({
      localAddresses,
      logger,
      nodes: () => {
        if (explode) throw new Error('boom');
        return [record({ node_id: 'a', url: 'http://127.0.0.1:9000' })];
      },
    });
    expect([...deriver.get()]).toEqual(['http://127.0.0.1:9000']);
    explode = true;
    deriver.invalidate();
    expect([...deriver.get()]).toEqual([]);
    expect(lines.some((line) => line.message === 'hub.origins.derive_failed')).toBe(true);
  });
});
