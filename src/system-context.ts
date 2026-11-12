/**
 * 会话级「模型这一轮看到了什么系统消息」（additive `sessions.get.system_context`）的装配实现。
 *
 * ## 为什么需要它
 * 主旨：**让模型可以看到的内容，用户也一样应该看到**，只不过用各种方法去让其简化
 * （UX、可收缩）。`prompt.system_context` 事件（`execution-unit.ts`）把「基底 system
 * prompt + Self Card」原文落进会话事件日志；会话页据此渲染一张默认折叠的「模型上下文」卡。
 *
 * 但会话页的内容有两路来源：live 事件流（gateway 的**内存**环形缓冲回放）与
 * `sessions.get` 的落盘快照。事件不是 message（`messages` 里永远没有它），所以进程重启 /
 * 回放窗口淘汰之后，只有**从事件日志重新派生**才能把卡找回来 —— 本模块就是那条读路径。
 *
 * ## 取哪一个事件的哪几个字段
 * 只认 `prompt.system_context`（载荷形状见 core 的 `PromptSystemContextPayload`）：
 * `hash` / `system_prompt` / `self_card` / `model` / `message_count` / `tools_count` /
 * `estimated_tokens` / `context_max` / `run_id` / `at`。**只返回尾窗内最近一条**：
 *
 * - 粒度与失败卡（`sessions.get` 的最近一次 run 快照）对齐 —— 客户端拿到的就是
 *   「这个会话最近一轮模型看到了什么系统消息」；
 * - 代价（**已知限制，不是 bug**）：更早轮次的卡在刷新 / 进程重启之后不会回来。要恢复
 *   每一轮，得把尾窗里的全部匹配记录都透出，并由客户端按 run 落位；这一单不做。
 *
 * ## 读数成本
 * 尾窗回扫（`SessionEventLog.readTailMatches`）：首窗 64 KiB，命中即停；该会话尾部没有
 * 这类事件时按 64K→256K→1M→4M 扩窗，累计最多 ≈5.3 MiB 后返回「不知道」，**不回退全量
 * 扫盘**。调用方（`sessions.get`）按**尾水位**缓存（见 `packages/serve` 的
 * `systemContext` 端口契约）：水位不变时连 `lookup` 都不会被调到，只花一次 `stat`。
 *
 * @module vessel/system-context
 */

import { stat } from 'node:fs/promises';
import type { SessionEventRecord } from '../packages/core/src/index';
import type { SessionEventTailReader } from './context-usage';

/**
 * 线上形状（与 `packages/serve` 的 `SessionSystemContext` 一致）。
 *
 * **整字段缺省 = 没有可用数据**（会话没跑过 / 尾部没有该事件 / 日志被淘汰），
 * 不是空字符串、不是 0。`system_prompt` 与 `self_card` 至少有一个（只有 hash 的空壳
 * 没有展示价值，本模块直接当「没有数据」）。
 */
export interface SessionSystemContext {
  /** `system_prompt + self_card` 的稳定摘要（sha256 前 16 位）：客户端按它去重。 */
  hash: string;
  /** 基底 system prompt 原文（缺省 = 这一层没有基底 system）。 */
  system_prompt?: string;
  /** Self Card 原文（≤400 tokens；缺省 = 未注入 Self Card）。 */
  self_card?: string;
  model?: string;
  message_count?: number;
  tools_count?: number;
  estimated_tokens?: number;
  context_max?: number;
  /** 该事件的时刻（Unix ms）。 */
  at?: number;
  /** 该事件所属的 run：客户端可以据此把卡落回那一轮。 */
  run_id?: string;
}

/** 取值 + 失效判定用的两个入口（`sessions.get` 的 `systemContext` 端口）。 */
export interface SystemContextSource {
  /** 该会话最近一条系统消息；没有数据 = `undefined`。 */
  lookup(sessionId: string): Promise<SessionSystemContext | undefined>;
  /**
   * 事件日志**尾水位**（`大小:mtime`）；`undefined` = 没有日志文件。
   * 日志只追加 ⇒ 水位不变意味着「派生结果不可能变」，据此让调用方免掉重复读盘。
   */
  watermark(sessionId: string): Promise<string | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只认非空字符串；其它（缺失 / null / 空串 / 非字符串）一律当没有。 */
function textField(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 只认有限非负数字；其它（缺失 / null / NaN / 字符串）一律当没有。 */
function numberField(source: unknown, key: string): number | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 事件记录 → 线上形状（宽松解析）。
 *
 * 坏载荷（旧日志 / 第三方改写 / 缺 hash 或两段原文都空）返回 `undefined` —— 调用方按
 * 「没有数据」处理，客户端不画卡。不截断原文：原文就是模型看到的那一份，截断等于改事实
 * （渲染侧负责最大高度与滚动）。
 */
function systemContextOfRecord(record: SessionEventRecord): SessionSystemContext | undefined {
  if (record.type !== 'prompt.system_context') return undefined;
  const data = record.data;
  const hash = textField(data, 'hash');
  if (hash === undefined) return undefined;
  const systemPrompt = textField(data, 'system_prompt');
  const selfCard = textField(data, 'self_card');
  if (systemPrompt === undefined && selfCard === undefined) return undefined;
  const model = textField(data, 'model');
  const messageCount = numberField(data, 'message_count');
  const toolsCount = numberField(data, 'tools_count');
  const estimatedTokens = numberField(data, 'estimated_tokens');
  const contextMax = numberField(data, 'context_max');
  const at = typeof record.ts === 'number' && Number.isFinite(record.ts) ? record.ts : undefined;
  const runId =
    typeof record.run_id === 'string' && record.run_id.length > 0 ? record.run_id : undefined;
  return {
    hash,
    ...(systemPrompt !== undefined ? { system_prompt: systemPrompt } : {}),
    ...(selfCard !== undefined ? { self_card: selfCard } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(messageCount !== undefined ? { message_count: Math.floor(messageCount) } : {}),
    ...(toolsCount !== undefined ? { tools_count: Math.floor(toolsCount) } : {}),
    ...(estimatedTokens !== undefined ? { estimated_tokens: Math.floor(estimatedTokens) } : {}),
    ...(contextMax !== undefined ? { context_max: Math.floor(contextMax) } : {}),
    ...(at !== undefined ? { at } : {}),
    ...(runId !== undefined ? { run_id: runId } : {}),
  };
}

/**
 * 尾窗里最多看这么多个候选记录。8 足够覆盖「同一会话里连发过几条」的情形，而每多一条
 * 只是多解析一行 JSON（不多读一个字节：窗口由 `readTailMatches` 按字节预算决定）。
 */
const TAIL_MATCH_LIMIT = 8;

export interface SystemContextSourceOptions {
  /** 事件日志（装配层传 tenant 的 `SessionEventLog`）。 */
  tail: SessionEventTailReader;
  /** 该会话的 `events.ndjson` 路径（装配层用 core 的 `sessionEventsFilePath` 拼）。 */
  eventsFile(sessionId: string): string;
}

/**
 * 构造 `sessions.get.system_context` 的取值面。
 *
 * `lookup` 返回 `undefined` 的三种情况都表示「不知道」，调用方与客户端都按「没有卡」处理：
 * 会话没有事件日志 / 尾窗回扫字节预算内没有 `prompt.system_context` / 命中记录的载荷
 * 不成形（旧日志）。这三种都不猜、不补默认值。
 */
export function createSystemContextSource(
  options: SystemContextSourceOptions,
): SystemContextSource {
  const { tail, eventsFile } = options;
  return {
    async lookup(sessionId: string): Promise<SessionSystemContext | undefined> {
      const { records } = await tail.readTailMatches(sessionId, ['prompt.system_context'], {
        limit: TAIL_MATCH_LIMIT,
      });
      // `records` 已按**新 → 旧**排序（文件顺序，日志只追加）。取第一条可解析的：
      // 尾部最新那条载荷坏了（半行 / 旧格式）时退到下一条，而不是整块变成「没有数据」。
      for (const record of records) {
        const context = systemContextOfRecord(record);
        if (context !== undefined) return context;
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
