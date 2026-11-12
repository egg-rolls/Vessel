/**
 * Usage plugin copy. English is the fallback; `?lang=zh-CN` (or `zh`) selects
 * the Chinese table. Strings live here, not in `@vessel-agent/plugin-ui`.
 */

export type Lang = 'en' | 'zh-CN';

type Vars = Record<string, string | number>;

const EN = {
  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'common.refresh': 'Refresh',
  'common.apply': 'Apply',
  'common.loadMore': 'Load more',
  'common.loadError': 'Could not load this view',
  'common.loadMoreError': 'Could not load more logs',
  'common.status.ok': 'ok',
  'common.status.failed': 'failed',

  'range.label': 'Time range',
  'range.1': 'Today',
  'range.7': '7 days',
  'range.30': '30 days',
  'range.90': '90 days',
  'range.0': 'All time',
  'range.custom': 'Custom range',
  'range.from': 'From',
  'range.to': 'To',
  'range.apply': 'Apply range',
  'range.clear': 'Back to presets',
  'range.invalid': 'Pick a start before the end.',

  'usage.title': 'Usage',
  'usage.description': 'Token usage, cache hits and cost.',
  'usage.toolbar': 'Usage controls',
  'usage.requests': 'Requests',
  'usage.promptTokens': 'Prompt tokens',
  'usage.completionTokens': 'Completion tokens',
  'usage.cacheRead': 'Cache read',
  'usage.inputShare': 'Input share',
  'usage.prefixHealth': 'Prefix health',
  'usage.cost': 'Cost',
  'usage.failedRuns': '{n} failed run(s)',
  'usage.promptHint': 'Includes cache counters',
  'usage.cacheNotReported': 'Not reported by provider',
  'usage.cacheHint': 'Read from the prompt cache',
  'usage.inputShareHint': 'Cache read / prompt tokens',
  'usage.prefixHealthHint': 'Cache read / (read + write)',
  'usage.costNoPrice': 'No configured price for these models',
  'usage.costPartial': '{n} unpriced request(s); total covers priced models',
  'usage.costHint': 'USD, from configured prices',
  'usage.byDay': 'By day',
  'usage.byModel': 'By model',
  'usage.empty.title': 'No usage data yet',
  'usage.empty.description':
    'Run a request through Vessel. Usage appears here once the event log has records in the selected range.',
  'usage.th.day': 'Day',
  'usage.th.requests': 'Requests',
  'usage.th.prompt': 'Prompt',
  'usage.th.completion': 'Completion',
  'usage.th.cacheRead': 'Cache read',
  'usage.th.failed': 'Failed',
  'usage.th.unpriced': 'Unpriced',
  'usage.th.cost': 'Cost',

  'ratio.noRequests': 'No requests in range',
  'ratio.noCacheFields': 'Provider did not report cache',
  'ratio.zeroDenominator': 'No cache activity in range',
  'ratio.promptNotInclusive': 'Cache counters exceed prompt tokens',
  'ratio.writeNotReported': 'Cache writes were not reported',

  'logs.title': 'Logs',
  'logs.description': 'Per-request usage and latency, newest first.',
  'logs.toolbar': 'Log filters',
  'logs.session': 'Session',
  'logs.model': 'Model',
  'logs.status': 'Status',
  'logs.sessionPlaceholder': 'Session id',
  'logs.modelPlaceholder': 'Model',
  'logs.allStatuses': 'All statuses',
  'logs.optionOk': 'OK',
  'logs.optionFailed': 'Failed',
  'logs.th.time': 'Time',
  'logs.th.status': 'Status',
  'logs.th.model': 'Model',
  'logs.th.session': 'Session',
  'logs.th.prompt': 'Prompt',
  'logs.th.completion': 'Completion',
  'logs.th.cacheRead': 'Cache read',
  'logs.th.duration': 'Duration',
  'logs.th.cost': 'Cost',
  'logs.empty.title': 'No request logs yet',
  'logs.empty.filtered': 'No matching requests',
  'logs.empty.description': 'Logs are read from the persisted tenant event files.',
  'logs.state.range': 'Range: {range}',
  'logs.state.custom': 'Range: {from} to {to}',
  'logs.state.loaded': '{n} loaded',
  'logs.state.more': 'more available',
  'logs.state.end': 'no more rows',
  'logs.state.conditions': 'Filters: {conditions}',
  'logs.truncated.files':
    'Read cap reached: only the newest {files} of {total} run files in this range were counted. Older runs in the same range are missing, so this is a partial count, not the total.',
  'logs.truncated.partial':
    'Partial read: {files} run file(s) in this range were only counted partially (their oldest lines were dropped), so those runs may be missing requests.',

  'leaderboard.th.model': 'Model',
  'leaderboard.th.requests': 'Requests',
  'leaderboard.th.tokens': 'Tokens',
  'leaderboard.th.cacheRead': 'Cache read',
  'leaderboard.th.cost': 'Cost',
  'leaderboard.empty.title': 'No model usage yet',
  'leaderboard.empty.description':
    'Run a request through Vessel. Models appear here once usage records exist.',
} as const;

export type MessageKey = keyof typeof EN;

const ZH: Record<MessageKey, string> = {
  'common.loading': '加载中…',
  'common.retry': '重试',
  'common.refresh': '刷新',
  'common.apply': '应用',
  'common.loadMore': '加载更多',
  'common.loadError': '无法加载此视图',
  'common.loadMoreError': '无法加载更多日志',
  'common.status.ok': '成功',
  'common.status.failed': '失败',

  'range.label': '时间范围',
  'range.1': '今天',
  'range.7': '7 天',
  'range.30': '30 天',
  'range.90': '90 天',
  'range.0': '全部时间',
  'range.custom': '自定义区间',
  'range.from': '开始',
  'range.to': '结束',
  'range.apply': '应用区间',
  'range.clear': '回到预设范围',
  'range.invalid': '开始时间必须早于结束时间。',

  'usage.title': '用量',
  'usage.description': 'Token 用量、缓存命中与成本概览。',
  'usage.toolbar': '用量控件',
  'usage.requests': '请求数',
  'usage.promptTokens': 'Prompt Token',
  'usage.completionTokens': 'Completion Token',
  'usage.cacheRead': '缓存读取',
  'usage.inputShare': '输入占比',
  'usage.prefixHealth': '前缀健康度',
  'usage.cost': '成本',
  'usage.failedRuns': '{n} 次运行失败',
  'usage.promptHint': '包含缓存计数',
  'usage.cacheNotReported': '提供商未上报',
  'usage.cacheHint': '从 prompt 缓存读取',
  'usage.inputShareHint': '缓存读取 / prompt Token',
  'usage.prefixHealthHint': '缓存读取 / (读取 + 写入)',
  'usage.costNoPrice': '这些模型未配置价格',
  'usage.costPartial': '{n} 次请求未计价；合计仅含已定价模型',
  'usage.costHint': '美元，按已配置价格计算',
  'usage.byDay': '按天',
  'usage.byModel': '按模型',
  'usage.empty.title': '暂无用量数据',
  'usage.empty.description':
    '在 Vessel 中发起一次请求。事件日志有所选范围内的记录后，用量会显示在这里。',
  'usage.th.day': '日期',
  'usage.th.requests': '请求数',
  'usage.th.prompt': 'Prompt',
  'usage.th.completion': 'Completion',
  'usage.th.cacheRead': '缓存读取',
  'usage.th.failed': '失败',
  'usage.th.unpriced': '未计价',
  'usage.th.cost': '成本',

  'ratio.noRequests': '范围内没有请求',
  'ratio.noCacheFields': '提供商未上报缓存',
  'ratio.zeroDenominator': '范围内没有缓存活动',
  'ratio.promptNotInclusive': '缓存计数超过 prompt Token',
  'ratio.writeNotReported': '未上报缓存写入',

  'logs.title': '日志',
  'logs.description': '按时间查看每次请求的用量与延迟。',
  'logs.toolbar': '日志筛选',
  'logs.session': '会话',
  'logs.model': '模型',
  'logs.status': '状态',
  'logs.sessionPlaceholder': '会话 ID',
  'logs.modelPlaceholder': '模型',
  'logs.allStatuses': '全部状态',
  'logs.optionOk': '成功',
  'logs.optionFailed': '失败',
  'logs.th.time': '时间',
  'logs.th.status': '状态',
  'logs.th.model': '模型',
  'logs.th.session': '会话',
  'logs.th.prompt': 'Prompt',
  'logs.th.completion': 'Completion',
  'logs.th.cacheRead': '缓存读取',
  'logs.th.duration': '耗时',
  'logs.th.cost': '成本',
  'logs.empty.title': '暂无请求日志',
  'logs.empty.filtered': '没有匹配的请求',
  'logs.empty.description': '日志来自已持久化的租户事件文件。',
  'logs.state.range': '范围：{range}',
  'logs.state.custom': '范围：{from} 至 {to}',
  'logs.state.loaded': '已加载 {n} 条',
  'logs.state.more': '还有更多',
  'logs.state.end': '已到底',
  'logs.state.conditions': '筛选：{conditions}',
  'logs.truncated.files':
    '已触及读取上限：该范围内只统计了最新的 {files}/{total} 个运行文件，同一范围内更早的运行没有被计入 —— 这是真实截断后的部分合计，不是总量。',
  'logs.truncated.partial':
    '部分读取：该范围内有 {files} 个运行文件只统计了尾部（更早的行被丢弃），这些运行可能缺少请求记录。',

  'leaderboard.th.model': '模型',
  'leaderboard.th.requests': '请求数',
  'leaderboard.th.tokens': 'Token',
  'leaderboard.th.cacheRead': '缓存读取',
  'leaderboard.th.cost': '成本',
  'leaderboard.empty.title': '暂无模型用量',
  'leaderboard.empty.description': '在 Vessel 中发起一次请求。有用量记录后模型会显示在这里。',
};

export function normalizeLang(raw: string | undefined): Lang {
  return raw?.trim().toLowerCase().startsWith('zh') === true ? 'zh-CN' : 'en';
}

function interpolate(template: string, vars?: Vars): string {
  if (vars === undefined) return template;
  let text = template;
  for (const [name, value] of Object.entries(vars)) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

export type Translator = (key: MessageKey, vars?: Vars) => string;

/** Translate `key` for `lang`; falls back to English, then to the key. */
export function translator(lang: string | undefined): Translator {
  const table = I18N[normalizeLang(lang)];
  return (key, vars) => interpolate(table[key] ?? EN[key] ?? key, vars);
}

export const I18N: Record<Lang, Record<MessageKey, string>> = {
  en: EN,
  'zh-CN': ZH,
};
