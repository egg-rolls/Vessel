/**
 * JSONL 事件持久化存储
 * @module @vessel/core/events
 *
 * 将 RunEvent 以 JSONL 格式追加到文件（一行一个 JSON），
 * 支持按 run_id 读取和删除。遵循 .vessel/ 目录约定。
 *
 * ⚠️ 非线程/进程安全：append 与 deleteRun 是独立 IO 操作，多进程同时写
 * 同一文件可能数据竞争。pre-MVP 单进程使用即可。
 */

import { appendFile } from 'node:fs/promises';
import type { RunEvent } from '../types/event.js';

/** JSONL 事件持久化存储 */
export class FileEventStore {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** 追加一条事件到 JSONL（一行 JSON，末尾换行）。append 模式 O(1)，避免整文件重写 */
  async append(event: RunEvent): Promise<void> {
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  /** 列出所有 run_id（去重） */
  async listRunIds(): Promise<string[]> {
    const lines = await this.readLines();
    const runIds = new Set<string>();

    for (const line of lines) {
      const event = parseEventLine(line);
      if (event?.run_id) {
        runIds.add(event.run_id);
      }
    }

    return Array.from(runIds);
  }

  /** 读取指定 run_id 的所有事件（按原始顺序） */
  async readRun(runId: string): Promise<RunEvent[]> {
    const lines = await this.readLines();
    const events: RunEvent[] = [];

    for (const line of lines) {
      const event = parseEventLine(line);
      if (event?.run_id === runId) {
        events.push(event);
      }
    }

    return events;
  }

  /** 删除指定 run_id 的所有事件（重写整个文件） */
  async deleteRun(runId: string): Promise<void> {
    const lines = await this.readLines();

    if (lines.length === 0) {
      return;
    }

    const kept: string[] = [];

    for (const line of lines) {
      const event = parseEventLine(line);
      if (event === null || event.run_id !== runId) {
        kept.push(line);
      }
    }

    await Bun.write(this.filePath, kept.length > 0 ? `${kept.join('\n')}\n` : '');
  }

  // ── 私有辅助方法 ──────────────────────────────────

  /** 读取 JSONL 文件的所有行（无文件或空文件返回 []） */
  private async readLines(): Promise<string[]> {
    const file = Bun.file(this.filePath);
    if (!(await file.exists())) {
      return [];
    }

    const content = await file.text();
    if (!content.trim()) {
      return [];
    }

    return content.trim().split('\n');
  }
}

// ── 模块级纯函数 ──────────────────────────────────

/** 解析一行 JSON 为 RunEvent，格式错误返回 null */
function parseEventLine(line: string): RunEvent | null {
  try {
    const parsed = JSON.parse(line) as RunEvent;
    // 基本结构校验：确保不是任意 JSON 对象被当作 RunEvent
    if (parsed && typeof parsed.type === 'string' && typeof parsed.ts === 'number') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
