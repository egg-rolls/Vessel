/**
 * 运行详情「原始事件日志」的纯函数：行索引、过滤、分页窗口与单行摘要。
 *
 * 这一页是查日志的面：一行一事件、不做 tool call 折叠、不生成会话卡片。
 * 事件类型是开放字符串，未知类型走通用载荷预览。
 */
import type { RunEvent } from '../../gateway/types';
import { eventCategory, type RunEventFilter } from '../../state/run-detail';

/**
 * 单页渲染上限。分页而不是虚拟滚动：行高随展开变化（展开区是完整 JSON），
 * 自己写的窗口化要么钉死行高（展开就破），要么得逐行量高并维持滚动锚点；
 * 分页把 DOM 规模钉在 200 行以内，过滤后页码可预测，也不引入新依赖。
 */
export const EVENT_LOG_PAGE_SIZE = 200;

export interface EventLogRow {
  /** React key：seq 优先，无 seq 的实时事件用 type@ts 兜底（合并时已按此去重）。 */
  key: string;
  event: RunEvent;
  /** 折叠态的单行摘要（原始载荷的文本预览）。 */
  summary: string;
  /** 关键字检索用的预计算文本（小写）：type + 摘要 + 完整载荷。 */
  search: string;
}

export interface EventLogFilter {
  category?: RunEventFilter;
  /** 类型前缀，大小写不敏感；空串不过滤。 */
  typePrefix?: string;
  /** run 内 seq 下界（含）；事件没有 seq 时按「不在范围内」处理。 */
  fromSeq?: number;
  /** run 内 seq 上界（含）。 */
  toSeq?: number;
  /** 关键字：命中类型 / 摘要 / 载荷任意一处。 */
  keyword?: string;
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 载荷的紧凑 JSON 文本（单行）。 */
function payloadText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 载荷预览：压成单行并截断，供折叠态一行显示。 */
function oneLine(value: unknown, limit = 240): string {
  const compact = payloadText(value).replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

function messageCountOf(data: Record<string, unknown>): number | undefined {
  if (typeof data.message_count === 'number') return data.message_count;
  if (Array.isArray(data.messages)) return data.messages.length;
  return undefined;
}

/**
 * 一行摘要（纯文本）。
 *
 * 只保留扫日志需要的字段：工具名/参数、耗时、结果、错误文本、token 数。
 * 完整载荷在行的展开区，摘要不重复整段 JSON。
 */
export function eventSummary(event: RunEvent): string {
  const data = event.data;
  switch (event.type) {
    case 'tool.call.started': {
      const args = data.arguments !== undefined ? data.arguments : data.args;
      const parts = [textOf(data.tool_name) ?? 'tool'];
      if (args !== undefined) parts.push(oneLine(args, 200));
      return parts.join(' ');
    }
    case 'tool.call.completed': {
      const parts = [textOf(data.tool_name) ?? 'tool'];
      if (typeof data.duration_ms === 'number') parts.push(`${data.duration_ms}ms`);
      if (data.result !== undefined) parts.push(oneLine(data.result, 200));
      return parts.join(' · ');
    }
    case 'tool.call.failed':
      return [textOf(data.tool_name) ?? 'tool', textOf(data.error) ?? 'error'].join(' · ');
    case 'llm.request': {
      const parts: string[] = [];
      const messages = messageCountOf(data);
      if (messages !== undefined) parts.push(`${messages} msgs`);
      if (Array.isArray(data.tools) && data.tools.length > 0) {
        parts.push(`${data.tools.length} tools`);
      }
      return parts.join(' · ');
    }
    case 'llm.response': {
      const usage = data.usage as { total_tokens?: unknown } | undefined;
      const parts = [textOf(data.finish_reason) ?? ''];
      if (typeof usage?.total_tokens === 'number') parts.push(`${usage.total_tokens} tok`);
      return parts.filter(Boolean).join(' · ');
    }
    case 'guardrail.blocked':
      return [textOf(data.guardrail_name) ?? 'guardrail', textOf(data.reason) ?? '']
        .filter(Boolean)
        .join(' · ');
    default: {
      // 兜底的失败/错误事件：摘要必须保留错误文本，不能只藏在展开区。
      if (
        event.type === 'error' ||
        event.type.endsWith('.failed') ||
        event.type.endsWith('.error')
      ) {
        const message = textOf(data.error) ?? textOf(data.message);
        if (message !== undefined) return message;
      }
      return oneLine(data);
    }
  }
}

/**
 * 事件 → 日志行。按事件对象引用缓存：live 事件每次合批只新增几行，
 * 整表重建时命中缓存，不重复 stringify 大 payload。
 */
const rowCache = new WeakMap<RunEvent, EventLogRow>();

function rowOf(event: RunEvent): EventLogRow {
  const cached = rowCache.get(event);
  if (cached !== undefined) return cached;
  const summary = eventSummary(event);
  const row: EventLogRow = {
    key: `${event.seq ?? ''}:${event.type}@${event.ts}`,
    event,
    summary,
    search: `${event.type} ${summary} ${payloadText(event.data)}`.toLowerCase(),
  };
  rowCache.set(event, row);
  return row;
}

export function buildLogRows(events: readonly RunEvent[]): EventLogRow[] {
  return events.map(rowOf);
}

/** seq 输入框 → 边界；空串或非数字视为不设界。 */
export function parseSeqInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

/** 客户端内存过滤：类别 / 类型前缀 / seq 范围 / 关键字，可叠加。 */
export function filterLogRows(
  rows: readonly EventLogRow[],
  filter: EventLogFilter = {},
): readonly EventLogRow[] {
  const category = filter.category ?? 'all';
  const prefix = (filter.typePrefix ?? '').trim().toLowerCase();
  const keyword = (filter.keyword ?? '').trim().toLowerCase();
  const { fromSeq, toSeq } = filter;
  if (
    category === 'all' &&
    prefix === '' &&
    keyword === '' &&
    fromSeq === undefined &&
    toSeq === undefined
  ) {
    return rows;
  }
  return rows.filter((row) => {
    if (fromSeq !== undefined) {
      const seq = row.event.seq;
      if (typeof seq !== 'number' || seq < fromSeq) return false;
    }
    if (toSeq !== undefined) {
      const seq = row.event.seq;
      if (typeof seq !== 'number' || seq > toSeq) return false;
    }
    if (prefix !== '' && !row.event.type.toLowerCase().startsWith(prefix)) return false;
    if (category !== 'all' && eventCategory(row.event.type) !== category) return false;
    if (keyword !== '' && !row.search.includes(keyword)) return false;
    return true;
  });
}

export interface EventLogWindow<T> {
  rows: readonly T[];
  /** 实际页码（越界时收敛到 [1, pageCount]）。 */
  page: number;
  pageCount: number;
  total: number;
}

/** 取某一页的行；页码越界时收敛，不渲染空白页。 */
export function eventLogWindow<T>(
  rows: readonly T[],
  page: number,
  pageSize: number = EVENT_LOG_PAGE_SIZE,
): EventLogWindow<T> {
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  const start = (current - 1) * pageSize;
  return { rows: rows.slice(start, start + pageSize), page: current, pageCount, total };
}
