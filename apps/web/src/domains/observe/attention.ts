/**
 * Attention 收件箱的纯逻辑（无 React）。
 *
 * DECISION-038 §2.2：`interactions.list` 用 cursor 分页；Web 只在“加载更多”时
 * 追加下一页，按 `request_id` 去重，并保持服务端返回顺序。
 */
import type { ListedInteraction } from '../../gateway/interaction-hydration';

/** 与 CLI `--limit` 缺省一致。 */
export const ATTENTION_PAGE_SIZE = 20;

/**
 * 追加下一页：已有 request_id 不重复插入，新条目保持页内顺序。
 * 服务端已按 (created_at, request_id) 稳定排序，这里不重排。
 */
export function appendInteractions(
  prev: readonly ListedInteraction[],
  page: readonly ListedInteraction[],
): ListedInteraction[] {
  const seen = new Set(prev.map((item) => item.request_id));
  const next = [...prev];
  for (const item of page) {
    if (!item.request_id || seen.has(item.request_id)) continue;
    seen.add(item.request_id);
    next.push(item);
  }
  return next;
}

/**
 * 401 / 403：不得渲染列表内容（DECISION-038 §2.2 失败语义）。
 * 优先用稳定 code；非 JSON 错误体只会留下 `HTTP 401/403` 文案，一并识别。
 */
export function isAttentionAuthError(code: string | undefined, message?: string): boolean {
  if (code === 'unauthorized' || code === 'forbidden') return true;
  const text = message?.trim() ?? '';
  return text === 'HTTP 401' || text === 'HTTP 403';
}
