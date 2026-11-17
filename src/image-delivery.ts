/**
 * 图片投递状态（additive `sessions.get` 的 `image_delivery`，0.56）的装配实现。
 *
 * ## 为什么从事件派生，而不是写进 `refs`
 *
 * `refs[]` 里加 `status` / `sent_at` 是双重的坏：① 前缀守卫逐条
 * `JSON.stringify(message)` 比字节 —— 改 status 就是改写历史前缀；② `messageSignature`
 * 只取 `kind:path`，**它根本看不见** `status`（既不进签名、又污染前缀，最坏的一类字段）。
 * 所以投递状态只有**事件**这一个真相源（`image.sent` / `context.image_dropped`），
 * 刷新 / 重启后从日志重新折叠即可（决策 3：P0 就显示，且刷新后仍然正确）。
 *
 * ## 折叠规则（与 `context-usage` / `system-context` 同一代价模型）
 *
 * 尾窗回扫（`readTailMatches`）：首窗 64 KiB，命中即停；没有这类事件时按
 * 64K→256K→1M→4M 扩窗，最多 ≈5.3 MiB 后返回「不知道」，**不全量扫盘**。
 * 记录是**新 → 旧**顺序：同一个 `sha8` 只认**第一条**（= 最近发生的那件事），
 * 于是「先发过、后来被压缩删掉」的图会显示「已丢弃（压缩）」—— 那正是模型现在的视角。
 *
 * 已知边界（照实写）：尾窗之外的旧事件折叠不到 ⇒ 更早消息的 chip 会显示
 * `not_sent / no_delivery_event`。这与 `system_context` 的已知限制同一档
 *（更早轮次的卡刷新后不回来），不是 bug。
 *
 * @module vessel/image-delivery
 */

import type { SessionEventRecord } from '../packages/core/src/index';
import type { SessionEventTailReader } from './context-usage';

/** 一张图的投递事实（与 `packages/serve` 的 `ImageDeliveryView` 结构一致）。 */
export interface ImageDeliveryView {
  status: 'sent' | 'dropped' | 'not_sent';
  reason?: string;
  sha8?: string;
  tokens?: number;
  backend?: string;
  model?: string;
}

/** `sessions.get` 的 `imageDelivery` 端口（结构类型对齐 serve 的同名接口）。 */
export interface ImageDeliveryPort {
  lookup(sessionId: string): Promise<ReadonlyMap<string, ImageDeliveryView> | undefined>;
  watermark(sessionId: string): Promise<string | undefined>;
}

/** 一次回扫最多看这么多条匹配记录（够覆盖「多轮贴图 + 压缩」的近期历史）。 */
const TAIL_MATCH_LIMIT = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textField(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(source: unknown, key: string): number | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/** 一条事件 → 投递事实（形状不对返回 `undefined`，调用方按「没有记录」处理）。 */
function deliveryOfRecord(record: SessionEventRecord): { sha8: string; view: ImageDeliveryView } | undefined {
  const data = record.data;
  const sha8 = textField(data, 'sha8');
  if (sha8 === undefined) return undefined;
  if (record.type === 'image.sent') {
    const tokens = numberField(data, 'tokens');
    const backend = textField(data, 'backend');
    const model = textField(data, 'model');
    return {
      sha8,
      view: {
        status: 'sent',
        sha8,
        ...(tokens !== undefined ? { tokens } : {}),
        ...(backend !== undefined ? { backend } : {}),
        ...(model !== undefined ? { model } : {}),
      },
    };
  }
  if (record.type === 'context.image_dropped') {
    const status = data !== null && isRecord(data) ? data.status : undefined;
    const reason = textField(data, 'reason');
    return {
      sha8,
      view: {
        status: status === 'not_sent' ? 'not_sent' : 'dropped',
        sha8,
        ...(reason !== undefined ? { reason } : {}),
      },
    };
  }
  return undefined;
}

export interface ImageDeliverySourceOptions {
  /** 事件**读口**（与 `contextUsage` / `systemContext` 同一个实例：时间线读口）。 */
  tail: SessionEventTailReader;
  /** 该会话的**尾水位**（缓存键：水位不变 ⇒ 派生结果不可能变）。 */
  watermark(sessionId: string): Promise<string | undefined>;
}

/**
 * 构造 `sessions.get.image_delivery` 的取值面。
 *
 * `lookup` 返回 `undefined` = 「不知道」（没有日志 / 尾窗内没有这类事件），
 * 调用方与客户端都按「没有记录」处理，不猜、不补默认值。
 */
export function createImageDeliverySource(
  options: ImageDeliverySourceOptions,
): ImageDeliveryPort {
  const { tail } = options;
  return {
    async lookup(sessionId: string): Promise<ReadonlyMap<string, ImageDeliveryView> | undefined> {
      const { records } = await tail.readTailMatches(
        sessionId,
        ['image.sent', 'context.image_dropped'],
        { limit: TAIL_MATCH_LIMIT },
      );
      // `records` 已按新 → 旧排序：同一 sha8 只认第一条（最近发生的那件事）。
      const out = new Map<string, ImageDeliveryView>();
      for (const record of records) {
        const parsed = deliveryOfRecord(record);
        if (parsed === undefined) continue;
        if (out.has(parsed.sha8)) continue;
        out.set(parsed.sha8, parsed.view);
      }
      return out.size > 0 ? out : undefined;
    },

    watermark(sessionId: string): Promise<string | undefined> {
      return options.watermark(sessionId);
    },
  };
}
