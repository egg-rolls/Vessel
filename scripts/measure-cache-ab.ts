#!/usr/bin/env bun
/**
 * measure-cache-ab.ts — placeholder（占位，0.52 V1「段内冻结集合」）vs passthrough（不占位）
 * 的一笔成本账。只读本机真实数据（sessions / runs / events / usage index），不联网、不调模型 API。
 *
 * ── 口径（每一项都标 实测 / 推算 / 假设）─────────────────────────────────────────
 *
 * 收益侧（每一次请求都吃到）：Δ = Σ(被清工具结果原文 token − 占位 token)。
 *   占位后这些 token 根本不上行，省下的是「本来会被缓存命中重复计费」的部分，按 实测 cache_read 价计：
 *   每个请求省 Δ × P_cache_read。
 *
 * 代价侧（每个「集合变动」的段起点只吃一次，不是每次请求）：
 *   占位集合在段起点算一次并冻结（execution-unit.ts freezeSegmentClearedToolResults），段内不再改，
 *   所以段内前缀稳定、缓存继续命中。真正的失效只发生在「本段比上段多清了新 id」的那个段的
 *   第一条请求上：失效长度 = 从最早被新改写的那条消息到请求末尾。
 *   「最早被新改写的」一定晚于上一段已清的位置 ⇒ 受保护前缀延伸到上一段边界，而不是整段历史。
 *     costMiss  = 失效后缀 × (P_input − P_cache_read)        （主口径，任务单口径）
 *     costWrite = 失效后缀 × (P_cache_write − P_cache_read)  （重写缓存口径，1.25x 溢价单列）
 *
 * 第三项代价（本机观测不到，只做敏感性）：模型看不到被清结果 ⇒ 可能要重取工具。
 *
 * ── 为什么可以用运行时估算值折算钱 ────────────────────────────────────────────
 * 运行时每追加一条消息就发 context.changed{message_count, token_count}，这是运行时自己的
 * token 估算；把它和供应商回传的 prompt_tokens 在同一 message_count 上对齐比较（--validate），
 * 实测 32,280 个请求：中位数 0.9986、p05 0.9616、p95 1.0067、95% 落在 ±5% 内 ⇒ 可以直接折算。
 * 因此本脚本的 Δ 与「失效位置之前的 token」优先取运行时注记（实测标注），
 * 取不到时才退回 estimateMessageTokens（推算），并在 src 列标明该段有多少条走了注记。
 *
 * 用法：
 *   bun scripts/measure-cache-ab.ts                      # 全量真实数据 + 分类型汇总
 *   bun scripts/measure-cache-ab.ts --validate            # 只做估算/实测标定校验
 *   bun scripts/measure-cache-ab.ts --session=<id 前缀> --all-runs
 *   bun scripts/measure-cache-ab.ts --pricing='{"input":0.27,"cache_read":0.027,"cache_write":0.3375}'
 *   bun scripts/measure-cache-ab.ts --recall=0.1 --json=out.json
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  planClearedToolResults,
  withClearedToolResults,
} from '../packages/core/src/context/context-manager.ts';

/** 每 1M token 单价（计价货币）。 */
interface PriceTable {
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
}

/**
 * 默认单价 = 仓库文档里唯一存在的价格表示例（docs/operations/CONFIG.md:230-234，
 * 模型 volcengine/deepseek-flash）。仓库不内置厂商价（src/usage-pricing.ts:59-64 说明
 * 价格来自用户配置），所以这份默认值只能当 **假设**：真机请用 --pricing 换成你的账单。
 */
const DEFAULT_PRICE: PriceTable = { input: 0.27, cache_read: 0.027, cache_write: 0.3375, output: 1.1 };
const DEFAULT_PRICE_SOURCE = '假设(docs/operations/CONFIG.md:230-234 示例价 volcengine/deepseek-flash)';

interface RequestUsage {
  /** 该请求发出的消息条数（实测，llm.request.message_count） */
  messageCount: number;
  prompt: number;
  cacheRead: number;
}

interface RunAnnotations {
  /** 运行时逐条追加时的注记：[{mc, tc}]，mc = 追加后的消息条数 */
  changed: { mc: number; tc: number }[];
  requests: RequestUsage[];
}

interface RawRun {
  session_id: string;
  session_type: string;
  run_index: number;
  run_id: string;
  seg_messages: number;
  seg_est: number;
  prompt_first: number;
  prompt_sum: number;
  cache_read_sum: number;
  requests: number;
  /** 段起点消息体积：运行时注记（实测标注）或 null */
  view_annotated: number | null;
  cleared_cum: number;
  new_count: number;
  delta_tokens: number;
  cleared_orig_tokens: number;
  annotated_sizes: number;
  invalidate_position: number | null;
  prefix_tokens: number;
  prefix_source: string;
}

interface RunRow extends RawRun {
  suffix_tokens: number;
  suffix_ratio: number | null;
  benefit: number;
  cost_miss: number;
  cost_write: number;
  net_miss: number;
  net_write: number;
  cost_recall: number;
  cost_recall_full: number;
  net_miss_after_recall: number;
  /** 价格无关临界值：p_read/p_in 高于它 placeholder 就亏 */
  break_even_ratio: number;
  observed_ratio: number | null;
  anomaly: boolean;
}

interface SessionAgg {
  session_id: string;
  session_type: string;
  runs: number;
  requests: number;
  delta_tokens: number;
  cleared_count: number;
  benefit: number;
  cost_miss: number;
  cost_write: number;
  net_miss: number;
  net_write: number;
  cost_recall: number;
  cost_recall_full: number;
  save_tokens: number;
  miss_tokens: number;
  suffix_ratio_weighted: number;
  tool_tokens: number;
  tool_family_tokens: Record<string, number>;
  messages: number;
  tool_calls: number;
  anomaly_runs: number;
  annotated_ratio: number;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function money(value: number): string {
  return value.toFixed(6);
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : (value * 100).toFixed(1) + '%';
}

function pad(value: string | number, width: number): string {
  const text = String(value);
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function padRight(value: string, width: number): string {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq < 0) args.set(arg.slice(2), 'true');
    else args.set(arg.slice(2, eq), arg.slice(eq + 1));
  }
  return args;
}

/** 工具名 → 家族，用来按「谁吃掉了工具结果 token」给会话分类。 */
function toolFamily(name: string): string {
  const n = name.toLowerCase();
  if (/^(agent|ask|inbox|send|subscribe|hire|close|team|member)/.test(n)) return 'team';
  if (/^(read|glob|grep|list|ls|view|notebook)/.test(n)) return 'read';
  if (/^(write|edit|patch|apply|multiedit|create)/.test(n)) return 'edit';
  if (/^(bash|shell|run|exec|command|task)/.test(n)) return 'shell';
  return 'other';
}

/**
 * 会话分类（判据全来自数据本身）：
 *  - 团队短任务类：工具结果 token 里 team 家族 ≥50%，或工具调用 ≤2 / 请求 ≤4（短会话）
 *  - 长文件阅读类：read 家族（read/glob/grep/list…）吃掉 ≥50% 工具结果 token
 *  - 多工具大输出类：shell 家族（bash 等）吃掉 ≥50%
 *  - 混合类：以上都不满足
 */
function classifySession(familyTokens: Record<string, number>, toolCalls: number, requests: number): string {
  const total = Object.values(familyTokens).reduce((a, b) => a + b, 0);
  if (total === 0 || toolCalls <= 2 || requests <= 4) return '团队短任务类';
  const share = (family: string): number => (familyTokens[family] ?? 0) / total;
  if (share('read') >= 0.5) return '长文件阅读类';
  if (share('shell') >= 0.5) return '多工具大输出类';
  if (share('team') >= 0.5) return '团队短任务类';
  return '混合类';
}

function loadJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const NEWLINE = String.fromCharCode(10);

/**
 * 单个 run 的注记：context.changed 逐条 token 注记 + 逐请求 usage（都是实测）。
 */
function readRunAnnotations(dataDir: string, runId: string): RunAnnotations | null {
  const path = join(dataDir, 'events', runId + '.jsonl');
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const changed: { mc: number; tc: number }[] = [];
  const requests: RequestUsage[] = [];
  let pending: number | null = null;
  for (const raw of text.split(NEWLINE)) {
    if (raw.length === 0) continue;
    if (raw.indexOf('context.changed') < 0 && raw.indexOf('llm.') < 0) continue;
    let evt: any;
    try {
      evt = JSON.parse(raw);
    } catch {
      continue;
    }
    const type = evt?.type;
    if (type === 'context.changed') {
      const mc = evt.data?.message_count;
      const tc = evt.data?.token_count;
      if (typeof mc === 'number' && typeof tc === 'number') changed.push({ mc, tc });
    } else if (type === 'llm.request') {
      if (typeof evt.data?.message_count === 'number') pending = evt.data.message_count;
    } else if (type === 'llm.response') {
      const usage = evt.data?.usage ?? {};
      requests.push({
        messageCount: pending ?? 0,
        prompt: num(usage.prompt_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
      });
      pending = null;
    }
  }
  if (requests.length === 0) return null;
  return { changed, requests };
}

/**
 * 标定校验（实测）：运行时 token 估算（context.changed.token_count）与供应商回传的
 * prompt_tokens 在同一 message_count 上对齐比较 —— 决定「用估算值折算钱」是否成立。
 */
function validateEstimator(dataDir: string): void {
  const eventsDir = join(dataDir, 'events');
  if (!existsSync(eventsDir)) {
    console.error('events 目录不存在: ' + eventsDir);
    return;
  }
  const files = readdirSync(eventsDir).filter((file) => file.endsWith('.jsonl'));
  const ratios: number[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(eventsDir, file), 'utf8');
    } catch {
      continue;
    }
    const estimateByCount = new Map<number, number>();
    let pending: number | null = null;
    for (const raw of text.split(NEWLINE)) {
      if (raw.length === 0) continue;
      if (raw.indexOf('context.changed') < 0 && raw.indexOf('llm.') < 0) continue;
      let evt: any;
      try {
        evt = JSON.parse(raw);
      } catch {
        continue;
      }
      if (evt?.type === 'context.changed') {
        const mc = evt.data?.message_count;
        const tc = evt.data?.token_count;
        if (typeof mc === 'number' && typeof tc === 'number') estimateByCount.set(mc, tc);
      } else if (evt?.type === 'llm.request') {
        if (typeof evt.data?.message_count === 'number') pending = evt.data.message_count;
      } else if (evt?.type === 'llm.response') {
        if (pending === null) continue;
        const prompt = num(evt.data?.usage?.prompt_tokens);
        const est = estimateByCount.get(pending);
        if (prompt > 0 && est && est > 0) ratios.push(prompt / est);
        pending = null;
      }
    }
  }
  ratios.sort((a, b) => a - b);
  const q = (p: number): number => ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * p))];
  const within = ratios.filter((r) => r >= 0.95 && r <= 1.05).length;
  console.log('== 标定校验：运行时估算 token vs 供应商 prompt_tokens（同一 message_count 对齐）==');
  console.log('  事件文件数: ' + files.length + '，可比对请求数: ' + ratios.length);
  console.log('  比值 p05=' + q(0.05).toFixed(4) + ' p50=' + q(0.5).toFixed(4) + ' p95=' + q(0.95).toFixed(4));
  console.log('  ±5% 内占比: ' + ((within / Math.max(1, ratios.length)) * 100).toFixed(1) + '%');
  const median = q(0.5);
  console.log(
    '  判定: ' +
      (median >= 0.95 && median <= 1.05 ? '通过 —— 运行时估算可直接折算成计费 token' : '不通过 —— 必须用供应商值'),
  );
}

function analyzeSession(
  dataDir: string,
  sessionId: string,
  messages: any[],
  runList: { runId: string; createdAt: number }[],
  maxTokens: number,
): { raw: RawRun[]; agg: SessionAgg } | null {
  const anns = new Map<string, RunAnnotations | null>();
  for (const item of runList) anns.set(item.runId, readRunAnnotations(dataDir, item.runId));

  // 会话级注记表：cum[mc] = 运行时的「前 mc 条消息」token 估算；
  // delta[mc] = 第 mc 条消息被追加时运行时的增量估算。
  // 同一 mc 取最早出现的注记（离插入时刻最近）。
  const cum = new Map<number, number>();
  const delta = new Map<number, number>();
  for (const item of runList) {
    const ann = anns.get(item.runId);
    if (!ann) continue;
    let prev: number | null = null;
    for (const point of ann.changed) {
      if (!cum.has(point.mc)) cum.set(point.mc, point.tc);
      if (prev !== null && !delta.has(point.mc)) delta.set(point.mc, Math.max(0, point.tc - prev));
      prev = point.tc;
    }
  }

  // 会话特征（实测）：工具结果 token 按「发起它的那次调用」的家族归属
  const familyById = new Map<string, string>();
  for (const message of messages) {
    for (const call of message?.tool_calls ?? []) {
      if (typeof call?.id === 'string') {
        familyById.set(call.id, toolFamily(String(call?.function?.name ?? '')));
      }
    }
  }
  const familyTokens: Record<string, number> = {};
  let toolCalls = 0;
  let toolTokens = 0;
  for (const message of messages) {
    if (message?.role === 'tool') {
      const tokens = estimateMessageTokens(message);
      toolTokens += tokens;
      const family = familyById.get(String(message?.tool_call_id ?? '')) ?? 'other';
      familyTokens[family] = (familyTokens[family] ?? 0) + tokens;
    }
    toolCalls += (message?.tool_calls ?? []).length;
  }

  const raw: RawRun[] = [];
  let prevCleared: string[] = [];

  for (let r = 0; r < runList.length; r += 1) {
    const runId = runList[r].runId;
    const ann = anns.get(runId);
    if (!ann || ann.requests.length === 0) continue;
    const first = ann.requests[0];
    // 段起点 = 第一条请求发出的那批消息（实测 message_count，比时间戳边界更准）
    const boundary = first.messageCount > 0 ? Math.min(first.messageCount, messages.length) : 0;
    const segStart = messages.slice(0, boundary) as any[];
    const segEst = estimateMessagesTokens(segStart);
    const viewAnnotated = cum.get(boundary) ?? null;

    const clearedNow = planClearedToolResults(segStart, maxTokens);
    const prevSet = new Set(prevCleared);
    const newIds = clearedNow.filter((id) => !prevSet.has(id));

    const projected = withClearedToolResults(segStart, clearedNow);
    let deltaTokens = 0;
    let clearedOrigTokens = 0;
    let annotatedSizes = 0;
    const indexById = new Map<string, number>();
    for (let i = 0; i < segStart.length; i += 1) {
      const message = segStart[i];
      if (message?.role !== 'tool') continue;
      indexById.set(String(message?.tool_call_id ?? ''), i);
    }
    for (let i = 0; i < segStart.length; i += 1) {
      if (segStart[i] === projected[i]) continue;
      const placeholderTokens = estimateMessageTokens(projected[i]);
      const annotated = delta.get(i + 1);
      const sizeTokens = annotated === undefined ? estimateMessageTokens(segStart[i]) : annotated;
      if (annotated !== undefined) annotatedSizes += 1;
      clearedOrigTokens += sizeTokens;
      deltaTokens += Math.max(0, sizeTokens - placeholderTokens);
    }

    // 失效位置：最早被「本段新清」的那条工具结果（1-based 消息下标）
    let invalidatePosition: number | null = null;
    if (newIds.length > 0) {
      for (const id of newIds) {
        const index = indexById.get(id);
        if (index === undefined) continue;
        if (invalidatePosition === null || index + 1 < invalidatePosition) invalidatePosition = index + 1;
      }
    }

    let prefixTokens = 0;
    let prefixSource = 'n/a';
    if (invalidatePosition !== null) {
      const annotatedPrefix = cum.get(invalidatePosition - 1);
      if (annotatedPrefix !== undefined) {
        prefixTokens = annotatedPrefix;
        prefixSource = 'annot';
      } else {
        // 注记缺失：用该请求的实测 prompt 与本段估算的比例回推（推算）
        const fallbackScale = segEst > 0 ? first.prompt / segEst : 1;
        prefixTokens = estimateMessagesTokens(segStart.slice(0, invalidatePosition - 1)) * fallbackScale;
        prefixSource = 'est';
      }
    }

    raw.push({
      session_id: sessionId,
      session_type: '',
      run_index: r + 1,
      run_id: runId,
      seg_messages: segStart.length,
      seg_est: Math.round(segEst),
      prompt_first: first.prompt,
      prompt_sum: ann.requests.reduce((sum, item) => sum + item.prompt, 0),
      cache_read_sum: ann.requests.reduce((sum, item) => sum + item.cacheRead, 0),
      requests: ann.requests.length,
      view_annotated: viewAnnotated,
      cleared_cum: clearedNow.length,
      new_count: newIds.length,
      delta_tokens: Math.round(deltaTokens),
      cleared_orig_tokens: Math.round(clearedOrigTokens),
      annotated_sizes: annotatedSizes,
      invalidate_position: invalidatePosition,
      prefix_tokens: Math.round(prefixTokens),
      prefix_source: prefixSource,
    });
    prevCleared = clearedNow;
  }

  if (raw.length === 0) return null;

  const totalRequests = raw.reduce((sum, row) => sum + row.requests, 0);
  const sessionType = classifySession(familyTokens, toolCalls, totalRequests);
  for (const row of raw) row.session_type = sessionType;
  const annotatedFields = raw.reduce((sum, row) => sum + row.annotated_sizes, 0);
  const clearedFields = raw.reduce((sum, row) => sum + row.cleared_cum, 0);
  const agg: SessionAgg = {
    session_id: sessionId,
    session_type: sessionType,
    runs: raw.length,
    requests: totalRequests,
    delta_tokens: 0,
    cleared_count: 0,
    benefit: 0,
    cost_miss: 0,
    cost_write: 0,
    net_miss: 0,
    net_write: 0,
    cost_recall: 0,
    cost_recall_full: 0,
    save_tokens: 0,
    miss_tokens: 0,
    suffix_ratio_weighted: 0,
    tool_tokens: toolTokens,
    tool_family_tokens: familyTokens,
    messages: messages.length,
    tool_calls: toolCalls,
    anomaly_runs: 0,
    annotated_ratio: clearedFields > 0 ? annotatedFields / clearedFields : 1,
  };
  return { raw, agg };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.has('help')) {
    console.log(readFileSync(join(import.meta.dir, 'measure-cache-ab.ts'), 'utf8').split('*/')[0]);
    return;
  }
  const dataDir = args.get('data-dir') ?? 'C:/Users/Lirui/.vessel/data';
  if (args.has('validate')) {
    validateEstimator(dataDir);
    return;
  }
  const maxTokens = Number(args.get('max-tokens') ?? 1000000);
  const recallRate = Number(args.get('recall') ?? 0);
  const sessionFilter = args.get('session') ?? null;
  const showAllRuns = args.has('all-runs');
  const jsonOut = args.get('json') ?? null;
  const top = Number(args.get('top') ?? 15);
  // 反事实开关：如果占位集合不是段内冻结、而是每条请求都重算（集合就可能在请求之间变），
  // 那么每次请求都要吃一次失效后缀 —— 用来看「冻结不变式」本身值多少钱。
  const perRequestInvalidation = args.has('per-request-invalidation');
  const price: PriceTable = args.has('pricing')
    ? { ...DEFAULT_PRICE, ...JSON.parse(args.get('pricing') as string) }
    : DEFAULT_PRICE;

  const sessionsDir = join(dataDir, 'sessions');
  const runsDir = join(dataDir, 'runs');
  if (!existsSync(sessionsDir)) {
    console.error('session 目录不存在: ' + sessionsDir);
    process.exitCode = 2;
    return;
  }

  const runsBySession = new Map<string, { runId: string; createdAt: number }[]>();
  for (const file of readdirSync(runsDir)) {
    if (!file.endsWith('.json')) continue;
    const record = loadJson(join(runsDir, file));
    if (!record?.run_id) continue;
    const sessionId = String(record.session_id ?? '');
    const bucket = runsBySession.get(sessionId) ?? [];
    bucket.push({ runId: record.run_id as string, createdAt: num(record.created_at) });
    runsBySession.set(sessionId, bucket);
  }
  for (const bucket of runsBySession.values()) bucket.sort((a, b) => a.createdAt - b.createdAt);

  const rows: RunRow[] = [];
  const sessions: SessionAgg[] = [];
  let sessionsWithoutRuns = 0;
  let runsWithoutEvents = 0;
  let sessionsWithPlaceholder = 0;
  let sessionsWithAutoCompact = 0;

  for (const file of readdirSync(sessionsDir)) {
    if (!file.endsWith('.json')) continue;
    const record = loadJson(join(sessionsDir, file));
    const sessionId = String(record?.session_id ?? file.replace(/\.json$/, ''));
    if (sessionFilter && !sessionId.startsWith(sessionFilter)) continue;
    const messages: any[] = Array.isArray(record?.messages) ? record.messages : [];
    if (messages.length === 0) continue;

    // 快照保真度闸门：落盘历史里已经有占位文本 / 已被自动压缩的会话，
    // 「不占位」基线在磁盘上已不可逆（原文只在 events 的 tool.call.completed 里），
    // 这类会话不进主账，只计数。
    let hasPlaceholder = false;
    let hasAutoCompact = false;
    for (const message of messages) {
      const content = message?.content;
      if (typeof content !== 'string') continue;
      if (content.startsWith('[cleared ')) hasPlaceholder = true;
      if (content.indexOf('Auto Compact') >= 0) hasAutoCompact = true;
    }
    if (hasPlaceholder || hasAutoCompact) {
      if (hasPlaceholder) sessionsWithPlaceholder += 1;
      else sessionsWithAutoCompact += 1;
      continue;
    }

    const runList = (runsBySession.get(sessionId) ?? []).filter((item) => item.createdAt > 0);
    if (runList.length === 0) {
      sessionsWithoutRuns += 1;
      continue;
    }
    const result = analyzeSession(dataDir, sessionId, messages, runList, maxTokens);
    if (result === null) {
      runsWithoutEvents += runList.length;
      continue;
    }
    const { raw, agg } = result;
    sessions.push(agg);

    for (const item of raw) {
      const suffixTokens =
        item.invalidate_position === null
          ? 0
          : Math.max(0, Math.round(item.prompt_first - item.prefix_tokens));
      const suffixRatio =
        item.invalidate_position === null ? null : Math.min(1, suffixTokens / Math.max(1, item.prompt_first));
      const benefit = (item.delta_tokens / 1e6) * price.cache_read * item.requests;
      const missMultiplier = perRequestInvalidation ? item.requests : 1;
      const costMiss = ((suffixTokens * missMultiplier) / 1e6) * Math.max(0, price.input - price.cache_read);
      const costWrite = ((suffixTokens * missMultiplier) / 1e6) * Math.max(0, price.cache_write - price.cache_read);
      // 重取敏感性（假设）：被清的原始 token 里 recallRate 比例要重新读一遍工具。
      // 口径 A（下界）：只算一次重取的上行（按 input 价）。
      // 口径 B（更接近现实）：重取回来的结果还会留在本段后面的请求里，按 cache_read 再算一遍。
      const recallTokens = recallRate * item.cleared_orig_tokens;
      const costRecall = (recallTokens / 1e6) * price.input;
      const costRecallFull =
        costRecall + ((recallTokens * Math.max(0, item.requests - 1)) / 1e6) * price.cache_read;
      const saveTokens = item.delta_tokens * item.requests;
      const breakEven = saveTokens + suffixTokens > 0 ? suffixTokens / (saveTokens + suffixTokens) : 1;
      // 注记与实际 prompt 的一致性自检：只在高信息量的段上判定（段起点 ≥20 条消息），
      // 偏差 >35% 视为「供应商侧静默截断」类异常，不进合计。
      const observedRatio =
        item.view_annotated && item.view_annotated > 0 ? item.prompt_first / item.view_annotated : null;
      const anomaly =
        observedRatio !== null && item.seg_messages >= 20 && (observedRatio < 0.75 || observedRatio > 1.35);

      const row: RunRow = {
        ...item,
        suffix_tokens: suffixTokens,
        suffix_ratio: suffixRatio,
        benefit,
        cost_miss: costMiss,
        cost_write: costWrite,
        net_miss: benefit - costMiss,
        net_write: benefit - costWrite,
        cost_recall: costRecall,
        cost_recall_full: costRecallFull,
        net_miss_after_recall: benefit - costMiss - costRecall,
        break_even_ratio: breakEven,
        observed_ratio: observedRatio,
        anomaly,
      };
      rows.push(row);

      if (anomaly) {
        agg.anomaly_runs += 1;
        continue;
      }

      agg.delta_tokens += row.delta_tokens;
      agg.cleared_count = Math.max(agg.cleared_count, item.cleared_cum);
      agg.benefit += benefit;
      agg.cost_miss += costMiss;
      agg.cost_write += costWrite;
      agg.net_miss += row.net_miss;
      agg.net_write += row.net_write;
      agg.cost_recall += costRecall;
      agg.cost_recall_full += costRecallFull;
      agg.save_tokens += saveTokens;
      agg.miss_tokens += suffixTokens;
      if (suffixTokens > 0) agg.suffix_ratio_weighted += (suffixRatio ?? 0) * suffixTokens;
    }
  }

  for (const agg of sessions) {
    agg.suffix_ratio_weighted = agg.miss_tokens > 0 ? agg.suffix_ratio_weighted / agg.miss_tokens : 0;
  }

  // ---------------- 输出 ----------------
  const out: string[] = [];
  const push = (line: string): void => {
    out.push(line);
  };

  push('数据源: ' + dataDir + '（sessions/*.json + runs/*.json + events/<run_id>.jsonl）');
  push('单价: ' + DEFAULT_PRICE_SOURCE);
  push('      input=' + price.input + ' cache_read=' + price.cache_read + ' cache_write=' + price.cache_write + '（每 1M token）');
  push('保留窗口: keep = min(10 条, maxTokens×5%)，maxTokens=' + maxTokens + '（context-manager.ts retainedToolResultCount）');
  push('段 = run；段起点 = 冻结占位集合的时刻（execution-unit.ts freezeSegmentClearedToolResults）');
  push('segment 体积取运行时 context.changed 注记（实测标注），Δ 的每条原文优先取追加时的运行时增量');
  push('重取敏感性 recallRate=' + recallRate + '（假设项，本机观测不到）');
  push('失效次数口径: ' + (perRequestInvalidation ? '反事实——每条请求都失效（占位集合不冻结）' : '段起点一次（0.53 V1 冻结集合）'));
  push('');

  const header =
    padRight('session', 9) +
    padRight('type', 6) +
    pad('run', 4) +
    pad('msgs', 5) +
    pad('viewTok', 8) +
    pad('pFirst', 8) +
    pad('hit%', 7) +
    pad('reqs', 5) +
    pad('clr#', 5) +
    pad('Δtok', 8) +
    pad('pos', 5) +
    pad('sfxTok', 8) +
    pad('sfx%', 6) +
    pad('benefit', 10) +
    pad('costMiss', 10) +
    pad('netMiss', 10) +
    pad('netWrite', 10) +
    pad('r*', 7);
  push(header);
  push('-'.repeat(header.length));

  const shown = showAllRuns ? rows : rows.filter((row) => row.suffix_tokens > 0 || row.delta_tokens > 0);
  for (const row of shown) {
    const hit = row.prompt_sum > 0 ? row.cache_read_sum / row.prompt_sum : null;
    push(
      padRight(row.session_id.slice(0, 8), 9) +
        padRight(row.session_type.slice(0, 2), 6) +
        pad(row.run_index, 4) +
        pad(row.seg_messages, 5) +
        pad(row.view_annotated ?? row.seg_est, 8) +
        pad(row.prompt_first, 8) +
        pad(pct(hit), 7) +
        pad(row.requests, 5) +
        pad(row.cleared_cum, 5) +
        pad(row.delta_tokens, 8) +
        pad(row.invalidate_position === null ? '-' : row.invalidate_position, 5) +
        pad(row.suffix_tokens, 8) +
        pad(pct(row.suffix_ratio), 6) +
        pad(money(row.benefit), 10) +
        pad(money(row.cost_miss), 10) +
        pad(money(row.net_miss), 10) +
        pad(money(row.net_write), 10) +
        pad(pct(row.break_even_ratio), 7) +
        (row.anomaly ? ' !!' : ''),
    );
  }

  const totalize = (list: SessionAgg[]) => {
    const t = {
      sessions: list.length,
      runs: 0,
      requests: 0,
      delta: 0,
      benefit: 0,
      costMiss: 0,
      costWrite: 0,
      netMiss: 0,
      netWrite: 0,
      costRecall: 0,
      costRecallFull: 0,
      saveTokens: 0,
      missTokens: 0,
      cleared: 0,
      anomalies: 0,
    };
    for (const s of list) {
      t.runs += s.runs;
      t.requests += s.requests;
      t.delta += s.delta_tokens;
      t.benefit += s.benefit;
      t.costMiss += s.cost_miss;
      t.costWrite += s.cost_write;
      t.netMiss += s.net_miss;
      t.netWrite += s.net_write;
      t.costRecall += s.cost_recall;
      t.costRecallFull += s.cost_recall_full;
      t.saveTokens += s.save_tokens;
      t.missTokens += s.miss_tokens;
      t.cleared += s.cleared_count;
      t.anomalies += s.anomaly_runs;
    }
    return t;
  };

  const classHeader =
    padRight('type', 14) +
    pad('sess', 5) +
    pad('runs', 5) +
    pad('reqs', 6) +
    pad('Δtok累计', 13) +
    pad('节省tok', 13) +
    pad('失效tok', 12) +
    pad('sfx%', 7) +
    pad('benefit', 11) +
    pad('costMiss', 11) +
    pad('netMiss', 11) +
    pad('netWrite', 11) +
    pad('r*', 7);
  const types = ['长文件阅读类', '多工具大输出类', '团队短任务类', '混合类'];
  const classes: any[] = [];

  push('');
  push('== 按会话类型分组（净收益为正 = placeholder 更便宜）==');
  push(classHeader);
  push('-'.repeat(classHeader.length));
  for (const type of types) {
    const list = sessions.filter((s) => s.session_type === type);
    if (list.length === 0) continue;
    const t = totalize(list);
    const avgSuffix =
      t.missTokens > 0
        ? list.reduce((sum, s) => sum + s.suffix_ratio_weighted * s.miss_tokens, 0) / t.missTokens
        : 0;
    const rStar = t.saveTokens + t.missTokens > 0 ? t.missTokens / (t.saveTokens + t.missTokens) : 1;
    classes.push({ type, ...t, avg_suffix_ratio: avgSuffix, break_even_ratio: rStar });
    push(
      padRight(type, 14) +
        pad(t.sessions, 5) +
        pad(t.runs, 5) +
        pad(t.requests, 6) +
        pad(Math.round(t.delta), 13) +
        pad(Math.round(t.saveTokens), 13) +
        pad(Math.round(t.missTokens), 12) +
        pad(pct(avgSuffix), 7) +
        pad(money(t.benefit), 11) +
        pad(money(t.costMiss), 11) +
        pad(money(t.netMiss), 11) +
        pad(money(t.netWrite), 11) +
        pad(pct(rStar), 7),
    );
  }
  const all = totalize(sessions);
  const allRStar = all.saveTokens + all.missTokens > 0 ? all.missTokens / (all.saveTokens + all.missTokens) : 1;
  push('-'.repeat(classHeader.length));
  push(
    padRight('合计', 14) +
      pad(all.sessions, 5) +
      pad(all.runs, 5) +
      pad(all.requests, 6) +
      pad(Math.round(all.delta), 13) +
      pad(Math.round(all.saveTokens), 13) +
      pad(Math.round(all.missTokens), 12) +
      pad(pct(sessions.reduce((sum, s) => sum + s.suffix_ratio_weighted * s.miss_tokens, 0) / Math.max(1, all.missTokens)), 7) +
      pad(money(all.benefit), 11) +
      pad(money(all.costMiss), 11) +
      pad(money(all.netMiss), 11) +
      pad(money(all.netWrite), 11) +
      pad(pct(allRStar), 7),
  );

  // 价格无关的判据（最稳的结论形状）
  push('');
  push('== 价格无关的判据（只数 token，不依赖单价）==');
  push('  节省 token（每个请求少上行、本来按 cache_read 计费的 token 累计）: ' + Math.round(all.saveTokens));
  push('  失效 token（每次集合变动一次性重算的 token 累计）          : ' + Math.round(all.missTokens));
  push('  临界比值 r* = 失效/(节省+失效) = ' + allRStar.toFixed(4) + '（p_read/p_in 低于它 placeholder 就赚）');
  for (const ratio of [0.05, 0.1, 0.2, 0.5]) {
    const net = ((all.saveTokens * ratio - all.missTokens * (1 - ratio)) / 1e6) * price.input;
    push('    p_read/p_in = ' + ratio.toFixed(2) + ' → 净收益 ' + money(net) + '（正 = placeholder 更便宜）');
  }

  push('');
  push('== 会话级明细（按 netMiss 排序）==');
  const sessHeader =
    padRight('session', 9) +
    padRight('type', 14) +
    pad('runs', 5) +
    pad('reqs', 6) +
    pad('Δtok', 10) +
    pad('sfx%', 7) +
    pad('netMiss', 11) +
    pad('netWrite', 11) +
    pad('注记%', 7) +
    pad('anom', 5);
  push(sessHeader);
  push('-'.repeat(sessHeader.length));
  const rank = [...sessions].sort((a, b) => b.net_miss - a.net_miss);
  const picks = rank.length <= top * 2 ? rank : [...rank.slice(0, top), ...rank.slice(-5)];
  for (const s of picks) {
    push(
      padRight(s.session_id.slice(0, 8), 9) +
        padRight(s.session_type, 14) +
        pad(s.runs, 5) +
        pad(s.requests, 6) +
        pad(s.delta_tokens, 10) +
        pad(pct(s.suffix_ratio_weighted), 7) +
        pad(money(s.net_miss), 11) +
        pad(money(s.net_write), 11) +
        pad(pct(s.annotated_ratio), 7) +
        pad(s.anomaly_runs, 5),
    );
  }

  push('');
  push('== 覆盖率与缺口 ==');
  push('- 进账会话数: ' + sessions.length);
  push('- 有会话但无 run 记录（跳过）: ' + sessionsWithoutRuns);
  push('- 快照已含占位文本 / 已被自动压缩（基线不可逆，跳过）: ' + sessionsWithPlaceholder + ' / ' + sessionsWithAutoCompact);
  push('- 有 run 但无 events 逐请求 usage（未进账的 run）: ' + runsWithoutEvents);
  const anomalyRuns = rows.filter((row) => row.anomaly).length;
  push('- 进账段数: ' + rows.length + '（其中 ' + anomalyRuns + ' 段判为异常并剔除：实测 prompt 与运行时注记差 >35%）');
  push('- 进账请求数: ' + all.requests);
  push('- 被清工具结果的 token 里走运行时注记的比例: ' + pct(sessions.reduce((s, x) => s + x.annotated_ratio * x.cleared_count, 0) / Math.max(1, sessions.reduce((s, x) => s + x.cleared_count, 0))));
  push('- 重取率 recallRate=' + recallRate + ' 时总重取成本（假设，口径 A 一次重取 / 口径 B 还跟着跑完本段）: ' + money(all.costRecall) + ' / ' + money(all.costRecallFull));
  push('- 净收益在扣掉重取成本后（A / B 口径）: ' + money(all.netMiss - all.costRecall) + ' / ' + money(all.netMiss - all.costRecallFull));

  const text = out.join('\n');
  console.log(text);

  if (jsonOut) {
    const payload = {
      generated_at: new Date().toISOString(),
      data_dir: dataDir,
      price,
      price_source: DEFAULT_PRICE_SOURCE,
      max_tokens: maxTokens,
      recall_rate: recallRate,
      totals: { ...all, break_even_ratio: allRStar },
      classes,
      sessions,
      runs: rows,
    };
    writeFileSync(jsonOut, JSON.stringify(payload, null, 1), 'utf8');
    console.log('');
    console.log('JSON → ' + jsonOut);
  }
}

main();

