/**
 * Durable RunStore 装配（0.3 A1）。
 *
 * - 只有 `durable.enabled: true` 才创建 store；默认关闭时与 0.2 完全一致。
 * - file 后端目录支持 `~` 展开；目录创建由 core 的 FileRunStore 负责。
 * - 生命周期由 bootstrap.shutdown() 在最后关闭（checkpoint 写入先完成）。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_DURABLE_OPTIONS, type VesselConfig } from '../packages/config/src/index';
import { FileRunStore, MemoryRunStore, type RunStore } from '../packages/core/src/index';

export interface ResolvedDurableOptions {
  enabled: boolean;
  backend: 'file' | 'memory';
  path: string;
  checkpointEvery: 'iteration';
}

/** config → durable 选项（默认值只在 DEFAULT_DURABLE_OPTIONS 一处） */
export function resolveDurableOptions(config: VesselConfig): ResolvedDurableOptions {
  const durable = config.durable;
  return {
    enabled: durable?.enabled === true,
    backend: durable?.backend ?? DEFAULT_DURABLE_OPTIONS.backend,
    path: durable?.path ?? DEFAULT_DURABLE_OPTIONS.path,
    checkpointEvery: 'iteration',
  };
}

/**
 * 解析 run store 目录：支持 `~`；相对路径按进程 cwd 解析。
 * 与 transport.peersDir 的解析规则一致。
 */
export function resolveRunStorePath(input?: string): string {
  const raw = input && input.trim() !== '' ? input.trim() : DEFAULT_DURABLE_OPTIONS.path;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return path.isAbsolute(raw) ? raw : path.resolve(raw);
}

/** 按配置创建 store；durable 关闭时返回 undefined */
export function createRunStore(config: VesselConfig): RunStore | undefined {
  const options = resolveDurableOptions(config);
  if (!options.enabled) return undefined;

  if (options.backend === 'memory') return new MemoryRunStore();
  return new FileRunStore({ dir: resolveRunStorePath(options.path) });
}

/** 关闭 store；失败不阻断退出 */
export async function closeRunStore(store: RunStore | undefined): Promise<void> {
  if (!store?.close) return;
  try {
    await store.close();
  } catch {
    // best-effort：关闭失败不影响进程退出
  }
}
