/**
 * `vessel migrate` CLI 包装（0.5 E18 / PLAN §7.5）
 *
 * 负责读取配置、解析 tenant/data_dir 与源默认值；实际迁移在 `migrate.ts`。
 * 退出码：0 成功（含 dry-run）；1 IO/锁/源错误；2 用法错误。
 *
 * @module vessel/migrate-command
 */

import { loadConfig, type VesselConfig } from '../packages/config/src/index';
import { formatConfigErrors } from './config-error-format';
import { resolveDataDir } from './data-paths';
import { MigrateError, type MigrateResult, migrate } from './migrate';

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
  // 0.49 T1：单 id 只来自 loadConfig()；`--tenant` 作为被忽略来源传入，
  // 由 loader 统一产出 warning（C0/C2/C8）。
  const {
    config,
    tenantId,
    validation,
    paths: configPaths,
  } = await loadConfig({
    configPath: options.configPath,
    userConfigPath: options.userConfigPath,
    env,
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
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

  try {
    const result = await migrate({
      from: options.from,
      to: options.to,
      tenantId,
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
