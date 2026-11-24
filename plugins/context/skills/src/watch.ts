/**
 * @vessel-agent/plugin-skills — 技能根 watch
 * @module @vessel-agent/skills/watch
 *
 * 设计 §5.4：watch: true 时三根 fs.watch 去抖 300ms（gateway 热重载同款节奏）
 * 增量重扫。watch 只更新索引（数据层），不是设置变化，随时生效不需要重启。
 *
 * 防御：recursive watch 不可用（平台 / 权限）时回落浅 watch；根不存在不 watch
 * （rescan 手动兜底，R4：load 期重读 + 校哈希保证正确性不受 watch 失效影响）。
 */

import { existsSync, type FSWatcher, watch } from 'node:fs';
import { WATCH_DEBOUNCE_MS } from './types.js';

/** watch 句柄 */
export interface SkillsWatcher {
  close(): void;
}

/**
 * 对每个存在的根建 watch；事件去抖后回调 onChange(root)。
 * 单根 watch 失败只告警一次，不影响其它根。
 */
export function watchSkillRoots(
  roots: readonly string[],
  onChange: (root: string) => void,
  warn: (message: string) => void = (message) => console.warn(message),
): SkillsWatcher {
  const watchers: FSWatcher[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;

  const schedule = (root: string): void => {
    if (closed) return;
    const existing = timers.get(root);
    if (existing !== undefined) clearTimeout(existing);
    timers.set(
      root,
      setTimeout(() => {
        timers.delete(root);
        if (!closed) onChange(root);
      }, WATCH_DEBOUNCE_MS),
    );
  };

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let watcher: FSWatcher | undefined;
    try {
      watcher = watch(root, { recursive: true }, () => schedule(root));
    } catch {
      // recursive 不可用（部分平台 / 网络盘）：回落浅 watch，深层变化靠 rescan 兜底
      try {
        watcher = watch(root, () => schedule(root));
      } catch (error) {
        warn(
          `[skills] cannot watch "${root}": ${error instanceof Error ? error.message : String(error)}; ` +
            'use rescan to refresh',
        );
        continue;
      }
    }
    watcher.on('error', (error) => {
      warn(`[skills] watch error on "${root}": ${error.message}`);
    });
    watchers.push(watcher);
  }

  return {
    close(): void {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // 已关闭等情况下静默
        }
      }
    },
  };
}
