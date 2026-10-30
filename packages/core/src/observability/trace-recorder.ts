/**
 * File trace recorder（0.5 F2 / DECISION-010 §2.2、E5）
 *
 * - 每 run 一个 JSONL：`<dir>/<encodeURIComponent(run_id)>.jsonl`
 * - `append` 同步入队、立即返回；按 run 串行落盘
 * - seq 在落盘时分配并持久化，以文件尾部最大 seq 为种子（跨 resume 单调）
 * - 写前 redactor；`metadata` 档只保留白名单字段；`off` 不落盘
 * - 写失败发 `trace.write.failed`，绝不静默
 *
 * @module @vessel-agent/core/observability
 */

import { appendFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventStream, RunEvent, Unsubscribe } from '../types/event.js';
import type { TraceLevel, TraceRecorder, TraceRedactor } from '../types/trace.js';
import { createDefaultTraceRedactor } from './trace-redactor.js';

const DEFAULT_MAX_PENDING_EVENTS = 10_000;
const SEQ_TAIL_BYTES = 64 * 1024;
/**
 * trace 含 prompt / 工具结果，只允许属主读写（0.10 R2-14）。
 * `mode` 只在创建文件时生效；既有文件的权限不被改写。
 */
const TRACE_FILE_MODE = 0o600;
const FAILURE_EVENT_COOLDOWN_MS = 1_000;
const TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const METADATA_KEYS = [
  'status',
  'tool_name',
  'duration_ms',
  'iterations',
  'iteration',
  'message_count',
  'finish_reason',
] as const;
/**
 * `metadata` 档的 usage 白名单。
 *
 * 0.29 B3：加入两个缓存计数。它们与 `prompt_tokens` 同源（CONTRACT-0.29 §3），
 * 漏掉会让 `rebuildMetrics` 在 metadata 档下少两个字段，破坏 ADR-047 的
 * 「重建形状 == 实时 collector 形状」。
 */
const USAGE_KEYS = [
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'total_cost',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;

/** 每 run 的队列与 seq 状态 */
interface RunTraceState {
  queue: RunEvent[];
  draining: boolean;
  seqLoaded: boolean;
  /** 文件末尾不是换行（上次写被截断）：首次追加前补一个换行 */
  needsLeadingNewline: boolean;
  lastSeq: number;
  written: number;
  failed: number;
  dropped: number;
  overflowSignaled: boolean;
  overflowWritten: boolean;
  lastFailureEventAt: number;
  idleWaiters: Array<() => void>;
}

/** recorder 统计 */
export interface TraceRecorderStats {
  written: number;
  failed: number;
  dropped: number;
  queued: number;
}

/** FileTraceRecorder 选项 */
export interface FileTraceRecorderOptions {
  /** tenant 的 events/ 目录 */
  dir: string;
  level?: TraceLevel;
  redactor?: TraceRedactor;
  /** 提供则自动订阅 */
  events?: EventStream;
  /** 写入前为缺失 tenant_id 的事件补齐 */
  tenantId?: string;
  /** 收到 run 终态后 flush；默认 true */
  flushOnTerminal?: boolean;
  /** 每 run 队列上限；默认 10000；0 = 不限 */
  maxPendingEvents?: number;
  /**
   * 是否把流式 chunk 落盘；默认 false（0.10 R2-14）。
   * 匹配 `llm.stream.chunk` 及带前缀的转发形式（如 `subagent.llm.stream.chunk`）。
   * 实时事件仍照常发布，只是不写 trace。
   */
  includeStreamChunks?: boolean;
  now?: () => number;
}

function resolveMaxPending(value?: number): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_PENDING_EVENTS;
  return Math.max(0, Math.floor(value));
}

function truncate(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

/**
 * 流式 chunk 事件：`llm.stream.chunk` 或 `<prefix>.llm.stream.chunk`
 * （0.14：subagent / 转发后的前缀也必须按同一开关过滤，否则会绕过 trace 策略）。
 */
function isStreamChunkEvent(type: string): boolean {
  return type === 'llm.stream.chunk' || type.endsWith('.llm.stream.chunk');
}

/** metadata 档投影：先脱敏，再丢弃消息/参数/结果 */
function projectMetadata(event: RunEvent): RunEvent {
  const source =
    typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data)
      ? (event.data as Record<string, unknown>)
      : {};
  const data: Record<string, unknown> = {};

  for (const key of METADATA_KEYS) {
    if (source[key] !== undefined) data[key] = source[key];
  }

  const usage = source.usage;
  if (typeof usage === 'object' && usage !== null && !Array.isArray(usage)) {
    const sourceUsage = usage as Record<string, unknown>;
    const projected: Record<string, number> = {};
    for (const key of USAGE_KEYS) {
      const value = sourceUsage[key];
      if (typeof value === 'number' && Number.isFinite(value)) projected[key] = value;
    }
    if (Object.keys(projected).length > 0) data.usage = projected;
  }

  const error = truncate(source.error, 500);
  if (error !== undefined) data.error = error;
  const reason = truncate(source.reason, 200);
  if (reason !== undefined) data.reason = reason;

  return {
    type: event.type,
    run_id: event.run_id,
    data,
    ts: event.ts,
    ...(event.seq !== undefined ? { seq: event.seq } : {}),
    ...(event.tenant_id !== undefined ? { tenant_id: event.tenant_id } : {}),
  };
}

/**
 * 文件 trace recorder。
 *
 * 订阅事件流时自动跳过 `trace.*` / `replay.*`，避免自激与回放重复落盘。
 */
export class FileTraceRecorder implements TraceRecorder {
  private readonly dir: string;
  private readonly level: TraceLevel;
  private readonly redactor: TraceRedactor;
  private readonly tenantId?: string;
  private readonly flushOnTerminal: boolean;
  private readonly maxPendingEvents: number;
  private readonly includeStreamChunks: boolean;
  private readonly now: () => number;
  private readonly runs = new Map<string, RunTraceState>();

  private dirReady?: Promise<void>;
  private unsubscribe?: Unsubscribe;
  private closed = false;

  constructor(options: FileTraceRecorderOptions) {
    if (!options.dir) throw new Error('FileTraceRecorder requires a dir');
    this.dir = options.dir;
    this.level = options.level ?? 'full';
    this.redactor = options.redactor ?? createDefaultTraceRedactor();
    this.tenantId = options.tenantId;
    this.flushOnTerminal = options.flushOnTerminal ?? true;
    this.maxPendingEvents = resolveMaxPending(options.maxPendingEvents);
    this.includeStreamChunks = options.includeStreamChunks ?? false;
    this.now = options.now ?? (() => Date.now());
    if (options.events) this.attach(options.events);
  }

  /** 订阅事件流；已有订阅时先退订 */
  attach(events: EventStream): Unsubscribe {
    this.unsubscribe?.();
    this.eventSourceRef = events;
    const unsubscribe = events.subscribe((event) => this.handle(event));
    this.unsubscribe = unsubscribe;
    return unsubscribe;
  }

  /** 非阻塞入队 */
  append(event: RunEvent): void {
    if (this.closed || this.level === 'off') return;
    // 0.18 C7：删除会话的墓碑不得写成新的孤儿 run 文件（`<session_id>.jsonl`）。
    // 删除结果仍作为实时事件广播；持久化由会话索引/事件日志负责。
    if (event.type === 'session.deleted') return;
    // 0.10 R2-14：流式 chunk 数量大、逐片落盘性价比低，完整内容已在
    // `llm.request` / `llm.response`；实时事件发布不受影响，默认不进 trace。
    // 0.14：带前缀的转发事件（如 `subagent.llm.stream.chunk`）同样过滤。
    if (!this.includeStreamChunks && isStreamChunkEvent(event.type)) return;
    if (!this.validRunId(event.run_id)) {
      this.emitWriteFailure(event.run_id, new Error('invalid_run_id'));
      return;
    }

    const state = this.runState(event.run_id);
    if (this.maxPendingEvents > 0 && state.queue.length >= this.maxPendingEvents) {
      state.dropped += 1;
      if (!state.overflowSignaled) {
        state.overflowSignaled = true;
        this.emitWriteFailure(event.run_id, new Error('queue_overflow'), 'queue_overflow');
      }
      return;
    }

    state.queue.push(event);
    if (!state.draining) void this.drain(event.run_id);
  }

  /** 等待指定 run（或全部）队列排空，并写 overflow 标记 */
  async flush(runId?: string): Promise<void> {
    if (runId !== undefined) {
      const state = this.runs.get(runId);
      if (state) await this.flushOne(runId, state);
      return;
    }
    await Promise.all([...this.runs.entries()].map(([id, state]) => this.flushOne(id, state)));
  }

  /** 退订并 flush 全部 */
  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.flush();
    this.closed = true;
  }

  stats(): TraceRecorderStats {
    let written = 0;
    let failed = 0;
    let dropped = 0;
    let queued = 0;
    for (const state of this.runs.values()) {
      written += state.written;
      failed += state.failed;
      dropped += state.dropped;
      queued += state.queue.length;
    }
    return { written, failed, dropped, queued };
  }

  // -- private -------------------------------------------------------------

  private handle(event: RunEvent): void {
    // 不自激，也不把回放事件重复落盘
    if (event.type.startsWith('trace.') || event.type.startsWith('replay.')) return;
    this.append(event);
    if (this.flushOnTerminal && TERMINAL_EVENTS.has(event.type)) {
      void this.flush(event.run_id).catch(() => {});
    }
  }

  private validRunId(runId: string): boolean {
    if (typeof runId !== 'string' || runId.length === 0) return false;
    try {
      encodeURIComponent(runId);
      return true;
    } catch {
      return false;
    }
  }

  private filePath(runId: string): string {
    return join(this.dir, `${encodeURIComponent(runId)}.jsonl`);
  }

  private runState(runId: string): RunTraceState {
    let state = this.runs.get(runId);
    if (!state) {
      state = {
        queue: [],
        draining: false,
        seqLoaded: false,
        needsLeadingNewline: false,
        lastSeq: 0,
        written: 0,
        failed: 0,
        dropped: 0,
        overflowSignaled: false,
        overflowWritten: false,
        lastFailureEventAt: 0,
        idleWaiters: [],
      };
      this.runs.set(runId, state);
    }
    return state;
  }

  private async ensureDir(): Promise<void> {
    this.dirReady ??= mkdir(this.dir, { recursive: true }).then(() => {});
    return this.dirReady;
  }

  /** 从文件尾部读取最大 seq（旧无 seq 文件从 0 开始） */
  private async seedSeq(runId: string, state: RunTraceState): Promise<void> {
    if (state.seqLoaded) return;
    state.seqLoaded = true;

    try {
      const path = this.filePath(runId);
      let size = 0;
      try {
        size = (await stat(path)).size;
      } catch {
        return;
      }
      if (size <= 0) return;

      const start = Math.max(0, size - SEQ_TAIL_BYTES);
      const text = await Bun.file(path).slice(start).text();
      state.needsLeadingNewline = !text.endsWith('\n');
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { seq?: unknown };
          if (typeof parsed.seq === 'number' && Number.isFinite(parsed.seq)) {
            state.lastSeq = Math.floor(parsed.seq);
            return;
          }
        } catch {
          // 截断/损坏行跳过
        }
      }
    } catch {
      // seed 失败按 0 开始
    }
  }

  private prepare(event: RunEvent, state: RunTraceState): RunEvent {
    const withTenant =
      this.tenantId !== undefined && event.tenant_id === undefined
        ? { ...event, tenant_id: this.tenantId }
        : event;

    const supplied =
      typeof withTenant.seq === 'number' && Number.isFinite(withTenant.seq)
        ? Math.floor(withTenant.seq)
        : undefined;
    const seq = supplied !== undefined && supplied > state.lastSeq ? supplied : state.lastSeq + 1;
    state.lastSeq = seq;

    const sequenced: RunEvent = { ...withTenant, seq };
    const redacted = this.redactor.redact(sequenced);
    return this.level === 'metadata' ? projectMetadata(redacted) : redacted;
  }

  private async drain(runId: string): Promise<void> {
    const state = this.runState(runId);
    if (state.draining) return;
    state.draining = true;

    try {
      await this.ensureDir();
      await this.seedSeq(runId, state);

      if (state.needsLeadingNewline) {
        state.needsLeadingNewline = false;
        await appendFile(this.filePath(runId), '\n', {
          encoding: 'utf8',
          mode: TRACE_FILE_MODE,
        });
      }

      while (state.queue.length > 0) {
        const event = state.queue.shift();
        if (event === undefined) break;
        try {
          const prepared = this.prepare(event, state);
          await appendFile(this.filePath(runId), `${JSON.stringify(prepared)}\n`, {
            encoding: 'utf8',
            mode: TRACE_FILE_MODE,
          });
          state.written += 1;
        } catch (error) {
          state.failed += 1;
          this.emitWriteFailure(runId, error);
        }
      }
    } catch (error) {
      // 目录不可写：丢弃当前队列并显式上报（flush 不会挂起）
      state.failed += 1;
      state.dropped += state.queue.length;
      state.queue = [];
      this.emitWriteFailure(runId, error);
    } finally {
      state.draining = false;
      if (state.queue.length > 0 && !this.closed) {
        void this.drain(runId);
      } else if (state.queue.length === 0) {
        const waiters = state.idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }

  private waitIdle(state: RunTraceState): Promise<void> {
    if (!state.draining && state.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      state.idleWaiters.push(resolve);
    });
  }

  private async flushOne(runId: string, state: RunTraceState): Promise<void> {
    await this.waitIdle(state);
    if (this.level !== 'off') await this.writeOverflowMarker(runId, state);
  }

  /** A-4 §11.2：flush 时直接写一行 trace.overflow{dropped}，不经队列 */
  private async writeOverflowMarker(runId: string, state: RunTraceState): Promise<void> {
    if (state.dropped <= 0 || state.overflowWritten) return;
    state.overflowWritten = true;
    const marker = {
      type: 'trace.overflow',
      run_id: runId,
      data: { dropped: state.dropped },
      ts: this.now(),
      ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
    };
    try {
      await this.ensureDir();
      await appendFile(this.filePath(runId), `${JSON.stringify(marker)}\n`, {
        encoding: 'utf8',
        mode: TRACE_FILE_MODE,
      });
    } catch (error) {
      state.failed += 1;
      this.emitWriteFailure(runId, error);
    }
  }

  private emitWriteFailure(runId: string, error: unknown, reason?: string): void {
    const state = this.runs.get(runId);
    const now = this.now();
    if (state) {
      if (now - state.lastFailureEventAt < FAILURE_EVENT_COOLDOWN_MS) return;
      state.lastFailureEventAt = now;
    }

    const events = this.eventSource();
    if (!events) return;
    const message = error instanceof Error ? error.message : String(error);
    try {
      events.publish({
        type: 'trace.write.failed',
        run_id: typeof runId === 'string' && runId.length > 0 ? runId : 'unknown',
        data: {
          run_id: typeof runId === 'string' && runId.length > 0 ? runId : 'unknown',
          error: message,
          ...(reason !== undefined ? { reason } : {}),
        },
        ts: now,
        ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
      });
    } catch {
      // 事件投递失败不再向上抛
    }
  }

  /** attach 时保存的事件流（用于发 trace.write.failed） */
  private eventSourceRef?: EventStream;

  private eventSource(): EventStream | undefined {
    return this.eventSourceRef;
  }
}
