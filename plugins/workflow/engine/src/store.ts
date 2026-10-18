/**
 * run 持久化：一 run 一 JSON（<workflow_run_id>.json）。
 *
 * - 临时文件 + rename 原子写；Windows rename 失败重试 3 次，仍失败整文件直写；
 * - 同一 run 的写入串行化；
 * - list 只扫 wf_*.json；坏文件跳过并告警。
 */

import * as path from 'node:path';
import { nodeWorkflowFs } from './schema.js';
import type { WorkflowDirent, WorkflowFs, WorkflowRunFile, WorkflowRunStatus } from './types.js';

const RUN_FILE = /^wf_[A-Za-z0-9-]+\.json$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WorkflowStore {
  private readonly chains = new Map<string, Promise<void>>();
  private sequence = 0;

  constructor(
    private readonly dir: string,
    private readonly fsOps: WorkflowFs = nodeWorkflowFs,
  ) {}

  filePath(workflowRunId: string): string {
    return path.join(this.dir, `${workflowRunId}.json`);
  }

  /** 串行写同一 run；不同 run 可并行。 */
  async save(file: WorkflowRunFile): Promise<void> {
    const id = file.workflow_run_id;
    const previous = this.chains.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.write(file));
    this.chains.set(
      id,
      run.catch(() => undefined),
    );
    await run;
  }

  async load(workflowRunId: string): Promise<WorkflowRunFile | null> {
    const target = this.filePath(workflowRunId);
    let source: string;
    try {
      source = await this.fsOps.readFile(target, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw error;
    }

    try {
      const parsed = JSON.parse(source) as WorkflowRunFile;
      if (!isRunFile(parsed)) throw new Error('invalid run file shape');
      return parsed;
    } catch (error) {
      console.warn(
        `Skipping corrupt workflow run file "${target}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  async list(
    opts: { status?: WorkflowRunStatus; limit?: number } = {},
  ): Promise<WorkflowRunFile[]> {
    let entries: WorkflowDirent[];
    try {
      entries = await this.fsOps.readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw error;
    }

    const files: WorkflowRunFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !RUN_FILE.test(entry.name)) continue;
      const id = entry.name.slice(0, -'.json'.length);
      const file = await this.load(id).catch(() => null);
      if (file) files.push(file);
    }

    const filtered =
      opts.status === undefined ? files : files.filter((file) => file.status === opts.status);
    filtered.sort((left, right) => {
      if (right.updated_at !== left.updated_at) return right.updated_at - left.updated_at;
      return left.workflow_run_id.localeCompare(right.workflow_run_id);
    });

    const requested = opts.limit ?? DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(requested, MAX_LIMIT));
    return filtered.slice(0, limit);
  }

  /** 等待进行中的写入落盘。 */
  async close(): Promise<void> {
    await Promise.allSettled([...this.chains.values()]);
  }

  private async write(file: WorkflowRunFile): Promise<void> {
    const target = this.filePath(file.workflow_run_id);
    await this.fsOps.mkdir(this.dir, { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${this.sequence++}`;
    const data = `${JSON.stringify(file, null, 2)}\n`;

    await this.fsOps.writeFile(tmp, data, 'utf8');
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await this.fsOps.rename(tmp, target);
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await delay(10 * (attempt + 1));
        }
      }
      // Windows best-effort：rename 持续失败时整文件直写。
      await this.fsOps.writeFile(target, data, 'utf8');
      console.warn(
        `Atomic rename failed for "${target}" after 3 attempts; wrote directly: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
    } finally {
      await this.fsOps.unlink(tmp).catch(() => undefined);
    }
  }
}

function isRunFile(value: unknown): value is WorkflowRunFile {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema_version === 1 &&
    typeof record.workflow_run_id === 'string' &&
    typeof record.workflow_name === 'string' &&
    typeof record.definition_path === 'string' &&
    typeof record.status === 'string' &&
    Array.isArray(record.steps) &&
    typeof record.started_at === 'number' &&
    typeof record.updated_at === 'number'
  );
}
