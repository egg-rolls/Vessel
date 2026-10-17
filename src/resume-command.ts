/**
 * `vessel --resume-run`（无参）：列出可恢复的 interrupted run。
 *
 * 一次性命令：只加载配置 + 打开 RunStore，不构造 runtime、不需要 API Key。
 * 排序与上限沿用 core 的 RunStore（updated_at 倒序、同值 run_id 升序；默认 50/最大 200）。
 */

import { type ConfigLoadOptions, loadConfig } from '../packages/config/src/index';
import { previewOf } from './durable-wiring';
import { closeRunStore, createRunStore } from './run-store-factory';

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
  const { config, validation } = await loadConfig(options);

  for (const warning of validation.warnings) console.warn(`⚠ ${warning.message}`);
  if (validation.errors.length > 0) {
    for (const error of validation.errors) console.error(`✗ ${error.message}`);
    return 1;
  }

  if (config.durable?.enabled !== true) {
    console.log('Durable runs are not enabled (durable.enabled: false).');
    return 0;
  }

  const store = createRunStore(config);
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
    for (const checkpoint of runs) {
      const iteration = checkpoint.iteration === undefined ? '-' : String(checkpoint.iteration);
      const preview = previewOf(checkpoint) ?? '';
      console.log(
        [
          '  ',
          clip(checkpoint.run_id, 32).padEnd(32),
          '  ',
          clip(checkpoint.session_id, 32).padEnd(32),
          '  ',
          formatTimestamp(checkpoint.updated_at).padEnd(24),
          '  ',
          iteration.padEnd(4),
          '  ',
          clip(preview, 60),
        ].join(''),
      );
    }
    return 0;
  } finally {
    await closeRunStore(store);
  }
}
