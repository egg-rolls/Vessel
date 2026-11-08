/**
 * `vessel trace prune [--dry-run] [--json]`（0.5 E17 / PLAN §5.2）
 *
 * - 解析 data_dir / tenant / trace 配置；
 * - 真实删除前获取 tenant 锁（dry-run 只读，不加锁）；
 * - 委托 core pruneTrace；返回 A-4 §11.3 冻结计数。
 *
 * @module vessel/trace-command
 */

import { loadConfig } from '../packages/config/src/index';
import type { PruneTraceResult } from '../packages/core/src/index';
import { formatConfigErrors } from './config-error-format';
import { acquireDataLock, DataLockError } from './data-lock';
import { resolveDataDir, resolveEffectiveTenantId, resolveSingleTenantPaths } from './data-paths';
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
  // 0.49 T4：单 id 只来自 loadConfig()。
  const {
    config,
    tenantId: configTenantId,
    validation,
    paths: configPaths,
  } = await loadConfig({
    configPath: options.configPath,
    userConfigPath: options.userConfigPath,
    env,
  });

  // C1 规则 1/4：配置错误时不得静默落到 tenantId 继续执行。
  if (validation.errors.length > 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: formatConfigErrors(validation.errors, { paths: configPaths }),
    };
  }
  for (const warning of validation.warnings) console.warn(`⚠ ${warning.message}`);

  const dryRun = options.dryRun === true;
  // 0.49 R1：单 id 以持久化 `<dataDir>/tenant.json` 为准。
  const dataDir = resolveDataDir(config, env);
  const tenantId = resolveEffectiveTenantId(configTenantId, dataDir);
  // 0.49 T5（C6）：只读根布局；非根布局数据 fail-fast。
  let tenantPaths: ReturnType<typeof resolveSingleTenantPaths>;
  try {
    tenantPaths = resolveSingleTenantPaths(dataDir, tenantId);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }

  let lock: Awaited<ReturnType<typeof acquireDataLock>> | undefined;
  if (!dryRun) {
    try {
      lock = await acquireDataLock({
        dataDir: tenantPaths.root,
        ...(options.now ? { now: options.now } : {}),
        ...(options.hostname ? { hostname: options.hostname } : {}),
        ...(options.pid ? { pid: options.pid } : {}),
        ...(options.isPidAlive ? { isPidAlive: options.isPidAlive } : {}),
      });
    } catch (error) {
      if (error instanceof DataLockError) {
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
