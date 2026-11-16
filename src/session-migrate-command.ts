/**
 * `vessel session migrate` CLI 包装（0.54 C2，方案 A：一次性迁移）。
 *
 * ```
 * vessel session migrate <session_id> [--dry-run] [--json]
 * vessel session migrate --all [--dry-run] [--json]
 * ```
 *
 * 逐会话逻辑与四条纪律在 `session-migrate.ts`；本文件只做配置 / 路径 / 数据锁 / 输出。
 *
 * 退出码：0 全部成功（含 dry-run）；1 有会话失败 / 锁 / 配置错误；2 用法错误。
 *
 * @module vessel/session-migrate-command
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../packages/config/src/index';
import { sessionDirPath } from '../packages/core/src/index';
import { formatConfigErrors } from './config-error-format';
import { acquireDataLock, DataLockError } from './data-lock';
import { resolveDataDir, resolveEffectiveTenantId, resolveSingleTenantPaths } from './data-paths';
import { type MigrateSessionOutcome, migrateSession } from './session-migrate';

type EnvMap = Record<string, string | undefined>;

/** 命令结果 */
export interface SessionMigrateCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 选项 */
export interface SessionMigrateCommandOptions {
  /** 给了 = 只迁这一个会话；null/undefined = 需要 `all` */
  sessionId?: string | null;
  all?: boolean;
  dryRun?: boolean;
  json?: boolean;
  configPath?: string;
  userConfigPath?: string;
  env?: EnvMap;
}

/** 迁移器自己的通道说明（旧会话本来就没有的东西，别让人以为丢了） */
const CHUNK_NOTE =
  '说明：旧会话没有流式增量（chunk 从不进 events.ndjson），正文与思考在 llm.response 里，可读性不受影响。';

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${bytes.toLocaleString('en-US')} 字节 (${mib.toFixed(1)} MiB)`;
}

function formatSeqRange(first: number | null, last: number | null): string {
  if (first === null || last === null) return '—';
  return `${first}..${last}`;
}

function formatHoles(holes: readonly { from_seq: number; to_seq: number }[]): string {
  if (holes.length === 0) return '无';
  return holes.map((hole) => `${hole.from_seq}..${hole.to_seq}`).join(', ');
}

/** 会话目录名 → session_id（目录名是 `encodeURIComponent(session_id)`） */
function sessionIdOfDirName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** 单会话一行（人读） */
function formatSessionLine(outcome: MigrateSessionOutcome, dryRun: boolean): string {
  const head = `  ${outcome.session_id}`;
  if (outcome.status === 'skipped' || outcome.status === 'failed') {
    const detail = outcome.detail !== undefined ? ` — ${outcome.detail}` : '';
    return `${head}  ${outcome.status}(${outcome.reason ?? 'unknown'})${detail}`;
  }
  const verb = dryRun ? '将迁移' : '已迁移';
  const bytes =
    outcome.status === 'migrated'
      ? `实际 +${outcome.bytes_added.toLocaleString('en-US')} 字节`
      : `预计 +${outcome.est_bytes_added.toLocaleString('en-US')} 字节`;
  return (
    `${head}  ${verb} ${outcome.events.toLocaleString('en-US')} 条  ` +
    `seq ${formatSeqRange(outcome.first_seq, outcome.last_seq)}  洞: ${formatHoles(outcome.holes)}  ${bytes}`
  );
}

/** 单会话明细（人读；apply 用） */
function formatSessionDetail(outcome: MigrateSessionOutcome): string[] {
  const lines: string[] = [];
  lines.push(`会话: ${outcome.session_id}`);
  lines.push(`  迁移条数: ${outcome.events.toLocaleString('en-US')}`);
  lines.push(`  首末 seq: ${formatSeqRange(outcome.first_seq, outcome.last_seq)}`);
  lines.push(`  洞: ${formatHoles(outcome.holes)}`);
  lines.push(
    `  自证: ${outcome.verified ? '逐条等价（seq/type/ts/run_id/data/fencing_token 全等）' : '未通过'}`,
  );
  lines.push(`  源 events.ndjson sha256（迁移前）: ${outcome.source_sha256_before ?? '—'}`);
  lines.push(`  源 events.ndjson sha256（迁移后）: ${outcome.source_sha256_after ?? '—'}`);
  lines.push(
    `  源文件未被修改: ${
      outcome.source_sha256_before !== undefined &&
      outcome.source_sha256_before === outcome.source_sha256_after
        ? '是（前 = 后）'
        : '否'
    }`,
  );
  lines.push(`  新增文件: ${outcome.created.length > 0 ? outcome.created.join(', ') : '无'}`);
  lines.push(`  新增字节: ${formatBytes(outcome.bytes_added)}`);
  return lines;
}

interface Counts {
  total: number;
  migrated: number;
  would_migrate: number;
  skipped: Record<string, number>;
  failed: Record<string, number>;
  events: number;
  bytes_source: number;
  bytes_added: number;
  est_bytes_added: number;
}

function emptyCounts(): Counts {
  return {
    total: 0,
    migrated: 0,
    would_migrate: 0,
    skipped: {},
    failed: {},
    events: 0,
    bytes_source: 0,
    bytes_added: 0,
    est_bytes_added: 0,
  };
}

function accumulate(counts: Counts, outcome: MigrateSessionOutcome): void {
  counts.total += 1;
  if (outcome.status === 'migrated') counts.migrated += 1;
  else if (outcome.status === 'would_migrate') counts.would_migrate += 1;
  else if (outcome.status === 'failed') {
    const key = outcome.reason ?? 'unknown';
    counts.failed[key] = (counts.failed[key] ?? 0) + 1;
  } else {
    const key = outcome.reason ?? 'unknown';
    counts.skipped[key] = (counts.skipped[key] ?? 0) + 1;
  }
  if (outcome.status === 'migrated' || outcome.status === 'would_migrate') {
    counts.events += outcome.events;
    counts.bytes_source += outcome.bytes_source;
    counts.bytes_added += outcome.bytes_added;
    counts.est_bytes_added += outcome.est_bytes_added;
  }
}

function formatBreakdown(title: string, groups: Record<string, number>): string[] {
  const entries = Object.entries(groups);
  if (entries.length === 0) return [];
  const lines = [`  ${title}:`];
  for (const [reason, count] of entries.sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${reason}: ${count}`);
  }
  return lines;
}

function formatSummary(counts: Counts, dryRun: boolean, dataDir: string, sessionsDir: string) {
  const lines: string[] = [];
  lines.push(
    `vessel session migrate — 旧格式 → 时间线单源（单向；不提供 --back，源 events.ndjson 保留）`,
  );
  lines.push('');
  lines.push(`data_dir: ${dataDir}`);
  lines.push(`sessions: ${sessionsDir}`);
  lines.push(`mode: ${dryRun ? 'dry-run（不写任何文件）' : 'apply'}`);
  lines.push('');
  lines.push(`会话总数: ${counts.total}`);
  if (dryRun) {
    lines.push(`  将迁移: ${counts.would_migrate}`);
  } else {
    lines.push(`  已迁移: ${counts.migrated}`);
  }
  const skippedTotal = Object.values(counts.skipped).reduce((sum, value) => sum + value, 0);
  const failedTotal = Object.values(counts.failed).reduce((sum, value) => sum + value, 0);
  lines.push(`  跳过: ${skippedTotal}`);
  lines.push(`  无法迁移: ${failedTotal}`);
  lines.push(...formatBreakdown('跳过原因', counts.skipped));
  lines.push(...formatBreakdown('无法迁移原因', counts.failed));
  lines.push('');
  lines.push(`事件条数: ${counts.events.toLocaleString('en-US')}`);
  lines.push(`源字节（events.ndjson）: ${formatBytes(counts.bytes_source)}`);
  if (dryRun) {
    lines.push(`预计新增字节: ${formatBytes(counts.est_bytes_added)}（wal 逐条 crc + 索引约 8%）`);
  } else {
    lines.push(`实际新增字节: ${formatBytes(counts.bytes_added)}`);
  }
  lines.push('');
  lines.push(CHUNK_NOTE);
  return lines;
}

/** `vessel session migrate <id>|--all [--dry-run] [--json]` */
export async function sessionMigrateCommand(
  options: SessionMigrateCommandOptions,
): Promise<SessionMigrateCommandResult> {
  const all = options.all === true;
  const sessionId = options.sessionId ?? null;
  if (all === (sessionId !== null)) {
    return {
      exitCode: 2,
      stdout: '',
      stderr:
        'usage: vessel session migrate <session_id> [--dry-run] | vessel session migrate --all [--dry-run]',
    };
  }
  const dryRun = options.dryRun === true;
  const json = options.json === true;
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
  if (validation.errors.length > 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: formatConfigErrors(validation.errors, { paths: configPaths }),
    };
  }
  for (const warning of validation.warnings) console.warn(`⚠ ${warning.message}`);

  const dataDir = resolveDataDir(config, env);
  const tenantId = resolveEffectiveTenantId(configTenantId, dataDir);
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
  const sessionsDir = tenantPaths.sessions_dir;

  // 真跑才加独占锁（dry-run 是纯读，不该抢锁）。
  let lock: Awaited<ReturnType<typeof acquireDataLock>> | undefined;
  if (!dryRun) {
    try {
      lock = await acquireDataLock({ dataDir: tenantPaths.root, mode: 'exclusive' });
    } catch (error) {
      if (error instanceof DataLockError) return { exitCode: 1, stdout: '', stderr: error.message };
      return {
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  }

  try {
    const outcomes: MigrateSessionOutcome[] = [];
    const counts = emptyCounts();

    if (sessionId !== null) {
      const outcome = await migrateSession({
        sessionId,
        sessionDir: sessionDirPath(sessionsDir, sessionId),
        dryRun,
      });
      outcomes.push(outcome);
      accumulate(counts, outcome);
    } else {
      let names: string[];
      try {
        const entries = await readdir(sessionsDir, { withFileTypes: true });
        names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch (error) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `sessions_dir unreadable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      names.sort();
      for (const name of names) {
        const id = sessionIdOfDirName(name);
        const outcome = await migrateSession({
          sessionId: id,
          sessionDir: join(sessionsDir, name),
          dryRun,
        });
        outcomes.push(outcome);
        accumulate(counts, outcome);
      }
    }

    const single = sessionId !== null;
    const failedTotal = Object.values(counts.failed).reduce((sum, value) => sum + value, 0);

    if (json) {
      return {
        exitCode: failedTotal > 0 ? 1 : 0,
        stdout: JSON.stringify(
          {
            mode: dryRun ? 'dry-run' : 'apply',
            data_dir: dataDir,
            sessions_dir: sessionsDir,
            counts,
            sessions: outcomes,
          },
          null,
          2,
        ),
        stderr: '',
      };
    }

    const lines: string[] = [];
    if (single && outcomes.length === 1) {
      const outcome = outcomes[0] as MigrateSessionOutcome;
      if (outcome.status === 'migrated') {
        lines.push(...formatSessionDetail(outcome));
      } else {
        lines.push(...formatSessionLine(outcome, dryRun).split('\n'));
      }
      lines.push('');
      lines.push(CHUNK_NOTE);
    } else {
      for (const outcome of outcomes) lines.push(formatSessionLine(outcome, dryRun));
      lines.push('');
      lines.push(...formatSummary(counts, dryRun, dataDir, sessionsDir));
    }

    return { exitCode: failedTotal > 0 ? 1 : 0, stdout: lines.join('\n'), stderr: '' };
  } finally {
    await lock?.release();
  }
}
