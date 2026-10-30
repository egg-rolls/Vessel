/**
 * 会话级 prompt-cache 命中统计（0.29 B4）。
 * @module @vessel-agent/tui
 *
 * 口径来自 CONTRACT-0.29-cache-metrics.md §2：
 *
 * - 一条 `llm.response` = 一次请求，所有上报了缓存字段的请求**无条件**计入；
 * - **输入占比** = Σ cache_read / Σ prompt_tokens；
 * - **前缀健康度** = Σ cache_read / (Σ cache_read + Σ cache_creation)。
 *
 * 不区分 warmup：契约 §2.3 曾要求单列，但它依赖每请求谓词，聚合量上无法还原
 * （`SUM(write)` 丢了「写了几次」），已在 D5 裁决中删除。
 *
 * 两个比率的分母为 0、或 provider 根本不上报缓存字段时，指标是 **undefined**，
 * 展示层必须显示「不可用」而不是 0%（契约 §2.2 + BRIEF §3.3）。
 *
 * 数据源是**进程内事件历史**（`EventStream.getHistory()`），按 `data.session_id`
 * 限定当前会话。刻意不做「active run 的 usage」：REPL 在 run 进行中把一切非 `/exit`
 * 输入入队，slash 命令只在 idle 时执行，挂在 active-run usage 上的指标会恒为 `-`
 * （BRIEF §2）。同理 `run.completed.usage` 没有缓存字段（那是 B1/B3 的范围），
 * 缓存数只能从 `llm.response.usage` 取。
 *
 * 归一化（`prompt_tokens` 含缓存）只在 provider adapter 做（契约 §1）。本模块
 * 不做任何 provider 分支换算，也不把 read / write 与 prompt 相加（它们是子集）。
 */

import type { RunEvent } from '@vessel-agent/core';
import { t } from '../i18n/index.js';

/** 比率不可用的原因（展示为括号内的一句话，绝不渲染成 0%） */
export type CacheUnavailableReason =
  | 'no-requests'
  | 'no-cache-fields'
  | 'zero-denominator'
  /** `prompt_tokens` 比缓存计数还小 = 违反契约 §1（该值不含缓存） */
  | 'prompt-not-inclusive';

/**
 * 会话级缓存统计。
 *
 * 所有上报了缓存字段的请求**无条件**计入；不区分 warmup
 * （契约 §2.3 已删除——warmup 是每请求谓词，聚合量上无法还原）。
 */
export interface CacheStats {
  /** 会话内 `llm.response` 总条数 */
  requests: number;
  /** 其中上报了缓存字段的条数；`< requests` 说明部分响应不带缓存信息 */
  reported: number;
  promptTokens: number;
  readTokens: number;
  writeTokens: number;
  /** 输入占比 = read / prompt；分母为 0 时 undefined */
  inputShare?: number;
  /** 输入占比单独不可用的原因（前缀健康度仍可能可用） */
  inputShareReason?: CacheUnavailableReason;
  /** 前缀健康度 = read / (read + write)；分母为 0 时 undefined */
  prefixHealth?: number;
  /** 两个比率都不可用时的原因；undefined = 至少有比率可用 */
  unavailable?: CacheUnavailableReason;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 数值字段；兼容 camelCase（跨节点 / 序列化 payload） */
function readNumber(data: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readString(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * 折叠会话内的 `llm.response.usage` 为缓存统计。
 *
 * - 跳过带 `subagent.` 前缀的事件：成员 body 有自己的 session / run，不属于本会话；
 * - 给了 `sessionId` 时只认 `data.session_id` 命中的事件；事件缺 `session_id` 时
 *   无法判定归属，按本会话计入（旧日志兼容：`llm.response` 正常都带该字段）。
 */
export function readCacheStats(events: RunEvent[], sessionId?: string): CacheStats {
  let requests = 0;
  let reported = 0;
  let promptTokens = 0;
  let readTokens = 0;
  let writeTokens = 0;

  for (const event of events) {
    if (event.type.startsWith('subagent.')) continue;
    if (event.type !== 'llm.response') continue;
    if (!isRecord(event.data)) continue;
    const data = event.data;
    if (sessionId !== undefined) {
      const owner = readString(data, 'session_id', 'sessionId');
      if (owner !== undefined && owner !== sessionId) continue;
    }
    requests += 1;

    const usage = isRecord(data.usage) ? data.usage : undefined;
    if (usage === undefined) continue;
    const read = readNumber(usage, 'cache_read_input_tokens', 'cacheReadInputTokens');
    const write = readNumber(usage, 'cache_creation_input_tokens', 'cacheCreationInputTokens');
    // 两个字段都缺省 = provider 不支持缓存（契约 §1.2：缺省，不是 0）。
    if (read === undefined && write === undefined) continue;
    reported += 1;

    // 契约 §2.3 已删除：warmup 是每请求谓词，聚合量上无法还原，因此不区分。
    readTokens += read ?? 0;
    writeTokens += write ?? 0;
    promptTokens += readNumber(usage, 'prompt_tokens', 'promptTokens') ?? 0;
  }

  const base = { requests, reported, promptTokens, readTokens, writeTokens };
  if (requests === 0) return { ...base, unavailable: 'no-requests' };
  if (reported === 0) return { ...base, unavailable: 'no-cache-fields' };
  // provider 上报了字段但整会话没有任何缓存活动：此时 `read / prompt = 0%` 与
  // 「provider 不上报」在展示上无法区分，按 BRIEF §3.3 第 3 行（Σ(read+write) == 0）
  // 整块判为不可用，避免被读成「缓存已经猜到命中率是 0」。
  if (readTokens + writeTokens === 0) return { ...base, unavailable: 'zero-denominator' };

  const prefixHealth =
    readTokens + writeTokens > 0 ? readTokens / (readTokens + writeTokens) : undefined;
  // 契约 §1：`prompt_tokens` 必须含缓存读 / 写，所以 read 是其子集，占比 ≤ 100%。
  // 超过 100% 说明该 adapter 还没做 U1 归一化（`prompt_tokens` 仍是排他残差值）；
  // 此时渲染出来的百分比必然是假的，宁可说不可用也不给一个 >100% 的数。
  const promptNotInclusive = promptTokens < readTokens + writeTokens;
  const inputShare =
    !promptNotInclusive && promptTokens > 0 ? readTokens / promptTokens : undefined;
  const inputShareReason: CacheUnavailableReason | undefined =
    inputShare !== undefined
      ? undefined
      : promptNotInclusive
        ? 'prompt-not-inclusive'
        : 'zero-denominator';
  if (inputShare === undefined && prefixHealth === undefined) {
    return { ...base, unavailable: inputShareReason };
  }
  return {
    ...base,
    ...(inputShare !== undefined ? { inputShare } : { inputShareReason }),
    ...(prefixHealth !== undefined ? { prefixHealth } : {}),
  };
}

function groupNumber(value: number): string {
  return value.toLocaleString('en-US');
}

/** 比率文本：整数不带小数位（95% / 100%），其余保留一位（95.6%） */
export function formatCachePercent(value: number): string {
  const percent = value * 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/**
 * 纯函数：统计 -> 一行展示文本（不含 label）。
 *
 * 不可用时给出明确的「不可用（原因）」+ 原始计数：既不给 0%，也不隐藏证据。
 * 计数与两个比率同源，可人工复核。
 */
export function formatCacheSummary(stats: CacheStats): string {
  const params = {
    inputShare:
      stats.inputShare !== undefined
        ? formatCachePercent(stats.inputShare)
        : formatUnavailable(stats.inputShareReason ?? stats.unavailable),
    prefixHealth:
      stats.prefixHealth !== undefined
        ? formatCachePercent(stats.prefixHealth)
        : formatUnavailable(stats.unavailable),
    read: groupNumber(stats.readTokens),
    write: groupNumber(stats.writeTokens),
    prompt: groupNumber(stats.promptTokens),
    reported: String(stats.reported),
  };
  if (stats.unavailable !== undefined) {
    return t('cache.unavailable', { reason: t(`cache.reason.${stats.unavailable}`), ...params });
  }
  return t('cache.value', params);
}

/** 单个指标不可用：`不适用（原因）`；原因未知时只说不适用 */
function formatUnavailable(reason: CacheUnavailableReason | undefined): string {
  if (reason === undefined) return t('cache.notAvailable');
  return t('cache.notAvailableReason', { reason: t(`cache.reason.${reason}`) });
}

/** 纯函数：run 结束后归档的一条提示（两行：结论 / 原因与原始计数） */
export interface CacheNotice {
  text: string;
  detail?: string;
}

/**
 * 纯函数：run 结束后的自提示。第一行只放结论、第二行放原因与原始计数 ——
 * 窄终端截断第一行时，可复核的计数仍然完整（BRIEF §3.4）。
 *
 * 没有可展示的内容时返回 undefined：会话内还没有 `llm.response`，或 provider
 * 根本不上报缓存字段 —— 这两种情况每轮刷一条「不可用」只是噪声；`/status` 的
 * cache 行始终给出完整状态（含「provider 不上报」那句）。
 */
export function formatCacheNotice(stats: CacheStats): CacheNotice | undefined {
  if (stats.requests === 0 || stats.unavailable === 'no-cache-fields') return undefined;
  const detail =
    stats.reported === 0
      ? undefined
      : t('cache.noticeDetail', {
          read: groupNumber(stats.readTokens),
          write: groupNumber(stats.writeTokens),
          prompt: groupNumber(stats.promptTokens),
          reported: String(stats.reported),
        });
  return { text: noticeText(stats), ...(detail !== undefined ? { detail } : {}) };
}

function noticeText(stats: CacheStats): string {
  if (stats.unavailable !== undefined) {
    return t('cache.noticeUnavailable', {
      reason: t(`cache.reason.${stats.unavailable}`),
    });
  }
  return t('cache.notice', {
    inputShare:
      stats.inputShare !== undefined
        ? formatCachePercent(stats.inputShare)
        : formatUnavailable(stats.inputShareReason ?? stats.unavailable),
    prefixHealth:
      stats.prefixHealth !== undefined
        ? formatCachePercent(stats.prefixHealth)
        : formatUnavailable(stats.unavailable),
  });
}
