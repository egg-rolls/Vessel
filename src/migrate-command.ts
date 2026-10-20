/**
 * `vessel migrate` CLI 包装（0.5 E18 / PLAN §7.5）
 *
 * 负责读取配置、解析 tenant/data_dir 与源默认值；实际迁移在 `migrate.ts`。
 * 退出码：0 成功（含 dry-run）；1 IO/锁/源错误；2 用法错误。
 *
 * @module vessel/migrate-command
 */

import { loadConfig, type VesselConfig } from '../packages/config/src/index';
import { resolveDataDir } from './data-paths';
import { MigrateError, type MigrateResult, migrate } from './migrate';
import { resolveTenantId } from './tenant-resolution';

type EnvMap = Record<string, string | undefined>;

/** 命令结果 */
export interface MigrateCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 选项 */
export interface MigrateCommandOptions {
  from: string;
  to: string;
  apply?: boolean;
  tenantId?: string;
  source?: string;
  runsSource?: string;
  json?: boolean;
  configPath?: string;
  userConfigPath?: string;
  env?: EnvMap;
  now?: () => number;
  hostname?: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
}

/** 按配置推导默认源 */
function defaultSource(from: 'sqlite' | 'file-v1', config: VesselConfig): string {
  const session = config.session;
  if (from === 'sqlite') {
    if (session?.backend === 'sqlite' && session.storagePath) return session.storagePath;
    return '.vessel/sessions.db';
  }
  if (session?.backend === 'file' && session.storagePath) return session.storagePath;
  return '.vessel/sessions';
}

function formatCounts(result: MigrateResult): string {
  const line = (label: string, counts: MigrateResult['sessions']): string =>
    `${label}: found=${counts.found} migrated=${counts.migrated} ` +
    `skipped=${counts.skipped} invalid=${counts.invalid}`;
  return [
    `mode: ${result.dry_run ? 'dry-run' : 'apply'}`,
    `from: ${result.from} -> ${result.to}`,
    `tenant: ${result.tenant_id}`,
    line('sessions', result.sessions),
    line('runs', result.runs),
  ].join('\n');
}

/** `vessel migrate --from ... --to file-v2 [--apply]` */
export async function migrateCommand(
  options: MigrateCommandOptions,
): Promise<MigrateCommandResult> {
  if (options.from !== 'sqlite' && options.from !== 'file-v1') {
    return { exitCode: 2, stdout: '', stderr: 'usage: --from must be sqlite or file-v1' };
  }
  if (options.to !== 'file-v2') {
    return { exitCode: 2, stdout: '', stderr: 'usage: --to must be file-v2' };
  }

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

  try {
    const result = await migrate({
      from: options.from,
      to: options.to,
      tenantId: tenant.tenantId,
      dataDir: resolveDataDir(config, env),
      source: options.source ?? defaultSource(options.from, config),
      ...(options.runsSource ? { runsSource: options.runsSource } : {}),
      apply: options.apply === true,
      ...(options.now ? { now: options.now } : {}),
      ...(options.hostname ? { hostname: options.hostname } : {}),
      ...(options.pid ? { pid: options.pid } : {}),
      ...(options.isPidAlive ? { isPidAlive: options.isPidAlive } : {}),
    });

    return {
      exitCode: 0,
      stdout: options.json ? JSON.stringify(result) : formatCounts(result),
      stderr: '',
    };
  } catch (error) {
    if (error instanceof MigrateError) {
      return { exitCode: 1, stdout: '', stderr: error.message };
    }
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}
