/**
 * 会话级上下文用量（additive `sessions.get.context_usage`）的装配实现。
 *
 * ## 为什么需要它
 * 用量此前只有一份：**身体级 + 内存**（serve 的 `agents-registry.contextUsages`，
 * 由 live 事件 ingest 填充）。进程重启 / rotate / 换 body 之后它就空了，历史会话
 * 永远没有环 —— 而「上下文用了多少」跟 body 无关，是**会话**属性。这里把它改成
 * 「按会话、从事件日志派生」，`sessions.get` 透出，刷新 / 重连 / 重启都能恢复。
 *
 * ## 取哪一个事件的哪个字段
 * 类型 → 字段的映射（与 live 注册表 `agents-registry.ingestContext` 同一套口径）：
 *
 * | 事件 | 字段 | 含义 |
 * |---|---|---|
 * | `context.pressure` | `used`（+ `max`） | ≥90% 水位的真实读数，与 live 注册表同源 |
 * | `context.changed` | `token_count` | 同上（live 注册表的另一来源） |
 * | `llm.request` | `estimated_tokens` | **实际生效的那条**（见下） |
 * | `llm.response` | `usage.prompt_tokens` | provider 报的真实 prompt 大小，最后兜底 |
 *
 * 选择规则：**取文件里最新那条带可用数字的**（新 → 旧逐条试），不做「类型优先级」跳跃。
 * 为什么不用固定的类型优先级：`context.pressure` 只在 ≥90% 水位发，压缩把水位降下来
 * 之后它**不会重发** —— 一条更老的 pressure（例如 900K）会比它之后的
 * `llm.request.estimated_tokens`（压缩后的 200K）大得多，按类型硬挑会把过期的高水位
 * 当成现值。新 → 旧是唯一单调可靠的顺序；`source` 告诉你最后用了哪个字段。
 *
 * 为什么 `context.pressure` / `context.changed` 在真实数据里几乎永远不命中：
 * `context.changed` **本来就不落盘**（`packages/core/src/runtime/run-journal.ts` 的
 * `NON_PERSISTED_EVENT_TYPES`，ADR-098 C1：派生快照，落盘等于同一事实两份），
 * `context.pressure` 只在 ≥90% 水位才发。落盘上稳定存在的是后两条：
 *
 * - `estimated_tokens`：`execution-unit.ts` 的 `persistData` 里存的**就是**
 *   `execution.workingContext.tokenCount`（同一份增量缓存），与
 *   `context.changed.token_count` **是同一个数**，不是 provider 报的 token 数；
 * - `usage.prompt_tokens`：provider 报的真实 prompt 大小（含 system / tools / 缓存
 *   命中），比本地估算略大几个 %，所以只作兜底。
 *
 * 命中的来源写进 `context_usage.source`（`pressure` / `changed` / `estimated` /
 * `request` / `prompt`），以后自查「这个数字是谁给的」不用再猜。
 *
 * ## `max` 从哪来（不是伪造，是随事件落盘的上下文窗口真值）
 * 事件优先，配置只做兜底（三级，见 {@link resolveContextWindow}）：
 * 1. 命中事件里的 `max`（`context.pressure` 的**真值**；≥90% 水位才发，多数会话没有）；
 * 2. `llm.request.data.context_max` —— **本模块的主力**：`workingContext.maxTokens`
 *    随事件落盘，历史会话因此自足（不再回推「当时的配置值」，将来按 agent / 模型
 *    配不同窗口也不会串）；
 * 3. 装配层注入的上下文窗口（`config.context.maxTokens`，缺省走 `DEFAULT_CONFIG`，
 *    不在本模块复刻常量）—— **只为旧日志兼容**：那些事件没有 `context_max`，
 *    行为与本轮之前完全一致；
 * 4. 都拿不到 → 不给 `max`（客户端不画比例）。绝不为「让环好看」编一个数。
 *
 * 窗口上限取自第 2 档时 `source` 记成 `request`（`used` 与 `max` 同源于那条
 * `llm.request`），一眼能看出「这个窗口不是回推配置来的」；旧日志仍是
 * `estimated` + 第 3 档，两者 `max` 数值相同（同一份 `config.context.maxTokens`）。
 * 不回填旧数据：`context_max` 只在会写它的新日志里存在。
 *
 * ## 读数成本
 * 尾窗回扫（`SessionEventLog.readTailMatches`）：首窗 64 KiB，命中即停；一次 miss
 * （该会话根本没有用量事件）按 64K→256K→1M→4M 扩窗，累计最多 ≈5.3 MiB 后返回
 * 「不知道」，**不回退全量扫盘**。调用方（`sessions.get`）按**尾水位**缓存，见
 * `packages/serve` 的 `contextUsage` 端口契约；本模块只额外提供
 * {@link ContextUsageSource.watermark}。
 *
 * @module vessel/context-usage
 */

import { stat } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../packages/config/src/index';
import type { SessionEventRecord } from '../packages/core/src/index';

/**
 * 事件日志的**只读尾窗面**（`SessionEventLog.readTailMatches` 的结构子集）+
 * 尾水位来源。用结构类型而不是 import 具体类：装配层原样传 `SessionEventLog`，
 * 测试也可以传一个假的。
 */
export interface SessionEventTailReader {
  readTailMatches(
    sessionId: string,
    types: readonly string[],
    opts?: { limit?: number; maxBytes?: number },
  ): Promise<{ records: SessionEventRecord[] }>;
}

/** 线上形状（与 `packages/serve` 的 `SessionContextUsage` 一致）。 */
export interface SessionContextUsage {
  used: number;
  max?: number;
  at?: number;
  /**
   * 这个 `used` 是谁给的：自查 / 排障用，UI 不消费。
   *
   * `request` = `used` 与 `max` 同源于那条 `llm.request` 的落盘元信息
   * （`estimated_tokens` + `context_max`），即「窗口上限是事件给的真值，不是回推配置」。
   * 其余档位只描述 `used`：`pressure` / `changed` / `estimated` / `prompt`。
   */
  source?: 'pressure' | 'changed' | 'estimated' | 'prompt' | 'request';
}

/**
 * `max`（上下文窗口上限）的来源档位：
 * - `pressure`：命中 `context.pressure.max`（事件里的真值）；
 * - `request`：命中 `llm.request.data.context_max`（随事件落盘的真值，历史会话主力）；
 * - `config`：装配层注入的 `config.context.maxTokens`（**只做旧日志兜底**）。
 */
export type ContextUsageMaxSource = 'pressure' | 'request' | 'config';

/** 取值 + 失效判定用的两个入口（`sessions.get` 的 `contextUsage` 端口）。 */
export interface ContextUsageSource {
  /** 该会话用量（读尾窗）；没有数据 = `undefined`。 */
  lookup(sessionId: string): Promise<SessionContextUsage | undefined>;
  /**
   * 事件日志**尾水位**（`大小:mtime`）；`undefined` = 没有日志文件。
   * 日志只追加 ⇒ 水位不变意味着「派生结果不可能变」，据此让调用方免掉重复读盘。
   */
  watermark(sessionId: string): Promise<string | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只认有限非负数字；其它（缺失 / null / NaN / 字符串）一律当没有。 */
function numberField(source: unknown, key: string): number | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 事件类型 → 「从这条事件里取哪个字段」。
 *
 * `tier` = 该字段与 live 注册表数值的等价程度：`1` = 本地估算口径（与 live 的
 * `context.changed.token_count` 同一个数 / 同一套来源），`2` = provider 报的
 * `prompt_tokens`（含 system / tools / 缓存，只作最后兜底）。
 */
const SOURCES: readonly {
  type: string;
  source: NonNullable<SessionContextUsage['source']>;
  tier: 1 | 2;
  read(data: unknown): number | undefined;
}[] = [
  {
    type: 'context.pressure',
    source: 'pressure',
    tier: 1,
    read: (data) => numberField(data, 'used'),
  },
  {
    type: 'context.changed',
    source: 'changed',
    tier: 1,
    read: (data) => numberField(data, 'token_count'),
  },
  {
    type: 'llm.request',
    // `used` 来自 `estimated_tokens`；若同一条事件还带了 `context_max`（窗口上限随事件
    // 落盘），`source` 会覆写成 `request`（见 `resolveContextWindow` / lookup 的收口）。
    source: 'estimated',
    tier: 1,
    read: (data) => numberField(data, 'estimated_tokens'),
  },
  {
    type: 'llm.response',
    source: 'prompt',
    tier: 2,
    read: (data) => numberField(isRecord(data) ? data.usage : undefined, 'prompt_tokens'),
  },
];

/**
 * 窗口上限（`max`）的三级取值：事件真值优先，配置只兜底。
 *
 * 顺序（见模块头「`max` 从哪来」）：
 * 1. 命中事件自身的 `max`（`context.pressure`）—— 与 live 注册表同源的真值；
 * 2. `llm.request.data.context_max` —— 尾窗里**最新**一条带该字段的请求事件
 *    （通常就是命中事件本身；下一档的存在让「`used` 来自 `llm.response`，窗口仍然
 *    有真值」这种情况也能拿到窗口，而不是退回配置）；
 * 3. `fallbackWindowTokens` = 装配层注入的 `config.context.maxTokens`（旧日志兼容）。
 *
 * 都不成立 → `undefined`（客户端不画比例），不猜、不补 0。
 */
function resolveContextWindow(args: {
  hit: { record: SessionEventRecord; source: { type: string } };
  candidates: readonly { record: SessionEventRecord }[];
  fallbackWindowTokens: number | undefined;
}): { max: number; from: ContextUsageMaxSource; sameRecord: boolean } | undefined {
  const { hit, candidates, fallbackWindowTokens } = args;

  // 1. 命中 `context.pressure`：事件里的真实 max 最权威。
  if (hit.source.type === 'context.pressure') {
    const observedMax = numberField(hit.record.data, 'max');
    if (observedMax !== undefined && observedMax > 0) {
      return { max: Math.floor(observedMax), from: 'pressure', sameRecord: true };
    }
  }

  // 2. `llm.request.data.context_max`：先看命中事件，再按新 → 旧扫尾窗里的其它请求。
  //    `candidates` 已按新 → 旧排序（与 `used` 的取值顺序同一份 records）。
  const requestMaxOf = (record: SessionEventRecord): number | undefined => {
    if (record.type !== 'llm.request') return undefined;
    const value = numberField(record.data, 'context_max');
    return value !== undefined && value > 0 ? Math.floor(value) : undefined;
  };
  const fromHit = requestMaxOf(hit.record);
  if (fromHit !== undefined) return { max: fromHit, from: 'request', sameRecord: true };
  for (const candidate of candidates) {
    if (candidate.record === hit.record) continue;
    const value = requestMaxOf(candidate.record);
    if (value !== undefined) return { max: value, from: 'request', sameRecord: false };
  }

  // 3. 旧日志兜底：装配层注入的上下文窗口（同一个 `config.context.maxTokens`）。
  if (fallbackWindowTokens !== undefined) {
    return { max: fallbackWindowTokens, from: 'config', sameRecord: false };
  }
  return undefined;
}

/**
 * 尾窗里最多看这么多个候选事件。
 *
 * 取 64 而不是个位数：同一个 64 KiB 尾窗里常常同时躺着  与
 * （两者字节数差一个量级），条数上限太小会先被 response 占满、
 * 看不到同一次调用的 request，白白退到 provider 报的 。
 * 多解析几十行是纯 CPU、不多读一个字节。
 */
const TAIL_MATCH_LIMIT = 64;

export interface ContextUsageSourceOptions {
  /** 事件日志（装配层传 tenant 的 `SessionEventLog`）。 */
  tail: SessionEventTailReader;
  /** 该会话的 `events.ndjson` 路径（装配层用 core 的 `sessionEventsFilePath` 拼）。 */
  eventsFile(sessionId: string): string;
  /**
   * 上下文窗口 = `config.context.maxTokens`（与 `workingContext.maxTokens` 同源）。
   * 缺省（未配置）时用 `DEFAULT_CONFIG.context.maxTokens`，与 runtime 同一份默认值。
   */
  contextWindowTokens?: number;
}

/** `config.context.maxTokens` 缺省值：与 runtime / `DEFAULT_CONFIG` 同一份。 */
const DEFAULT_CONTEXT_WINDOW_TOKENS = DEFAULT_CONFIG.context?.maxTokens;

/**
 * 构造 `sessions.get.context_usage` 的取值面。
 *
 * `lookup` 返回 `undefined` 的三种情况都表示「不知道」，调用方与客户端都按
 * 「不显示环」处理：会话没有事件日志 / 尾窗回扫字节上限内没有用量事件 /
 * 命中事件的字段不成形。
 */
export function createContextUsageSource(options: ContextUsageSourceOptions): ContextUsageSource {
  const { tail, eventsFile } = options;
  const windowTokens =
    typeof options.contextWindowTokens === 'number' &&
    Number.isFinite(options.contextWindowTokens) &&
    options.contextWindowTokens > 0
      ? Math.floor(options.contextWindowTokens)
      : typeof DEFAULT_CONTEXT_WINDOW_TOKENS === 'number' && DEFAULT_CONTEXT_WINDOW_TOKENS > 0
        ? Math.floor(DEFAULT_CONTEXT_WINDOW_TOKENS)
        : undefined;

  return {
    async lookup(sessionId: string): Promise<SessionContextUsage | undefined> {
      const { records } = await tail.readTailMatches(
        sessionId,
        SOURCES.map((source) => source.type),
        { limit: TAIL_MATCH_LIMIT },
      );
      if (records.length === 0) return undefined;
      // `records` 已按**新 → 旧**排序。先给 tier 1（本地估算口径，与 live 同一个数）
      // 一次机会，再退到 tier 2（provider 报的 prompt_tokens）。
      const candidates = records.flatMap((record) => {
        const source = SOURCES.find((entry) => entry.type === record.type);
        return source === undefined ? [] : [{ record, source }];
      });
      // 为什么不按「类型优先级」跨新旧硬挑：`context.pressure` 只在 ≥90% 水位发，压缩把
      // 水位降下来之后它不会重发 —— 一条更老的 pressure（例如 900K）会比它之后的
      // `llm.request.estimated_tokens`（压缩后的 200K）大得多，按类型硬挑会把过期的高
      // 水位当成现值。所以**同一 tier 内按新 → 旧**才是唯一单调可靠的顺序。
      const ordered = [
        ...candidates.filter((entry) => entry.source.tier === 1),
        ...candidates.filter((entry) => entry.source.tier === 2),
      ];
      for (const { record, source } of ordered) {
        const used = source.read(record.data);
        if (used === undefined) continue;
        // 窗口上限：事件真值（pressure.max → llm.request.context_max）优先，
        // 配置值只给旧日志兜底。`source` 记 `request` 表示「used 与 max 同源于这条
        // llm.request」，方便自查这个窗口是不是回推配置来的。
        const window = resolveContextWindow({
          hit: { record, source },
          candidates,
          fallbackWindowTokens: windowTokens,
        });
        const reportedSource: NonNullable<SessionContextUsage['source']> =
          window?.sameRecord === true && source.type === 'llm.request' ? 'request' : source.source;
        return {
          used: Math.floor(used),
          ...(window !== undefined ? { max: window.max } : {}),
          ...(typeof record.ts === 'number' && Number.isFinite(record.ts) ? { at: record.ts } : {}),
          source: reportedSource,
        };
      }
      return undefined;
    },

    async watermark(sessionId: string): Promise<string | undefined> {
      try {
        const info = await stat(eventsFile(sessionId));
        // 大小 + mtime 一起看：只追加的日志上 size 变化最可靠，mtime 兜住
        // 「同长度改写」（重写 / 换写者）这种极端情况。
        return `${info.size}:${Math.floor(info.mtimeMs)}`;
      } catch {
        return undefined;
      }
    },
  };
}
