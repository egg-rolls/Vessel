/**
 * 会话级请求组成快照（additive `sessions.composition`，q-context-composition）
 * 的装配实现。
 *
 * ## 取什么
 * 写侧（core `ExecutionUnit.chatWithOverflowRetry`）在每次真实请求过闸后落一条
 * `context.composition` 事实事件：请求视图 token 的固定成分表（system / 历史
 * user/assistant/tool / 占位 / 环境卡 / 图片 / 摘要 / 工具声明 / 开销）+ 总数 +
 * 锚点校正值 + 窗口上限。本模块从**时间线尾窗**回扫这类事件（`readTailMatches`，
 * 与 `context-usage.ts` 同一个读口、同一套成本上界：首窗 64 KiB，miss 扩窗
 * 64K→256K→1M→4M，累计 ≈5.3 MiB 后返回「没有数据」，不全量扫盘）。
 *
 * ## 与 context_usage 的分工
 * `context_usage` 回答「窗口用了多少」（一个数）；本模块回答「被什么占满」
 * （成分明细）。两者同源于请求视图估算，`corrected_tokens` 与 `context_usage.used`
 * 是同一个数（同一次请求的 `correctedContextTokens`）。
 *
 * ## 为什么不做水位缓存
 * `sessions.composition` 是显式 introspection RPC（人/分析脚本按需调，低频），
 * 不像 `sessions.get` 那样被页面加载/轮询反复问。一次调用最多读一遍尾窗，
 * 缓存的收益抵不过它的失效复杂度 —— 端口契约里因此也没有 `watermark`。
 *
 * @module vessel/context-composition
 */

import type { SessionEventRecord } from '../../packages/core/src/index';
import type { SessionEventTailReader } from './context-usage';

/** 线上形状（与 `packages/serve` 的 `SessionCompositionSnapshot` 一致）。 */
export interface SessionCompositionSnapshot {
  at?: number;
  run_id?: string;
  attempt?: number;
  model?: string;
  total_tokens: number;
  corrected_tokens?: number;
  context_max?: number;
  message_count: number;
  components: Record<string, { tokens: number; count: number; share: number }>;
  cleared_original_tokens?: number;
  cleared_saved_tokens?: number;
}

/** 取值面（`sessions.composition` 的 `composition` 端口）。 */
export interface ContextCompositionSource {
  /** 最近 `limit` 条快照，新 → 旧；没有数据 = 空数组。 */
  lookup(sessionId: string, limit: number): Promise<SessionCompositionSnapshot[]>;
}

export interface ContextCompositionSourceOptions {
  /** 事件读口（时间线实现；与 context-usage 同一个 `TimelineEventLog`）。 */
  tail: SessionEventTailReader;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只认有限非负数字；其它一律当没有（不猜、不补 0）。 */
function numberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 成分表收敛：只保留形状合法（tokens/count/share 都是有限非负数）的项。 */
function normalizeComponents(
  raw: unknown,
): Record<string, { tokens: number; count: number; share: number }> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, { tokens: number; count: number; share: number }> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const tokens = numberField(value, 'tokens');
    const count = numberField(value, 'count');
    const share = numberField(value, 'share');
    if (tokens === undefined || count === undefined || share === undefined) continue;
    out[key] = { tokens: Math.floor(tokens), count: Math.floor(count), share };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 一条事件 → 线上快照；载荷不成形（缺 total/components）= 跳过，不产半截数据。 */
function toSnapshot(record: SessionEventRecord): SessionCompositionSnapshot | undefined {
  const data = record.data;
  if (!isRecord(data)) return undefined;
  const total = numberField(data, 'total_tokens');
  const messageCount = numberField(data, 'message_count');
  const components = normalizeComponents(data.components);
  if (total === undefined || messageCount === undefined || components === undefined) {
    return undefined;
  }
  const corrected = numberField(data, 'corrected_tokens');
  const contextMax = numberField(data, 'context_max');
  const attempt = numberField(data, 'attempt');
  const clearedOriginal = numberField(data, 'cleared_original_tokens');
  const clearedSaved = numberField(data, 'cleared_saved_tokens');
  const runId = stringField(data, 'run_id') ?? (record.run_id || undefined);
  const model = stringField(data, 'model');
  return {
    ...(typeof record.ts === 'number' && Number.isFinite(record.ts) ? { at: record.ts } : {}),
    ...(runId !== undefined ? { run_id: runId } : {}),
    ...(attempt !== undefined && attempt >= 1 ? { attempt: Math.floor(attempt) } : {}),
    ...(model !== undefined ? { model } : {}),
    total_tokens: Math.floor(total),
    ...(corrected !== undefined ? { corrected_tokens: Math.floor(corrected) } : {}),
    ...(contextMax !== undefined && contextMax > 0 ? { context_max: Math.floor(contextMax) } : {}),
    message_count: Math.floor(messageCount),
    components,
    ...(clearedOriginal !== undefined
      ? { cleared_original_tokens: Math.floor(clearedOriginal) }
      : {}),
    ...(clearedSaved !== undefined ? { cleared_saved_tokens: Math.floor(clearedSaved) } : {}),
  };
}

/**
 * 构造 `sessions.composition` 的取值面。
 *
 * `readTailMatches` 返回**新 → 旧**；这里保持该顺序（最近一次请求在最前），
 * 只取形状合法的前 `limit` 条。读盘失败由调用方（serve handler）按 RPC 错误
 * 冒泡 —— 与 context-usage 的「派生值静默缺省」不同：这是显式查询，失败要可见。
 */
export function createContextCompositionSource(
  options: ContextCompositionSourceOptions,
): ContextCompositionSource {
  const { tail } = options;
  return {
    async lookup(sessionId: string, limit: number): Promise<SessionCompositionSnapshot[]> {
      const want = Math.min(Math.max(Math.floor(limit), 1), 100);
      const { records } = await tail.readTailMatches(sessionId, ['context.composition'], {
        limit: want,
      });
      const snapshots: SessionCompositionSnapshot[] = [];
      for (const record of records) {
        const snapshot = toSnapshot(record);
        if (snapshot !== undefined) snapshots.push(snapshot);
        if (snapshots.length >= want) break;
      }
      return snapshots;
    },
  };
}
