/**
 * 上下文真实用量锚点：校验 / 夹紧（0.52 C）
 * @module @vessel-agent/core/context
 *
 * 锚点解决的是「同一份上下文重启前后显示 80% / 51%」：provider 上报的
 * `prompt_tokens` 是真实口径，本地估算对 CJK / reasoning / 工具参数偏乐观。
 * 记住一次「真实 ÷ 估算」的比值，就能在 `realTokens` 归零期间把估算拉回真实量级。
 *
 * 这里只放纯函数：落盘/加载路径（file / sqlite backend）和 WorkingContext 都要用，
 * 放在 context-manager 里会让 session 层反向依赖运行时实现。
 */

import type { ContextAnchor } from '../types/context.js';

/**
 * 比值合法区间。实测长会话偏差约 1.48 倍，区间留足余量；区间外的值一律当脏数据
 * —— 一个被写坏的 ratio（0 / NaN / 100）会把上下文占用显示成荒唐数字，比不校正更糟。
 */
export const CONTEXT_ANCHOR_RATIO_MIN = 0.5;
export const CONTEXT_ANCHOR_RATIO_MAX = 3;

/**
 * 记录一次真实用量时把比值夹进合法区间；非有限 / 非正值返回 undefined（不校正）。
 *
 * 记录路径选择「夹紧」而不是「丢弃」：这是刚测出来的真实数据，越界通常意味着
 * 分母异常（例如刚压缩完窗口很小），夹到边界仍比完全弃用更接近真相。
 */
export function clampAnchorRatio(ratio: number): number | undefined {
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
  return Math.min(CONTEXT_ANCHOR_RATIO_MAX, Math.max(CONTEXT_ANCHOR_RATIO_MIN, ratio));
}

/**
 * 校验一份落盘的锚点（可能来自手改 / 旧版本 / 别的模型）。
 *
 * 与记录路径相反：这里**不**夹紧，越界直接判脏丢弃。落盘值本该落在区间内，
 * 越界说明它不可信；宁可退回裸估算（行为 = 0.51），也不拿一个来路不明的比值
 * 去放大展示数字。
 */
export function normalizeContextAnchor(anchor: unknown): ContextAnchor | undefined {
  if (anchor === null || typeof anchor !== 'object') return undefined;
  const raw = anchor as Partial<ContextAnchor>;
  const { ratio, prompt_tokens: promptTokens, request_estimate: requestEstimate } = raw;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return undefined;
  if (ratio < CONTEXT_ANCHOR_RATIO_MIN || ratio > CONTEXT_ANCHOR_RATIO_MAX) return undefined;
  if (typeof promptTokens !== 'number' || !Number.isFinite(promptTokens)) return undefined;
  if (typeof requestEstimate !== 'number' || !Number.isFinite(requestEstimate)) return undefined;
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0;
  const model = typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : undefined;
  return {
    ratio,
    prompt_tokens: promptTokens,
    request_estimate: requestEstimate,
    ...(model !== undefined ? { model } : {}),
    at,
  };
}
