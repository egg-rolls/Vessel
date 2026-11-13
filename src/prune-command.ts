/**
 * `vessel prune [--older-than <dur>] [--dry-run] [--json] [--yes]`（0.51 待办 #1）。
 *
 * - 判据是**状态**：已归档 team 下的 agent ∪ 已停用（`state === 'closed'`）agent，
 *   连它们的会话 / runs / 记录一起移除；没有归档、没有停用的内容一条都不删。
 * - `--older-than` 只是可选叠加：不传就完全不看时间；传了也只清「归档 / 停用时刻早于该值」的
 *   对象（是归档/停用时刻，不是会话最后活动时间），查不到时刻的默认不清。
 * - 缺省 dry-run：只报告五类对象（team / agent / session / run / trace）的条数与体积，
 *   一条都不删；必须显式 `--yes` 才真删（`--dry-run` 优先，两个都给也不删）。
 * - 真删走 `data-lock` 的 exclusive 锁（与 `vessel trace prune` / `vessel dev reset` /
 *   migrate 同一条路）：拿不到锁直接拒绝，不重试、不降级、不 partial 删。
 * - 输出按类别汇总；`--json` 给机器可读结构（`PruneReport`）。
 *
 * 目标集合怎么算、删除顺序与不变量见 `src/prune-wiring.ts` 的模块头注释。
 *
 * @module vessel/prune-command
 */

import { loadConfig } from '../packages/config/src/index';
import { formatConfigErrors } from './config-error-format';
import { acquireDataLock, DataLockError } from './data-lock';
import { resolveDataDir, resolveEffectiveTenantId, resolveSingleTenantPaths } from './data-paths';
import { t } from './i18n';
import { type PruneNote, type PruneReport, pruneTenantData } from './prune-wiring';

type EnvMap = Record<string, string | undefined>;

const DAY_MS = 86_400_000;

/** 命令结果 */
export interface PruneCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 选项 */
export interface PruneCommandOptions {
  /** 显式 `--yes`；缺省 false（= dry-run） */
  yes?: boolean;
  /** 显式 `--dry-run`；与 `--yes` 同时给出时仍不删 */
  dryRun?: boolean;
  json?: boolean;
  /**
   * 可选叠加阈值（ms）：只清归档 / 停用时刻早于它的对象。
   * 缺省 = 不看时间（用户裁定：状态为主，时间只是可选条件）。
   */
  olderThanMs?: number;
  configPath?: string;
  userConfigPath?: string;
  env?: EnvMap;
  now?: () => number;
  hostname?: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
}

/** 体积展示：够用就好，不做精确单位换算 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))} ${units[unit]}`;
}

/** 阈值展示：整日 / 整小时 / 整分钟都不带小数 */
function formatDuration(ms: number): string {
  if (ms % DAY_MS === 0) return `${ms / DAY_MS}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

const NOTE_KEYS: Record<PruneNote, string> = {
  sessions_backend_not_readonly: 'prune.note.sessionsBackendNotReadonly',
  durable_disabled: 'prune.note.durableDisabled',
  agents_snapshot_unreadable: 'prune.note.agentsSnapshotUnreadable',
  agents_snapshot_write_failed: 'prune.note.agentsSnapshotWriteFailed',
};

function formatNote(note: PruneNote): string {
  return t(NOTE_KEYS[note]);
}

function formatReport(report: PruneReport): string {
  const { teams, agents, sessions, runs, trace } = report.categories;
  const scope =
    report.older_than_ms === undefined
      ? t('prune.scope.all', { path: report.data_dir, tenant: report.tenant_id })
      : t('prune.scope', {
          path: report.data_dir,
          tenant: report.tenant_id,
          age: formatDuration(report.older_than_ms),
        });
  // trace 两个来源相加才对得上实际释放：留存策略桶 + 随会话级联删掉的文件
  const traceCount = trace.deleted_runs + trace.cascade_files;
  const traceBytes = trace.deleted_bytes + trace.cascade_bytes;

  const lines = [
    report.dry_run ? t('prune.head.dryRun') : t('prune.head.applied'),
    scope,
    '',
    t('prune.bucket.teams', { count: teams.deleted, bytes: formatBytes(teams.bytes) }),
    t('prune.bucket.agents', { count: agents.deleted, bytes: formatBytes(agents.bytes) }),
    t('prune.bucket.sessions', { count: sessions.deleted, bytes: formatBytes(sessions.bytes) }),
    t('prune.bucket.runs', { count: runs.deleted, bytes: formatBytes(runs.bytes) }),
    t('prune.bucket.trace', { count: traceCount, bytes: formatBytes(traceBytes) }),
  ];
  if (report.skipped.active_sessions > 0) {
    lines.push(t('prune.skipped.active', { count: report.skipped.active_sessions }));
  }
  if (report.skipped.refused_sessions > 0) {
    lines.push(t('prune.skipped.refused', { count: report.skipped.refused_sessions }));
  }
  if (report.skipped.kept_agents > 0) {
    lines.push(t('prune.skipped.keptAgents', { count: report.skipped.kept_agents }));
  }
  if (report.skipped.kept_teams > 0) {
    lines.push(t('prune.skipped.keptTeams', { count: report.skipped.kept_teams }));
  }
  if (report.skipped.unknown_time > 0) {
    lines.push(t('prune.skipped.unknownTime', { count: report.skipped.unknown_time }));
  }
  lines.push(
    t('prune.totals', {
      count: report.totals.deleted,
      bytes: formatBytes(report.totals.bytes),
    }),
  );
  return lines.join('\n');
}

/** `vessel prune` */
export async function pruneCommand(options: PruneCommandOptions = {}): Promise<PruneCommandResult> {
  const env = options.env ?? process.env;
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

  // C1 规则 1/4：配置错误时不得静默继续（否则可能指错 data_dir 删错数据）。
  if (validation.errors.length > 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: formatConfigErrors(validation.errors, { paths: configPaths }),
    };
  }
  for (const warning of validation.warnings) console.warn(`⚠ ${warning.message}`);

  // `--dry-run` 优先：两个 flag 同时给出时仍按「只报告」处理，绝不因为多打一个 flag 就删。
  const dryRun = options.dryRun === true || options.yes !== true;
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

  // dry-run 只读：不加锁（"报告"不该让 gateway 起不来）。
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
      const message = error instanceof Error ? error.message : String(error);
      // 锁拿不到就是拒绝：不重试、不降级成 dry-run、不做 partial 删。
      if (error instanceof DataLockError) {
        return { exitCode: 1, stdout: '', stderr: `${message}\n${t('prune.locked')}` };
      }
      return { exitCode: 1, stdout: '', stderr: message };
    }
  }

  try {
    const report = await pruneTenantData(
      {
        config,
        tenantPaths,
        tenantId,
        // 只有显式给出 --older-than 才叠加时间条件；缺省 = 纯状态判据（不传这个键）
        ...(options.olderThanMs !== undefined ? { olderThanMs: options.olderThanMs } : {}),
        now: (options.now ?? Date.now)(),
        ...(options.hostname ? { hostname: options.hostname } : {}),
        ...(options.pid !== undefined ? { pid: options.pid } : {}),
        ...(options.isPidAlive ? { isPidAlive: options.isPidAlive } : {}),
      },
      { dryRun },
    );
    return {
      exitCode: 0,
      stdout: options.json ? JSON.stringify(report, null, 2) : formatReport(report),
      stderr: report.notes.map(formatNote).join('\n'),
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
