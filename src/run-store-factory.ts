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

/** run store 选项 */
export interface RunStoreOptions {
  /** tenant 的 runs 目录（`<tenant>/runs`）；显式 durable.path 优先 */
  tenantRunsDir?: string;
  /**
   * 所属 tenant（A5）。FileRunStore 用它补齐/校验 checkpoint.tenant_id，
   * 并在 delete 时拒绝跨 tenant 归属（core 侧实现）。
   */
  tenantId?: string;
}

/** config → durable 选项（默认值只在 DEFAULT_DURABLE_OPTIONS 一处） */
export function resolveDurableOptions(
  config: VesselConfig,
  opts: RunStoreOptions = {},
): ResolvedDurableOptions {
  const durable = config.durable;
  return {
    enabled: durable?.enabled === true,
    backend: durable?.backend ?? DEFAULT_DURABLE_OPTIONS.backend,
    path: durable?.path ?? opts.tenantRunsDir ?? DEFAULT_DURABLE_OPTIONS.path,
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
export function createRunStore(
  config: VesselConfig,
  opts: RunStoreOptions = {},
): RunStore | undefined {
  const options = resolveDurableOptions(config, opts);
  if (!options.enabled) return undefined;

  if (options.backend === 'memory') return new MemoryRunStore();
  return new FileRunStore({
    dir: resolveRunStorePath(options.path),
    ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
  });
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
