/**
 * @vessel-agent/doc-subscription - BeforeLlm 变更通知
 * @module @vessel-agent/doc-subscription/hook
 *
 * 每个 run 的第一次 BeforeLlm 检查一次订阅文件，返回一条**只含元数据**的短通知
 * （`HookResult.additionalContext`，仅本次请求的 system 上下文，不写入历史）。
 *
 * - 通知不含正文 / diff，只列 path、id、rev、bytes；
 * - 通知返回后推进 `notified_rev`，同一 rev 不再重复通知；
 * - 正文只在模型显式调用 `subscribe inspect` 时返回，届时才推进 `seen_rev`。
 * - `ctx.messages` 从不写入；文件正文不进入 trace / 日志（插件不主动写）。
 */

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { evaluatePath, type PathBoundary } from '@vessel-agent/basic-tools';
import type { Hook, HookContext, HookResult } from '@vessel-agent/core';
import { HookType } from '@vessel-agent/core';
import type { DocSubscriptionConfig } from './config.js';
import type { SessionSubscriptionState, SubscriptionEntry, SubscriptionStore } from './store.js';

/** 与 read 工具同口径的单文件上限 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 单 run 处理的 run_id 上限；超过即清空（只影响“每 run 一次”的去重精度） */
const MAX_TRACKED_RUNS = 1000;

/** 单条通知最多列出的文件数；其余用 and N more 概括 */
const MAX_NOTICE_ENTRIES = 20;

/** hook 依赖 */
export interface BeforeLlmHookDeps {
  boundary: PathBoundary;
  store: SubscriptionStore;
  config: DocSubscriptionConfig;
}

/** 一次观察结果 */
interface Observation {
  rev: string;
  size: number;
  mtime_ms: number;
}

/** 内容 hash */
function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** XML 属性值转义（& < > "） */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** rev 的短展示形态（通知里不暴露完整 hash） */
function shortRev(rev: string): string {
  if (rev === '') return 'never';
  if (rev === 'deleted') return 'deleted';
  if (rev.startsWith('too_large:')) return 'too_large';
  if (rev.startsWith('binary:'))
    return `binary:${rev.slice('binary:'.length, 'binary:'.length + 12)}`;
  return `sha256:${rev.slice(0, 12)}`;
}

/** 单文件通知行：只含元数据 */
function noticeLine(entry: SubscriptionEntry, observation: Observation): string {
  const attrs = [
    `path="${escapeXmlAttr(entry.path)}"`,
    `id="${escapeXmlAttr(entry.id)}"`,
    `rev="${escapeXmlAttr(shortRev(observation.rev))}"`,
    `bytes="${observation.size}"`,
  ];
  if (observation.rev === 'deleted') attrs.push('status="deleted"');
  else if (observation.rev.startsWith('too_large:')) attrs.push('status="too_large"');
  else if (observation.rev.startsWith('binary:')) attrs.push('status="binary"');
  return `<file ${attrs.join(' ')} />`;
}

/** 组装短通知（不含任何文件正文 / diff） */
function buildNotice(lines: string[], total: number): string {
  return [
    '<subscription-notice>',
    `Subscribed files changed: ${total}`,
    ...lines,
    ...(total > lines.length ? [`... and ${total - lines.length} more`] : []),
    'Call subscribe with action "inspect" and the id or path to view the diff.',
    '</subscription-notice>',
  ].join('\n');
}

/**
 * 观察一个条目：边界、stat、大小、二进制、hash。
 * `undefined` = 跳过（边界拒绝 / 非普通文件 / 读取失败），不推进任何游标。
 */
async function observeEntry(
  entry: SubscriptionEntry,
  deps: BeforeLlmHookDeps,
): Promise<Observation | undefined> {
  if (evaluatePath(entry.path, deps.boundary) !== 'allow') return undefined;

  let info: Stats | undefined;
  try {
    info = await stat(entry.path);
  } catch {
    info = undefined;
  }

  if (info === undefined || info.isDirectory()) {
    return { rev: 'deleted', size: 0, mtime_ms: 0 };
  }
  if (!info.isFile()) return undefined;

  // 便宜路径：status 不变且 stat 未变，不读文件。
  if (entry.rev !== '' && info.mtimeMs === entry.mtime_ms && info.size === entry.size) {
    return { rev: entry.rev, size: entry.size, mtime_ms: entry.mtime_ms };
  }

  if (info.size > MAX_FILE_BYTES) {
    return {
      rev: `too_large:${info.size}:${info.mtimeMs}`,
      size: info.size,
      mtime_ms: info.mtimeMs,
    };
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(entry.path);
  } catch {
    return undefined;
  }
  const hash = sha256Hex(buffer);
  return {
    rev: buffer.includes(0) ? `binary:${hash}` : hash,
    size: buffer.byteLength,
    mtime_ms: info.mtimeMs,
  };
}

/**
 * 创建 BeforeLlm hook。
 * 每个插件实例持有自己的 run 去重集合（每 run 只检查一次）。
 */
export function createBeforeLlmHook(deps: BeforeLlmHookDeps): Hook {
  const processedRuns = new Set<string>();

  return {
    name: 'doc-subscription',
    type: HookType.BeforeLlm,
    priority: 150,
    run: async (ctx: HookContext): Promise<HookResult | undefined> => {
      const runId = ctx.run_id;
      if (processedRuns.has(runId)) return;
      if (processedRuns.size >= MAX_TRACKED_RUNS) processedRuns.clear();
      processedRuns.add(runId);

      const sessionId = ctx.session_id ?? 'default';

      let state: SessionSubscriptionState;
      try {
        state = await deps.store.load(sessionId);
      } catch {
        return;
      }

      const entries = Object.values(state.subscriptions).sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
      if (entries.length === 0) return;

      const now = Date.now();
      const lines: string[] = [];
      let changedCount = 0;
      let dirty = false;

      for (const entry of entries) {
        let observation: Observation | undefined;
        try {
          observation = await observeEntry(entry, deps);
        } catch {
          observation = undefined;
        }
        if (observation === undefined) continue;

        // 已在通知里出现过：只刷新观察值，不再通知。
        if (observation.rev === entry.notified_rev) {
          if (
            entry.rev !== observation.rev ||
            entry.size !== observation.size ||
            entry.mtime_ms !== observation.mtime_ms
          ) {
            state.subscriptions[entry.path] = {
              ...entry,
              rev: observation.rev,
              size: observation.size,
              mtime_ms: observation.mtime_ms,
            };
            dirty = true;
          }
          continue;
        }

        changedCount += 1;
        if (lines.length < MAX_NOTICE_ENTRIES) lines.push(noticeLine(entry, observation));
        state.subscriptions[entry.path] = {
          ...entry,
          rev: observation.rev,
          size: observation.size,
          mtime_ms: observation.mtime_ms,
          notified_rev: observation.rev,
          notified_at: now,
        };
        dirty = true;
      }

      if (!dirty) return;

      try {
        await deps.store.save(state);
      } catch {
        // 保存失败时通知仍返回；下个 run 可能重复一次（at-most-once 风险）。
      }

      if (changedCount === 0) return;
      return { additionalContext: buildNotice(lines, changedCount) };
    },
  };
}
