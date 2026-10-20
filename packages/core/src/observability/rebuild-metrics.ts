/**
 * 从 trace 重建 metrics（0.5 F2 / DECISION-010 §2.2、E8）
 *
 * 与实时 `MetricsCollector` 共用 `MetricsAccumulator`；
 * `updated_at = max(event.ts)`（无事件为 0），形状保持 0.4 冻结。
 *
 * @module @vessel/core/observability
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MetricsAccumulator, type MetricsSnapshot } from './metrics.js';
import { parseTraceText } from './read-trace.js';

/** 按 JSONL 重放聚合；目录不存在/不可读返回全零快照 */
export async function rebuildMetrics(traceDir: string): Promise<MetricsSnapshot> {
  const accumulator = new MetricsAccumulator();

  let entries: string[];
  try {
    entries = await readdir(traceDir);
  } catch {
    return accumulator.snapshot();
  }

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl') || entry.startsWith('.')) continue;
    try {
      const text = await readFile(join(traceDir, entry), 'utf8');
      for (const event of parseTraceText(text)) accumulator.apply(event);
    } catch {
      // 不可读文件跳过
    }
  }

  return accumulator.snapshot();
}
