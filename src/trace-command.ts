/**
 * `vessel trace prune [--dry-run] [--json] [--tenant <id>]`（0.5 E17 / PLAN §5.2）
 *
 * - 解析 data_dir / tenant / trace 配置；
 * - 真实删除前获取 tenant 锁（dry-run 只读，不加锁）；
 * - 委托 core pruneTrace；返回 A-4 §11.3 冻结计数。
 *
 * @module vessel/trace-command
 */

import { loadConfig } from '../packages/config/src/index';
import { type PruneTraceResult, resolveTenantPaths } from '../packages/core/src/index';
import { resolveDataDir } from './data-paths';
import { acquireTenantLock, TenantLockError } from './tenant-lock';
import { resolveTenantId } from './tenant-resolution';
import { pruneTenantTrace } from './trace-wiring';

type EnvMap = Record<string, string | undefined>;

/** 命令结果 */
export interface TraceCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 选项 */
export interface TracePruneCommandOptions {
  dryRun?: boolean;
  json?: boolean;
  tenantId?: string;
  configPath?: string;
  userConfigPath?: string;
  env?: EnvMap;
  now?: () => number;
  hostname?: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
}

function formatResult(result: PruneTraceResult): string {
  return [
    `deleted_runs: ${result.deleted_runs}`,
    `kept_runs: ${result.kept_runs}`,
    `deleted_bytes: ${result.deleted_bytes}`,
  ].join('\n');
}

/** `vessel trace prune` */
export async function tracePruneCommand(
  options: TracePruneCommandOptions = {},
): Promise<TraceCommandResult> {
  const env = options.env ?? process.env;
  const { config } = await loadConfig({
    configPath: options.configPath,
    userConfigPath: options.userConfigPath,
    env,
  });

  const tenant = resolveTenantId({ explicit: options.tenantId, env, config });
  if (!tenant.ok) {
    return { exitCode: 2, stdout: '', stderr: tenant.error };
  }

  const tenantPaths = resolveTenantPaths(resolveDataDir(config, env), tenant.tenantId);
  const dryRun = options.dryRun === true;

  let lock: Awaited<ReturnType<typeof acquireTenantLock>> | undefined;
  if (!dryRun) {
    try {
      lock = await acquireTenantLock({
        tenantDir: tenantPaths.root,
        tenantId: tenant.tenantId,
        ...(options.now ? { now: options.now } : {}),
        ...(options.hostname ? { hostname: options.hostname } : {}),
        ...(options.pid ? { pid: options.pid } : {}),
        ...(options.isPidAlive ? { isPidAlive: options.isPidAlive } : {}),
      });
    } catch (error) {
      if (error instanceof TenantLockError) {
        return { exitCode: 1, stdout: '', stderr: error.message };
      }
      return {
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  }

  try {
    const result = await pruneTenantTrace({ config, tenantPaths, dryRun });
    return {
      exitCode: 0,
      stdout: options.json ? JSON.stringify(result) : formatResult(result),
      stderr: '',
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await lock?.release();
  }
}
