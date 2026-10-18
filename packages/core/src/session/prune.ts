/**
 * Run 清理 helper（0.4 C2）
 *
 * 只通过公开的 `RunStore.list` / `RunStore.delete` 工作，不修改 port 接口。
 * 受 `RunStore.list` 的 limit 上限（200）约束：
 * - `keep_latest > 200` 不保证精确；
 * - `kept` 是在可枚举窗口内统计的近似值（JSDoc 已注明）。
 *
 * @module @vessel/core/session
 */

import type { RunCheckpoint, RunStore } from '../types/run-store.js';

/** 每页最多读取的 checkpoints（RunStore 实现的硬上限） */
const PAGE_LIMIT = 200;
/** 防御性页数上限，避免自定义 store 不删除时死循环 */
const MAX_PAGES = 10000;

/** pruneRuns 选项（DECISION-009 §5.4.3 冻结形状） */
export interface PruneRunsOptions {
  older_than_ms?: number;
  keep_latest?: number;
  status?: Array<RunCheckpoint['status']>;
}

/** pruneRuns 结果 */
export interface PruneRunsResult {
  deleted: number;
  kept: number;
}

const RUN_STATUSES: ReadonlySet<RunCheckpoint['status']> = new Set([
  'running',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
]);

/** 去重并丢弃非法状态；`undefined` 表示不过滤 */
function normalizeStatuses(
  status?: Array<RunCheckpoint['status']>,
): RunCheckpoint['status'][] | undefined {
  if (status === undefined) return undefined;
  const normalized: RunCheckpoint['status'][] = [];
  for (const value of status) {
    if (RUN_STATUSES.has(value) && !normalized.includes(value)) normalized.push(value);
  }
  return normalized;
}

/** 非负整数；非有限值按缺省处理 */
function normalizeNumber(value?: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

/** 与 RunStore 相同的排序：updated_at 倒序、同值 run_id 升序 */
function compareCheckpoints(a: RunCheckpoint, b: RunCheckpoint): number {
  if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at;
  if (a.run_id === b.run_id) return 0;
  return a.run_id < b.run_id ? -1 : 1;
}

/**
 * 按状态 / 年龄 / 保留最新条数清理 run checkpoints。
 *
 * 语义（DECISION-009 §5.4.3 + Addendum A §10.2.3）：
 * - 先按 `status` 过滤；
 * - 指定 `keep_latest` 时，保留集合内最新的 K 条（updated_at 倒序、run_id 升序）；
 * - 指定 `older_than_ms` 时，只删除 `now - updated_at >= older_than_ms` 的条目；
 * - 只给 `status` 时删除全部匹配项；
 * - 三个条件全部缺省时不删除。
 *
 * `kept` = 本次操作后仍保留的、符合 `status` 过滤的条目数。
 * 由于 `RunStore.list` 单次最多返回 200 条，超出该窗口的条目无法精确统计；
 * `keep_latest > 200` 也不保证精确。
 *
 * 删除过程中任一 `list` / `delete` 抛错会直接向上传播；错误前已完成的删除保留。
 */
export async function pruneRuns(
  store: RunStore,
  opts: PruneRunsOptions = {},
): Promise<PruneRunsResult> {
  const statuses = normalizeStatuses(opts.status);
  const keepLatest = normalizeNumber(opts.keep_latest);
  const olderThan = normalizeNumber(opts.older_than_ms);

  // 显式空 status 数组：没有可匹配的状态
  if (statuses !== undefined && statuses.length === 0) {
    return { deleted: 0, kept: 0 };
  }

  // 完全没有条件：不删除；kept 只统计首个窗口（受 200 上限约束）
  if (statuses === undefined && keepLatest === undefined && olderThan === undefined) {
    const page = await store.list({ limit: PAGE_LIMIT });
    return { deleted: 0, kept: page.length };
  }

  const now = Date.now();
  const filters: Array<RunCheckpoint['status'] | undefined> =
    statuses === undefined ? [undefined] : statuses;

  // keep_latest 是跨 status 的全局保留集合；每个状态取首页即可覆盖全局前 K
  const keepIds = new Set<string>();
  if (keepLatest !== undefined) {
    const firstPages = await Promise.all(
      filters.map((status) =>
        store.list({
          ...(status !== undefined ? { status } : {}),
          limit: PAGE_LIMIT,
        }),
      ),
    );
    const keep = firstPages.flat().sort(compareCheckpoints).slice(0, keepLatest);
    for (const checkpoint of keep) keepIds.add(checkpoint.run_id);
  }

  let deleted = 0;
  let kept = 0;

  for (const status of filters) {
    const listOpts = {
      ...(status !== undefined ? { status } : {}),
      limit: PAGE_LIMIT,
    };

    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
      const page = await store.list(listOpts);
      if (page.length === 0) break;

      const candidates = page.filter((checkpoint) => {
        if (keepIds.has(checkpoint.run_id)) return false;
        if (olderThan !== undefined && now - checkpoint.updated_at < olderThan) return false;
        return true;
      });

      if (candidates.length === 0) {
        // 本页没有可删项：排序保证更旧的页同样没有，剩余条目即保留项
        kept += page.length;
        break;
      }

      for (const checkpoint of candidates) {
        await store.delete(checkpoint.run_id);
        deleted += 1;
      }
    }
  }

  return { deleted, kept };
}
