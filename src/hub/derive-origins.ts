/**
 * hub 侧的「派生来源集」D：注册表 → 浏览器可放行 origin（0.61）。
 *
 * 这一层只做三件事：取本机网卡事实、把 registry 记录映射成派生输入、缓存结果。
 * 分类与派生的规则全在 `@vessel-agent/config` 的 `deriveTrustedOrigins`（纯函数、
 * 单测覆盖），这里**不允许**再写一份自己的判断——安全规则只能有一处。
 *
 * 为什么需要缓存：`/v1/hub/join` 每次都要在响应里带这份集合，而 registry 变化是低频的。
 * 缓存失效点固定在 registry 事件与显式 `refresh()`；不按时间过期（避免读到半新半旧）。
 *
 * @module vessel/hub/derive-origins
 */

import { networkInterfaces } from 'node:os';
import {
  type DerivedOriginsNodeView,
  type DerivedOriginsResult,
  deriveTrustedOrigins,
} from '@vessel-agent/config';
import type { Logger } from '@vessel-agent/core';
import type { HubNodeRecord } from './types.js';

export interface CreateOriginDeriverOptions {
  /** 当前 registry 快照；每次 `refresh()` 调用一次。 */
  nodes: () => readonly HubNodeRecord[];
  /** 本机网卡地址；缺省 `readLocalAddresses()`（测试注入字面量）。 */
  localAddresses?: readonly string[];
  /**
   * 私网自动开关；缺省 true。
   *
   * 目前**没有**配置项暴露（拍板结论：默认按"可证明本机"放行）；要收紧成
   * "只回环"，在 runtime 里传 `false` 即可（一行）。
   */
  allowPrivate?: boolean;
  maxOrigins?: number;
  logger?: Logger;
}

export interface OriginDeriver {
  /** 当前缓存的派生集（脏了才重算；首次调用自动计算）。 */
  get(): readonly string[];
  /** 重算并记录一行日志；返回新集合。 */
  refresh(): readonly string[];
  /** 标记为脏：下一次 `get()` 重算（registry 事件用，避免每个事件都算一遍）。 */
  invalidate(): void;
  /** 最近一次统计（诊断用）。 */
  stats(): DerivedOriginsResult | undefined;
}

/**
 * 展开 `os.networkInterfaces()` 的全部地址。
 *
 * 真实读数（Windows 11 / bun 1.3.9）：zone id 不在 `address` 里，而是独立的数字
 * `scopeid` 字段；地址形如 `fe80::4bf9:...`、`fd37:...`、`10.248.0.4`。
 * 双栈监听时 `requestIP()` 仍可能给 `::ffff:127.0.0.1`，所以分类函数两种形式都要吃。
 * 虚拟网卡（vEthernet / ZeroTier / VMware）也会出现在这里——它们是**本机**网卡，
 * 判定为「可证明本机」是符合语义的。
 */
export function readLocalAddresses(): string[] {
  const addresses: string[] = [];
  const interfaces = networkInterfaces();
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (!info.address) continue;
      addresses.push(info.address);
    }
  }
  return addresses;
}

function toNodeView(record: HubNodeRecord): DerivedOriginsNodeView {
  return {
    node_id: record.node_id,
    ...(record.entries !== undefined ? { entries: record.entries } : {}),
    ...(record.url !== undefined ? { url: record.url } : {}),
    ...(record.public_url !== undefined ? { public_url: record.public_url } : {}),
  };
}

/** 建派生器；`get()` 的返回值在 `refresh()` 前不变。 */
export function createOriginDeriver(options: CreateOriginDeriverOptions): OriginDeriver {
  const localAddresses = options.localAddresses ?? readLocalAddresses();
  let cached: readonly string[] | undefined;
  let lastStats: DerivedOriginsResult | undefined;

  function refresh(): readonly string[] {
    let stats: DerivedOriginsResult;
    try {
      stats = deriveTrustedOrigins({
        nodes: options.nodes().map(toNodeView),
        localAddresses,
        ...(options.allowPrivate !== undefined ? { allowPrivate: options.allowPrivate } : {}),
        ...(options.maxOrigins !== undefined ? { maxOrigins: options.maxOrigins } : {}),
      });
    } catch (error) {
      // fail-closed：派生失败退回空集，绝不缓存上次结果（设计稿 §8 B4）。
      lastStats = undefined;
      cached = [];
      options.logger?.warn('hub.origins.derive_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return cached;
    }

    lastStats = stats;
    cached = stats.origins;
    // `count=0` 是排查「白名单为什么空了」的唯一入口：这条日志必须无条件打。
    options.logger?.info('hub.origins.derived', {
      count: stats.origins.length,
      loopback: stats.loopback,
      private: stats.private,
      skipped_public: stats.skipped_public,
      skipped_private: stats.skipped_private,
      invalid: stats.invalid,
    });
    if (stats.skipped_hosts.length > 0) {
      options.logger?.debug('hub.origins.skipped_hosts', { hosts: stats.skipped_hosts });
    }
    return cached;
  }

  return {
    get(): readonly string[] {
      return cached ?? refresh();
    },
    refresh,
    invalidate(): void {
      cached = undefined;
    },
    stats(): DerivedOriginsResult | undefined {
      return lastStats;
    },
  };
}
