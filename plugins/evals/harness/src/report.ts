/**
 * 报告命名、写盘、latest 查找与退出码。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { invalid } from './errors.js';
import type { EvalReport } from './types.js';

const SAFE_SUITE = /^[A-Za-z0-9_-]{1,64}$/;

/** 文件系统安全时间戳：YYYYMMDDTHHmmssSSSZ。 */
export function reportTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

export function reportFileName(suite: string, timestamp: string): string {
  return `${suite}-${timestamp}.json`;
}

export async function writeReport(report: EvalReport, outPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

/** 按 finished_at 倒序取最近一次报告；只读报告目录下的 *.json。 */
export async function findLatestReport(outDir: string, suite: string): Promise<EvalReport | null> {
  if (!SAFE_SUITE.test(suite)) {
    throw invalid(`suite name must match ${SAFE_SUITE.source}`);
  }

  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = await fs.readdir(outDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  const reports: EvalReport[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const source = await fs.readFile(path.join(outDir, entry.name), 'utf8');
      const report = JSON.parse(source) as EvalReport;
      if (
        report !== null &&
        typeof report === 'object' &&
        report.suite === suite &&
        typeof report.finished_at === 'number'
      ) {
        reports.push(report);
      }
    } catch {
      // 坏报告跳过
    }
  }

  reports.sort((left, right) => right.finished_at - left.finished_at);
  return reports[0] ?? null;
}

/** 0 = 全部 passed/skipped；1 = 存在 failed/error。 */
export function reportExitCode(report: EvalReport): 0 | 1 {
  return report.failed + report.errors === 0 ? 0 : 1;
}
