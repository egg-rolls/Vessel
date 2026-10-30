/**
 * 缓存指标的展示派生量（CONTRACT-0.29 §2.2）。
 *
 * 纯函数，无 React、无 i18n：Observe 面板只用它把快照里的两个计数变成比率，
 * RPC 探针也直接调它验证口径。**比率不进 wire**——快照里只有计数。
 *
 * 两个口径（§2.2）：
 *  - 输入占比 `cache_read_tokens / prompt_tokens`（成本代理，跨 provider 可比）
 *  - 前缀健康度 `cache_read_tokens / (cache_read_tokens + cache_creation_tokens)`
 *
 * 分母为 0 或分子缺失 → `undefined`（不可用），**绝不是 0**。
 */
import { formatTokenCount } from '../../format';
import type { MetricsSnapshot } from '../../gateway/types';

/** 面板要显示的缓存派生量 */
export interface CacheMetricsView {
  /** 有任一缓存计数 = 该批事件带缓存数据；false 时面板必须显示「不可用」 */
  available: boolean;
  /** 缓存读取累计（`undefined` = provider 未报告） */
  cacheRead?: number;
  /** 缓存写入累计（`undefined` = provider 未报告，例如 DeepSeek 写免费） */
  cacheCreation?: number;
  /** 输入占比：`cache_read / prompt_tokens`；分子或分母缺失 → undefined */
  inputShare?: number;
  /**
   * 前缀健康度：`cache_read / (cache_read + cache_creation)`。
   *
   * **任一侧缺失 → undefined**：写侧未知时把这个商算成 1 会画出假 100%
   * （契约 §1.2 禁止用 0 表示「不支持缓存」）。
   */
  prefixHealth?: number;
}

function nonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 比率；分母 <= 0 或分子缺失 → undefined */
function ratio(numerator: number | undefined, denominator: number): number | undefined {
  if (numerator === undefined) return undefined;
  if (!Number.isFinite(denominator) || denominator <= 0) return undefined;
  return numerator / denominator;
}

/**
 * 从一个 `MetricsSnapshot.llm` 派生两个口径。
 *
 * 注意分母是 `prompt_tokens`（0.29 B2 之后它已含缓存），**不是** `total_tokens`，
 * 也不是 `prompt − cache_read`——用后者会让命中率恒等于或接近 100%。
 */
export function deriveCacheMetrics(
  llm: Pick<
    MetricsSnapshot['llm'],
    'prompt_tokens' | 'cache_read_tokens' | 'cache_creation_tokens'
  >,
): CacheMetricsView {
  const cacheRead = nonNegative(llm.cache_read_tokens);
  const cacheCreation = nonNegative(llm.cache_creation_tokens);
  const available = cacheRead !== undefined || cacheCreation !== undefined;

  // 读侧未知时两个比率都无从谈起：`prompt_tokens` 不会因为读未知而变小，
  // 拿 0 当分子会把「没有数据」渲染成 0%。
  const inputShare = ratio(cacheRead, llm.prompt_tokens);

  // 写侧未知 → 前缀健康度**不可计算**（§2.2 的分母是 read + write）。
  //
  // 这里不能把缺失的写侧按 0 补齐：那会让分母退化成 read，商恒等于 1，
  // 面板画出一个**假的 100%**（OpenAI / DeepSeek 本来就没有写字段）。
  // 「写侧未知」与「写侧确定为 0」是两种语义，必须给出不同结果。
  const prefixHealth =
    cacheRead === undefined || cacheCreation === undefined
      ? undefined
      : ratio(cacheRead, cacheRead + cacheCreation);

  return {
    available,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheCreation !== undefined ? { cacheCreation } : {}),
    ...(inputShare !== undefined ? { inputShare } : {}),
    ...(prefixHealth !== undefined ? { prefixHealth } : {}),
  };
}

/**
 * 比率 → 百分比文案。保留一位小数，去掉无意义的 `.0`。
 *
 * `undefined` 返回 `undefined`（调用方回退到「不可用」文案），**不返回 `'0%'`**。
 */
export function formatPercent(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  const percent = value * 100;
  const rounded = percent >= 99.95 ? 100 : Math.round(percent * 10) / 10;
  return `${rounded.toFixed(1).replace(/\.0$/, '')}%`;
}

/** 缺失计数在 hint 里的占位符（不是 0，也不是空串） */
export const MISSING_COUNT_TEXT = '—';

function countText(value: number | undefined): string {
  return value === undefined ? MISSING_COUNT_TEXT : formatTokenCount(value);
}

/** 面板上两个 Stat 的最终文案 + hint 用的原始计数 */
export interface CacheStatTexts extends CacheMetricsView {
  /** 输入占比文案；`undefined` → 面板显示「不可用」，不得显示 0% */
  inputShareText?: string;
  /** 前缀健康度文案；`undefined` → 同上 */
  prefixHealthText?: string;
  /** hint 里读侧的文本；缺失 → `MISSING_COUNT_TEXT`（**不得是 0**） */
  cacheReadText: string;
  /** hint 里写侧的文本；缺失 → `MISSING_COUNT_TEXT`（**不得是 0**） */
  cacheCreationText: string;
  /** 本批的输入总量（hint 用；已含缓存） */
  promptTokens: number;
  /** 输入总量的展示文案 */
  promptTokensText: string;
}

/**
 * 决定面板显示什么。
 *
 * 把「显示哪个数」从 JSX 里抽出来，是为了让「无数据 → 不可用」这条契约
 * 可以被探针直接判定，而不是靠读 JSX 猜。计数文案也在这里生成：
 * 只在 JSX 里做的话，一个 `?? 0` 就能把「provider 未上报」画成 0。
 */
export function cacheStatTexts(
  llm: Pick<
    MetricsSnapshot['llm'],
    'prompt_tokens' | 'cache_read_tokens' | 'cache_creation_tokens'
  >,
): CacheStatTexts {
  const view = deriveCacheMetrics(llm);
  const inputShareText = formatPercent(view.inputShare);
  const prefixHealthText = formatPercent(view.prefixHealth);
  return {
    ...view,
    ...(inputShareText !== undefined ? { inputShareText } : {}),
    ...(prefixHealthText !== undefined ? { prefixHealthText } : {}),
    cacheReadText: countText(view.cacheRead),
    cacheCreationText: countText(view.cacheCreation),
    promptTokens: llm.prompt_tokens,
    promptTokensText: countText(llm.prompt_tokens),
  };
}
