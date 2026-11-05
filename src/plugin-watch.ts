/**
 * 插件目录 / 配置变更监听（0.43 热重载 gap，独立部分）。
 *
 * 监听 project / user 插件发现根与用户配置文件；事件在 300ms 窗口内去抖后
 * 回调一次 `onChange({ paths })`。
 *
 * 当前**未接线**（N-serve 的 manager reload API 尚未落地）。接线点：
 *
 * ```ts
 * const handle = startPluginWatch({
 *   onChange: async () => {
 *     const descriptors = loader.rescan();          // 已实现
 *     await pluginHostManager.reload(descriptors);  // TODO(0.43 reload): N-serve API
 *   },
 * });
 * ```
 *
 * @module vessel/plugin-watch
 */

import { existsSync, type FSWatcher, watch } from 'node:fs';
import * as path from 'node:path';
import { getUserConfigPath } from '../packages/config/src/index';
import { defaultPluginRoots } from './plugin-loader';

export interface PluginWatchChange {
  /** 本次窗口内发生变化的具体路径（目录变更时为目录） */
  paths: string[];
}

export interface PluginWatchOptions {
  /** 覆盖监听根；缺省 project + user 插件发现根 */
  roots?: readonly string[];
  /** 覆盖配置路径；缺省用户 `config.yaml` */
  configPaths?: readonly string[];
  /** 去抖窗口，缺省 300ms */
  debounceMs?: number;
  onChange: (change: PluginWatchChange) => void;
}

export interface PluginWatchHandle {
  close(): void;
}

/** 默认监听根：project / user（内置 repo 不热监听） */
function defaultWatchRoots(): string[] {
  return defaultPluginRoots()
    .filter((root) => root.source === 'project' || root.source === 'user')
    .map((root) => root.dir);
}

/**
 * 启动变更监听。`onChange` 只报告路径；重新扫描 / 重载由调用方决定。
 * 单个根不可 watch（平台不支持 recursive / 路径不存在）时跳过该根。
 */
export function startPluginWatch(options: PluginWatchOptions): PluginWatchHandle {
  const debounceMs = options.debounceMs ?? 300;
  const roots = options.roots ?? defaultWatchRoots();
  const configPaths = options.configPaths ?? [getUserConfigPath()];
  const watchers: FSWatcher[] = [];
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (changed: string): void => {
    pending.add(changed);
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const paths = [...pending].sort();
      pending.clear();
      options.onChange({ paths });
    }, debounceMs);
  };

  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    try {
      const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        schedule(filename === null ? dir : path.join(dir, filename.toString()));
      });
      watcher.on('error', () => {
        // 监听失效不阻断主流程；下次进程启动重新建立。
      });
      watchers.push(watcher);
    } catch {
      // 平台不支持 recursive watch：跳过该根。
    }
  }

  for (const file of configPaths) {
    const dir = path.dirname(file);
    const base = path.basename(file);
    if (!existsSync(dir)) continue;
    try {
      const watcher = watch(dir, (_event, filename) => {
        if (filename === null || filename.toString() === base) schedule(file);
      });
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch {
      // 配置目录不可 watch：跳过。
    }
  }

  return {
    close(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending.clear();
      for (const watcher of watchers) watcher.close();
      watchers.length = 0;
    },
  };
}
