/**
 * Trace 装配（0.5 E5/E7/E9 / DECISION-010 §2.2、A-4 §11.1/§11.2）
 *
 * - `trace.enabled === false` 或 `trace.level === 'off'` → 零副作用；
 * - seq 由 core FileTraceRecorder 落盘时分配，asm 不自行分配；
 * - redactor 组合：core 默认 → 注入的 ext redactor（幂等）；
 * - tenant_id 缺失时补齐（缺省语义为 default 由调用方传入的 tenantId 决定）；
 * - 启动 prune / shutdown flush 由 bootstrap 调用本 control。
 *
 * @module vessel/trace-wiring
 */

import { copyFile, link, mkdtemp, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TRACE_OPTIONS,
  type TraceConfig,
  type VesselConfig,
} from '../packages/config/src/index';
import {
  createDefaultTraceRedactor,
  type EventStream,
  FileTraceRecorder,
  type PruneTraceResult,
  pruneTrace,
  type RunEvent,
  type TenantPaths,
  type TraceLevel,
  type TraceRedactor,
  type Unsubscribe,
} from '../packages/core/src/index';

/** trace 控制面（bootstrap / CLI 消费） */
export interface TraceControl {
  flush(runId?: string): Promise<void>;
  close(): Promise<void>;
  stats(): { written: number; failed: number };
  /** A-4 §11.3 冻结形状；dryRun 不删除原文件 */
  prune(opts?: { dryRun?: boolean }): Promise<PruneTraceResult>;
}

/** 可注入的 recorder（测试 / 更严格实现） */
export interface TraceRecorderLike {
  append(event: RunEvent): void;
  flush(runId?: string): Promise<void>;
  close(): Promise<void>;
  stats?(): { written: number; failed: number };
}

/** recorder 工厂 */
export type TraceRecorderFactory = (opts: {
  dir: string;
  level: TraceLevel;
  redactor?: TraceRedactor;
  /** 0.10 R2-14：是否记录 llm.stream.chunk（默认 false） */
  includeStreamChunks?: boolean;
}) => TraceRecorderLike;

/** installTrace 选项 */
export interface InstallTraceOptions {
  events: EventStream;
  config: VesselConfig;
  tenantPaths: TenantPaths;
  tenantId: string;
  /** ext redact-secrets 等更严格的实现；在 core 默认之后执行 */
  redactor?: TraceRedactor;
  factory?: TraceRecorderFactory;
}

/** 终端事件：触发 flush（不阻塞 publish） */
const TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled']);

/** trace 配置 + 默认值 */
export function resolveTraceOptions(config: VesselConfig): Required<TraceConfig> {
  const trace = config.trace;
  return {
    enabled: trace?.enabled ?? DEFAULT_TRACE_OPTIONS.enabled,
    level: trace?.level ?? DEFAULT_TRACE_OPTIONS.level,
    retentionDays: trace?.retentionDays ?? DEFAULT_TRACE_OPTIONS.retentionDays,
    maxRuns: trace?.maxRuns ?? DEFAULT_TRACE_OPTIONS.maxRuns,
    maxBytes: trace?.maxBytes ?? DEFAULT_TRACE_OPTIONS.maxBytes,
    includeStreamChunks: trace?.includeStreamChunks ?? DEFAULT_TRACE_OPTIONS.includeStreamChunks,
  };
}

/** core 默认 redactor → 注入实现；后者看到的是已脱敏事件 */
export function composeTraceRedactors(base: TraceRedactor, extra?: TraceRedactor): TraceRedactor {
  if (!extra) return base;
  return {
    redact(event: RunEvent): RunEvent {
      return extra.redact(base.redact(event));
    },
  };
}

/** 写失败只 warn，不再写回 trace（避免递归与静默） */
function warnWriteFailure(event: RunEvent): void {
  const data = event.data as Record<string, unknown>;
  const reason = typeof data.reason === 'string' ? ` (${data.reason})` : '';
  const error = typeof data.error === 'string' ? `: ${data.error}` : '';
  console.warn(`[vessel] trace.write.failed${reason}${error}`);
}

/**
 * dry-run：把 events 目录的 jsonl 硬链接（跨卷回退复制）到临时目录，
 * 用 core pruneTrace 在副本上计算删除集合，原目录零改动。
 *
 * 已知限制：跨卷时回退 `copyFile`，大目录会临时占用同等空间；
 * 临时目录在 finally 中递归清理，失败不影响原目录。
 */
async function dryRunPrune(
  traceDir: string,
  options: { retentionDays?: number; maxRuns?: number; maxBytes?: number },
): Promise<PruneTraceResult> {
  const temp = await mkdtemp(join(os.tmpdir(), 'vessel-trace-dry-'));
  try {
    const entries = await readdir(traceDir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl') || entry.startsWith('.')) continue;
      const source = join(traceDir, entry);
      const target = join(temp, entry);
      try {
        await link(source, target);
      } catch {
        await copyFile(source, target);
      }
    }
    return await pruneTrace(temp, options);
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

/** 按配置 prune 一个 tenant 的 trace；dryRun 不改原目录 */
export async function pruneTenantTrace(options: {
  config: VesselConfig;
  tenantPaths: TenantPaths;
  dryRun?: boolean;
}): Promise<PruneTraceResult> {
  const trace = resolveTraceOptions(options.config);
  const pruneOptions = {
    retentionDays: trace.retentionDays,
    maxRuns: trace.maxRuns,
    maxBytes: trace.maxBytes,
  };
  return options.dryRun
    ? dryRunPrune(options.tenantPaths.events_dir, pruneOptions)
    : pruneTrace(options.tenantPaths.events_dir, pruneOptions);
}

/**
 * 安装 trace。
 * @returns disabled / off 时返回 undefined（零副作用）
 */
export function installTrace(options: InstallTraceOptions): TraceControl | undefined {
  const trace = resolveTraceOptions(options.config);
  if (!trace.enabled || trace.level === 'off') return undefined;

  const redactor = composeTraceRedactors(createDefaultTraceRedactor(), options.redactor);
  const dir = options.tenantPaths.events_dir;
  const unsubscribes: Unsubscribe[] = [];

  let written = 0;
  let failed = 0;
  let recorder: TraceRecorderLike;

  if (options.factory) {
    // 自定义 recorder 没有内置订阅：wiring 负责 tenant_id、脱敏与终态 flush。
    recorder = options.factory({
      dir,
      level: trace.level,
      redactor,
      includeStreamChunks: trace.includeStreamChunks,
    });
    unsubscribes.push(
      options.events.subscribe((event) => {
        if (event.type.startsWith('trace.')) {
          if (event.type === 'trace.write.failed') {
            failed += 1;
            warnWriteFailure(event);
          }
          return;
        }

        // 自定义 recorder 与 core recorder 保持同一默认：流式分片默认不落盘。
        if (!trace.includeStreamChunks && event.type === 'llm.stream.chunk') return;

        const withTenant: RunEvent =
          event.tenant_id === undefined ? { ...event, tenant_id: options.tenantId } : event;
        try {
          recorder.append(redactor.redact(withTenant));
          written += 1;
        } catch {
          failed += 1;
        }

        if (TERMINAL_EVENTS.has(event.type)) {
          void recorder.flush(event.run_id).catch(() => {});
        }
      }),
    );
  } else {
    // core recorder 自己订阅、插 tenant_id、分配 seq、脱敏、终态 flush。
    recorder = new FileTraceRecorder({
      dir,
      level: trace.level,
      redactor,
      events: options.events,
      tenantId: options.tenantId,
      includeStreamChunks: trace.includeStreamChunks,
    });
    unsubscribes.push(
      options.events.subscribe((event) => {
        if (event.type === 'trace.write.failed') warnWriteFailure(event);
      }),
    );
  }

  let closed = false;

  return {
    flush: (runId?: string) => recorder.flush(runId),
    close: async () => {
      if (closed) return;
      closed = true;
      for (const unsubscribe of unsubscribes) {
        try {
          unsubscribe();
        } catch {
          // best-effort
        }
      }
      try {
        await recorder.close();
      } catch {
        // shutdown 失败不阻断退出
      }
    },
    stats: () => {
      const stats = recorder.stats?.();
      return stats ? { written: stats.written, failed: stats.failed } : { written, failed };
    },
    prune: (opts = {}) =>
      pruneTenantTrace({
        config: options.config,
        tenantPaths: options.tenantPaths,
        dryRun: opts.dryRun === true,
      }),
  };
}
