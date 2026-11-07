/**
 * `vessel --resume-run`（无参）：列出可恢复的 interrupted run。
 *
 * 一次性命令：只加载配置 + 打开 RunRecordStore，不构造 runtime、不需要 API Key。
 * 排序与上限沿用 core 的 RunRecordStore（updated_at 倒序、同值 run_id 升序；默认 50/最大 200）。
 */

import { type ConfigLoadOptions, loadConfig } from '../packages/config/src/index';
import { formatConfigErrors } from './config-error-format';
import { resolveDataDir, resolveReadonlyTenantPaths } from './data-paths';
import { previewOf } from './durable-wiring';
import { closeRunRecordStore, createRunRecordStore } from './run-record-store-factory';

/** 列表展示上限（core 的默认值；显式写出来让语义可见） */
const LIST_LIMIT = 50;

/** ISO 时间（测试可断言）；无效值原样返回 */
function formatTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/** 截断列宽，避免超长 id/preview 打乱表格 */
function clip(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 3))}...`;
}

export async function runResumeList(options: ConfigLoadOptions = {}): Promise<number> {
  const { config, validation, tenantId, paths } = await loadConfig(options);

  for (const warning of validation.warnings) console.warn(`⚠ ${warning.message}`);
  if (validation.errors.length > 0) {
    console.error(formatConfigErrors(validation.errors, { paths }));
    return 1;
  }

  if (config.durable?.enabled === false) {
    console.log('Durable runs are not enabled (durable.enabled: false).');
    return 0;
  }

  // A4：与执行面一致 —— 未显式 durable.path 时使用单 id 布局的 runs 目录，
  // 而不是回退到 `~/.vessel/runs`。只读入口按 C10 选布局。
  let tenantPaths: Awaited<ReturnType<typeof resolveReadonlyTenantPaths>>;
  try {
    tenantPaths = await resolveReadonlyTenantPaths(resolveDataDir(config), tenantId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const store = createRunRecordStore(config, {
    tenantRunsDir: tenantPaths.runs_dir,
    tenantId,
  });
  if (!store) {
    console.log('Durable runs are not enabled (durable.enabled: false).');
    return 0;
  }

  try {
    const runs = await store.list({ status: 'interrupted', limit: LIST_LIMIT });
    if (runs.length === 0) {
      console.log('No interrupted runs.');
      return 0;
    }

    console.log(`Interrupted runs (${runs.length}, newest first):`);
    console.log(
      '  RUN ID                            SESSION ID                        UPDATED                  ITER  PREVIEW',
    );
    for (const record of runs) {
      const iteration = record.iteration === undefined ? '-' : String(record.iteration);
      const preview = previewOf(record) ?? '';
      console.log(
        [
          '  ',
          clip(record.run_id, 32).padEnd(32),
          '  ',
          clip(record.session_id, 32).padEnd(32),
          '  ',
          formatTimestamp(record.updated_at).padEnd(24),
          '  ',
          iteration.padEnd(4),
          '  ',
          clip(preview, 60),
        ].join(''),
      );
    }
    return 0;
  } finally {
    await closeRunRecordStore(store);
  }
}
