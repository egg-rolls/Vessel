/**
 * sessions.* 方法（list / get / search / delete / rename）。
 *
 * @module @vessel-agent/serve
 */

import { createHash } from 'node:crypto';
import {
  formatClearedToolResult,
  indexToolCalls,
  isClearedToolResult,
  type Message,
  type ProjectionMode,
  ProjectionPolicyError,
  projectedKeepCount,
  resolveProjection,
  resolveProjectionMode,
  type SessionState,
  type SessionStore,
} from '@vessel-agent/core';
import type {
  AgentControlLike,
  AgentCreateSeedLike,
  SessionActivateLikeInput,
  SessionCreateLikeInput,
  SessionRestartLikeInput,
} from '../../agent-control.js';
import {
  isTeamScopedPrincipal,
  RpcError,
  type RpcMethodContext,
  type RpcMethodDefinition,
} from '../../rpc.js';
import {
  MAX_SESSION_SEARCH_LIMIT,
  normalizeSearchQuery,
  parseSearchLimit,
  searchSessions,
} from '../../session-search.js';
import { mapTenantError } from '../../tenant.js';
import {
  type CappedMessage,
  capToolMessages,
  TOOL_EVENT_PAYLOAD_LIMIT,
} from '../../tool-events.js';
import { MethodError } from '../errors.js';
import {
  EMPTY_TIMELINE_HEADS,
  isLegacySessionUnsupported,
  legacySessionUnsupportedMessage,
  selectTimelinePage,
  type TimelineReadPort,
  type TimelineWireEvent,
} from '../timeline-protocol.js';
import { runInProgressReason, stringParam } from './common.js';
import {
  runStateSchema,
  sessionEventSchema,
  sessionInfoSchema,
  sessionSearchHitSchema,
} from './schemas.js';

/** run 记录的最小读取面（gateway 只需要按 run_id 取最近一条）。 */
export interface SessionRunLookup {
  load(runId: string): Promise<unknown>;
}

/**
 * 会话级上下文用量（`sessions.get.context_usage`，additive）。
 *
 * `used` = 该会话最近一次真实用量；`max` = 上下文窗口上限（优先取事件里随
 * `llm.request` 落盘的真值，旧日志才回退配置值）；`at` = 那条事件的 `ts`；
 * `source` = 这个数字是谁给的（自查用；`request` = `used`/`max` 同源于那条
 * `llm.request` 的落盘元信息）。
 * **整字段缺省 = 没有可用数据**，不写 0、不写 null。
 */
export interface SessionContextUsage {
  used: number;
  max?: number;
  at?: number;
  source?: 'pressure' | 'changed' | 'estimated' | 'prompt' | 'request';
}

/**
 * 会话级用量的注入口（装配层实现，见 `src/context-usage.ts`）。
 *
 * 两个方法分开是有意的：`watermark` 只是一次 `stat`，`lookup` 才是尾窗读盘。
 * 本模块据此按**尾水位失效**（日志只追加 ⇒ 水位不变时派生结果不可能变），
 * 不会出现「纯 TTL 到期就白读一遍」的浪费，也不会在 run 期间拿到过期值。
 */
export interface SessionContextUsagePort {
  lookup(sessionId: string): Promise<SessionContextUsage | undefined>;
  /** 事件日志尾水位（`大小:mtime`）；`undefined` = 没有日志文件。 */
  watermark(sessionId: string): Promise<string | undefined>;
}

/**
 * 请求组成快照（`sessions.composition`，q-context-composition，additive）。
 *
 * 一条 = 一次真实 LLM 请求的 `context.composition` 事件载荷：请求视图 token
 * 按成分分解（固定键集，见 core `context/composition.ts`），供上下文优化分析
 * 「窗口被什么占据」。`at` / `run_id` / `attempt` 定位是哪一次请求。
 */
export interface SessionCompositionSnapshot {
  /** 事件时刻（Unix ms）。 */
  at?: number;
  run_id?: string;
  /** 重试链里的第几次请求（1 起）。 */
  attempt?: number;
  model?: string;
  /** 请求视图 token 上界（成分之和）。 */
  total_tokens: number;
  /** 锚点校正后的现值（与 `context_usage.used` 同口径）。 */
  corrected_tokens?: number;
  context_max?: number;
  message_count: number;
  /** 成分表：键集固定（system_prompt / compaction_summary / user_history /
   * current_input / assistant / tool_results / tool_placeholders / notices /
   * images / tools / overhead），值 = {tokens, count, share}。 */
  components: Record<string, { tokens: number; count: number; share: number }>;
  /** 占位对应原文的 token 上界（落盘窗口里取）。 */
  cleared_original_tokens?: number;
  /** 占位相对原文省下的 token。 */
  cleared_saved_tokens?: number;
}

/**
 * 会话级组成快照的注入口（装配层实现，见 `src/session/context-composition.ts`）。
 *
 * 与 `SessionContextUsagePort` 同一范式（事件日志尾窗派生），但这是**显式
 * introspection RPC**（按需调用、低频），不做水位缓存：一次调用最多读一遍尾窗。
 * 缺省 = `sessions.composition` 返回 `not_supported`（旧装配行为不变）。
 */
export interface SessionCompositionPort {
  /** 最近 `limit` 条快照，**新 → 旧**；没有数据 = 空数组。 */
  lookup(sessionId: string, limit: number): Promise<SessionCompositionSnapshot[]>;
}

/** `sessions.composition.limit` 硬顶（一次introspection 最多回看 100 次请求）。 */
const MAX_COMPOSITION_SNAPSHOTS = 100;

/**
 * 会话级「模型这一轮看到了什么系统消息」（`sessions.get.system_context`，additive）。
 *
 * 载荷 = core 的 `prompt.system_context` 事件（`PromptSystemContextPayload`）里能展示的
 * 那几项：**模型真正看到的那份系统消息**（基底 system prompt + Self Card 原文）以及
 * 它对应哪一轮（`run_id` / `at`）。
 *
 * 主旨：让模型可以看到的内容，用户也一样应该看到（用 UX 简化，而不是藏起来）。
 * **整字段缺省 = 没有可用数据**；`system_prompt` / `self_card` 至少有一个。
 */
export interface SessionSystemContext {
  /** `system_prompt + self_card` 的稳定摘要（sha256 前 16 位）：客户端按它去重。 */
  hash: string;
  system_prompt?: string;
  self_card?: string;
  model?: string;
  message_count?: number;
  tools_count?: number;
  estimated_tokens?: number;
  context_max?: number;
  /** 那条事件的时刻（Unix ms）。 */
  at?: number;
  /** 那条事件所属的 run：客户端据此把卡落回那一轮。 */
  run_id?: string;
  /**
   * 「与上一份快照差在哪」（additive，0.52）：只列变了的项（`system_prompt: replaced` /
   * `model: A → B` / `tools: 12 → 14`）。**缺省 = 不知道**（首次快照 / 旧日志），
   * 客户端退回全量快照卡，不渲成「0 项变更」。
   */
  changed?: string[];
  /** 上一份快照的 hash（additive；缺省同上）。 */
  previous_hash?: string;
}

/**
 * 系统消息的注入口（装配层实现，见 `src/system-context.ts`）。
 *
 * 与 `SessionContextUsagePort` **同一范式**：`watermark` 只是一次 `stat`，`lookup` 才是尾窗
 * 读盘；本模块据此按**尾水位**失效，水位不变时连 `lookup` 都不会被调到。
 * 为什么不复用 `contextUsage` 端口：两个派生值来自不同类型的事件、失效面也不同（
 * `llm.request` 每个请求一条，`prompt.system_context` 每会话几条），混在一个方法里会让
 * 「没有数据」变成猜。
 */
export interface SessionSystemContextPort {
  lookup(sessionId: string): Promise<SessionSystemContext | undefined>;
  /** 事件日志尾水位（`大小:mtime`）；`undefined` = 没有日志文件。 */
  watermark(sessionId: string): Promise<string | undefined>;
}

/**
 * 一张图的投递事实（additive 0.56，`sessions.get.session.messages[i].image_delivery[j]`）。
 *
 * 形状与 `schemas.ts#imageDeliverySchema` 一一对应；三态语义见那里。
 * **wire-only 派生**：`Message.refs` 一个字节都不多（那是「禁止项 1」）。
 */
export interface ImageDeliveryView {
  /**
   * `sent` 已发送 / `dropped` 这一轮算过但没发 / `not_sent` 根本没进这条通路 /
   * `unknown` **没有记录**（派生不出来，不许猜——见 `SessionImageDeliveryPort`）。
   */
  status: 'sent' | 'dropped' | 'not_sent' | 'unknown';
  reason?: string;
  sha8?: string;
  tokens?: number;
  backend?: string;
  model?: string;
}

/**
 * 一次查询的结果：事实 + **覆盖度**（决定「缺席」该怎么解释）。
 *
 * `coverage: 'partial'` 是 0.56 P1 加的：长会话里 `image.sent` 落在尾窗之外时，老实现
 * 把「没扫到」说成「未发送」，而**显示错误比不显示更坏**。现在缺席只有在
 * `coverage: 'complete'`（从 seq 1 折到日志尾）时才算「从未发送」，否则只报「无记录」。
 */
export interface ImageDeliveryFacts {
  facts: ReadonlyMap<string, ImageDeliveryView>;
  coverage: 'complete' | 'partial';
}

/**
 * 会话级「每张图的投递事实」（0.56）：按 `sha8` 索引，由装配层从**事件日志**折叠
 * （`image.sent` / `context.image_dropped`）。
 *
 * 为什么按 sha8 而不是消息下标：压缩会重排下标、`sessions.get` 还要分页 —— 只有内容身份
 * （sha256 前 8 位）能跨这两件事对齐。同一张图在多轮里出现过，就以**最近一条事件**为准
 * （压缩删掉它的那条 `image_dropped` 晚于 `image.sent`，所以 chip 会从「已发送」变
 * 「已丢弃（压缩）」—— 这正是模型现在的真实视角）。
 */
export interface SessionImageDeliveryPort {
  lookup(sessionId: string): Promise<ImageDeliveryFacts | undefined>;
  /** 事件日志尾水位（`大小:mtime`）；`undefined` = 没有日志文件。 */
  watermark(sessionId: string): Promise<string | undefined>;
}

/**
 * 一条工具消息的「模型看到的是什么」投影（additive `sessions.get.session.messages[i].projection`，0.54）。
 *
 * 形状与取值域**照抄** `docs/specs/projection-card-spec.md` §1.7：
 * `mode` 用 ADR-104 §2.2 冻结的四模式闭集（`ProjectionMode`），不在这里自创枚举；
 * `placeholder_text` 是 core 渲染好的、**模型真正看到的那一字节**，UI 只展示、禁止自行拼装
 *（`formatClearedToolResult` 不幂等：对已是占位的正文再跑一遍会把行数算成 `1 lines`）。
 *
 * **wire-only 派生**：core 的 `SessionState` 一个字节都不动（本字段只活在出站视图里）。
 * **sparse**：没被投影的消息**不带**这个键 —— 与今天逐字节相同，老客户端忽略它也照旧工作。
 */
export interface ProjectionView {
  /** 取值域 = ADR-104 §2.2 的闭集（`externalize` 只占位、不可声明）。 */
  mode: ProjectionMode;
  /** 与 `messages[i].tool_call_id` 相同，便于批量卡按 id 汇总。 */
  tool_call_id: string;
  /** core 渲染好的占位文本（**逐字**：不 trim / 不补空格 / 不重排换行）。 */
  placeholder_text: string;
  /** `placeholder_text` 的稳定摘要（sha256 前 16 位，同 `system_context.hash` 口径）：客户端按它去重。 */
  placeholder_hash: string;
  /** 原始正文的 UTF-8 字节数；**拿不到就 null**（原文只在事件日志里时未知，不写 0）。 */
  original_bytes: number | null;
  /** 原始正文的行数（与 `formatClearedToolResult` 同一个切分口径）；同上，拿不到 null。 */
  original_lines: number | null;
  /**
   * - `inline`：`messages[i].content` 就是原文；
   * - `inline_truncated`：正文是原文的**前 8 KiB**（`truncated.content` 给裁断事实）；
   * - `readback`：正文已是占位，原文只剩事件日志（按 `readback` 句柄读）；
   * - `gone`：不可恢复。
   */
  original_available: 'inline' | 'inline_truncated' | 'readback' | 'gone';
  /**
   * 需要跨源读取时给句柄，UI 不做推断。
   *
   * `since_seq` 就是 `sessions.events` 的同名参数（**排他**游标：`> since_seq` 的事件）；
   * `0` = 从日志头按 `tool_call_id` 找，**不是**「没有这一段」。
   * `original_available:'readback'` 只表示「请求可得」，不保证一定读得回来：拿到空结果时
   * UI 按 `gone` 文案降级（服务端本轮不产出 `gone`）。
   */
  readback?:
    | { kind: 'events'; tool_call_id: string; since_seq: number }
    | { kind: 'file'; path: string; offset?: number; length?: number }
    | { kind: 'handle'; handle_id: string };
  /**
   * 冻结集合的来源事件 `seq`（审计锚点）。
   *
   * **缺省 = 不知道**：`sessions.get` 只读 `SessionState`（不扫事件日志），所以本次没有
   * 任何 seq 事实可给。这里**不写 0** —— 0 在事件日志里是「第一条事件」，会把「不知道」
   * 伪装成「从日志起点起就成立」。
   */
  since_event_seq?: number;
  /** ADR-104 D4 的声明 id（`SessionState.context_projection.declaration_id`）；没有声明 = null。 */
  declaration_id: string | null;
}

/**
 * 整会话的投影汇总（additive `sessions.get.session.projection_summary`，0.54）。
 *
 * **口径 = 整个会话当前态，不是当前分页窗口**：由同一趟两分支判定在 `all`（切片前）上累加，
 * 因此包含「正文已是占位、但 id 已不在段级冻结集合里」的历史条目（spec §1.3 陷阱 5）。
 * 别去扫事件日志凑这个数（那是另一个真相源，会与 `messages` 打架）。
 */
export interface ProjectionSummary {
  /** 被投影的条数（`mode` 之和）。 */
  total: number;
  /**
   * `Σ(original_bytes − placeholder 字节)`：**净值**，可以为负。
   *
   * 两个必须说清的边界：
   * - 只累加「原文体量已知」的条目（`inline` / `inline_truncated`）；`unknown_original_count > 0`
   *   时它是**下界**（未知不等于 0，不拿占位字节反推原文体量）；
   * - 不 clamp 到 0：原文比占位还短的小结果确实会让占位变大，按 0 记等于系统性高估。
   *   展示层若要显示「省了多少」自己 clamp（服务端只给真值）。
   */
  bytes_saved: number;
  /** 每个 mode 各有几条（闭集；没出现的 mode 不登记，不补 0）。 */
  modes: Partial<Record<ProjectionMode, number>>;
  /** `original_bytes === null` 的条数（= `bytes_saved` 少算了几条）。 */
  unknown_original_count: number;
}

/** 一趟两分支判定的结果：`all` 下标 → 投影（没有 = 没被投影）。 */
interface ProjectionScan {
  byIndex: Map<number, ProjectionView>;
  summary: ProjectionSummary;
}

/** 出站消息（`capToolMessages` 的裁断事实 + 投影 + 图片投递）。三个键都是 wire-only 派生。 */
export interface ProjectedMessage extends CappedMessage {
  projection?: ProjectionView;
  /**
   * 这条消息上每张图的投递事实（0.56；**sparse**，没有图就不出现）。
   *
   * 与 `content` 的 8 KiB 裁剪**无关**：它们是独立的小字段（几十字节），被裁的是正文。
   * 顺序与 `refs` 里的图片引用一一对应（前端可以直接按序渲染 chip）。
   */
  image_delivery?: ImageDeliveryView[];
}

const utf8 = new TextEncoder();

/** 字符串的 UTF-8 字节数（一次编码，不进入任何派生逻辑）。 */
function utf8ByteLength(text: string): number {
  return utf8.encode(text).length;
}

/**
 * 一条工具消息的占位文本摘要（sha256 前 16 位）：与 `prompt.system_context.hash`
 * （`execution-unit.ts:401`）同一个口径，客户端拿到就能按 hash 与实时卡去重。
 */
function projectionHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 在**落盘全量 messages（`all`）**上跑两分支判定（spec §1.7 约束 1、2）。
 *
 * 必须切片之前跑：`formatClearedToolResult` 要在消息全表里按 `tool_call_id` 找 owning
 * assistant 编译工具名与首参摘要，窗口把那条 assistant 切掉就会退化成
 * `[cleared -> exit 2, 4 lines]`（spec §1.4 陷阱 3）—— 在窗口上算是把那个 bug 搬到服务端。
 *
 * 两分支的理由（spec §1.3 陷阱 5）：`SessionState.cleared_tool_call_ids` 是**段级**的，
 * 会被覆盖写 / 归一成 undefined，所以「只看 id 集合」会漏报「正文早已是占位」的历史条目；
 * 反之「重算占位」不幂等（对占位正文再跑一遍 → `1 lines`）。因此：
 * - 分支 A（正文已是占位）：**原样搬**，绝不重算，不依赖任何 id 集合（正文自证）；
 * - 分支 B（正文还是原文 + id 在本段冻结集合里）：用 core 同一个函数现算。
 */
function scanProjections(all: readonly Message[], state: SessionState): ProjectionScan {
  const clearedIds = new Set(state.cleared_tool_call_ids ?? []);
  const declarationId = state.context_projection?.declaration_id ?? null;
  // 一次性建 tool_call 索引（懒建：没有分支 B 的条目就根本不建）。
  let toolCallIndex: ReturnType<typeof indexToolCalls> | undefined;
  const byIndex = new Map<number, ProjectionView>();
  const summary: ProjectionSummary = {
    total: 0,
    bytes_saved: 0,
    modes: {},
    unknown_original_count: 0,
  };

  for (let index = 0; index < all.length; index += 1) {
    const message = all[index];
    if (message === undefined || message.role !== 'tool') continue;
    const toolCallId = message.tool_call_id;
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) continue;
    // 旧数据里正文可能缺失/不是字符串：**不当成空串**去投影（那会凭空算出 `1 lines`）。
    if (typeof message.content !== 'string') continue;
    const content = message.content;

    let view: ProjectionView;
    if (isClearedToolResult(content)) {
      // 分支 A：正文已经是占位 ⇒ 它就是模型现在看到的那一字节。原样搬（逐字），不重算、
      // 不看 id 集合（段级集合可能已经空了）。原文只剩事件日志 ⇒ `readback`。
      view = {
        mode: 'placeholder',
        tool_call_id: toolCallId,
        placeholder_text: content,
        placeholder_hash: projectionHash(content),
        original_bytes: null,
        original_lines: null,
        original_available: 'readback',
        readback: { kind: 'events', tool_call_id: toolCallId, since_seq: 0 },
        declaration_id: declarationId,
      };
    } else if (clearedIds.has(toolCallId)) {
      // 分支 B：正文还是原文、id 在本段冻结集合里 ⇒ 用 core 的**同一个**函数现算。
      // 实参顺序照签名（`messages, toolCallId, originalContent`），原文用落盘完整正文
      // （不是 8 KiB 裁剪后的）—— 否则行数与 exit code 会算错。
      // 第四个参数是**预建的 tool_call 索引**（语义与函数内部的线性查找逐条一致）：
      // 否则每个已占位条目都要重扫一遍全部消息，`sessions.get` 一条消息的页会变成
      // O(已占位条数 × 消息条数)（1,047 条 / 413 个 id 实测 6.3 ms，长寿进程 ~60 ms）。
      if (toolCallIndex === undefined) toolCallIndex = indexToolCalls(all);
      const text = formatClearedToolResult(all, toolCallId, content, toolCallIndex);
      const originalBytes = utf8ByteLength(content);
      view = {
        mode: 'placeholder',
        tool_call_id: toolCallId,
        placeholder_text: text,
        placeholder_hash: projectionHash(text),
        original_bytes: originalBytes,
        original_lines: content.split('\n').length,
        // 与 `capToolMessages` 同一把尺子：严格大于上限才被裁（原文字节数 > 8 KiB）。
        original_available:
          originalBytes > TOOL_EVENT_PAYLOAD_LIMIT ? 'inline_truncated' : 'inline',
        declaration_id: declarationId,
      };
    } else {
      // mode:'passthrough' 的条目**不发 projection**（没被投射 = 与今天逐字节相同）。
      continue;
    }

    byIndex.set(index, view);
    summary.total += 1;
    summary.modes[view.mode] = (summary.modes[view.mode] ?? 0) + 1;
    if (view.original_bytes === null) {
      summary.unknown_original_count += 1;
    } else {
      // 净值累加（**不 clamp 到 0**）：原文比占位还短的小结果真的会让占位变大，
      // 把它按 0 记等于系统性高估节省量。聚合结果可以是负数。
      summary.bytes_saved += view.original_bytes - utf8ByteLength(view.placeholder_text);
    }
  }

  return { byIndex, summary };
}

/**
 * 把投影挂到**出站窗口**上（`window[i]` 对应 `all[offset + i]`）。
 *
 * 没有一条命中时返回原数组（零分配）—— 与今天逐字节相同。
 */
function attachProjections(
  window: readonly CappedMessage[],
  scan: ProjectionScan,
  offset: number,
): ProjectedMessage[] {
  if (scan.byIndex.size === 0) return window as ProjectedMessage[];
  let changed = false;
  const out: ProjectedMessage[] = window.map((message, index) => {
    const projection = scan.byIndex.get(offset + index);
    if (projection === undefined) return message;
    changed = true;
    return { ...message, projection };
  });
  return changed ? out : (window as ProjectedMessage[]);
}

/**
 * 把会话级**图片投递事实**挂到出站窗口上（0.56；与 `attachProjections` 同形态）。
 *
 * 规则：
 * - 只给「`refs` 里有 image」的消息挂（**sparse**：没图 = 与今天逐字节相同）；
 * - 每条图片引用按 `sha256` 前 8 位查：
 *   - 命中 ⇒ 用那条事实（`sent` / `dropped` / `not_sent`）；
 *   - 未命中且 `coverage: 'complete'`（整份日志都折过了）⇒ `not_sent / no_delivery_event`
 *     —— **这才是「没发过」的证据**；
 *   - 未命中且 `coverage: 'partial'` ⇒ `unknown / no_delivery_record`：只报「无记录」，
 *     **不猜**（老实现把「尾窗没扫到」说成「未发送」，长会话里那是假读数）；
 * - 没 `sha256` 的旧引用 = `not_sent / not_ingested`（它们从没进过 blob 池，确实没被内联）；
 * - 一条都没命中 ⇒ 返回原数组（零分配）。
 */
function attachImageDelivery(
  window: readonly ProjectedMessage[],
  known: ImageDeliveryFacts,
): ProjectedMessage[] {
  let changed = false;
  const out = window.map((message) => {
    const refs = message.refs;
    if (refs === undefined || refs.length === 0) return message;
    const entries: ImageDeliveryView[] = [];
    for (const ref of refs) {
      if (ref.kind !== 'image') continue;
      const sha256 = ref.sha256;
      if (sha256 === undefined) {
        entries.push({ status: 'not_sent', reason: 'not_ingested' });
        continue;
      }
      const sha8 = sha256.slice(0, 8);
      const hit = known.facts.get(sha8);
      if (hit !== undefined) {
        entries.push(hit);
        continue;
      }
      entries.push(
        known.coverage === 'complete'
          ? { status: 'not_sent', reason: 'no_delivery_event', sha8 }
          : { status: 'unknown', reason: 'no_delivery_record', sha8 },
      );
    }
    if (entries.length === 0) return message;
    changed = true;
    return { ...message, image_delivery: entries };
  });
  return changed ? out : (window as ProjectedMessage[]);
}

/**
 * 会话事件游标（additive `sessions.get.event_cursor`，0.53）。
 *
 * 两个数是**不同**的东西，别混（前端据此决定“要不要补洞、从哪儿补”）：
 * - `last_seq` = 事件日志里最后一条事件的 `seq`（从文件尾定边界，不依赖索引）；
 * - `derived_upto_seq` = **落盘水位**：写入侧已落盘到哪个 `seq`（`index.json`）；与 `last_seq`
 *   相等表示已追平。**不代表投影覆盖范围**（ADR-105 D2：写侧不宣布投影覆盖），所以
 *   「`derived_upto_seq < last_seq` ⇒ 还有事件没进投影」这个推论**不成立**，别这么用。
 *
 * 整字段缺省 = 这个会话**还没有事件日志**（一条都没落过），不是 0、不是 null。
 * `event_count` 与 `derived_upto_seq` 同源（`index.json`），索引缺失/损坏时一起缺省——
 * 此时 `last_seq` 仍然给（文件尾定边界不依赖索引）。`event_count` 是**最后 seq 口径**
 * 而不是事件条数（chunk 也占 seq），**别拿它数条数**。
 */
export interface SessionEventCursor {
  last_seq: number;
  derived_upto_seq?: number;
  event_count?: number;
  /**
   * 0.54 A（ADR-105 §3 I4）：会话 timeline 的两个 head / 洞区间 / 污点。
   *
   * **四个字段一起出现或一起缺省**：开关关（`timeline.dual_write: false`）或该会话
   * 根本没有 timeline ⇒ 四个都不出现（**不报假零**：`0` 是「有 timeline 但一条没归档」，
   * 与「没有 timeline」是两件事）。`timeline_head <= wal_head` 恒成立。
   *
   * `holes` 只给区间（`{from_seq,to_seq}`）：洞内是「读不回来的 seq」，贴 payload 只会
   * 把不可读的东西伪装成可读。
   */
  timeline_head?: number;
  wal_head?: number;
  /**
   * 0.54 pub-i2：**一定被发布过**的最大 seq（`published_head <= wal_head`）。
   *
   * 与 `timeline.hello.published_head` 同一字段、同一口径：`(published_head, wal_head]`
   * 是「可读但从未发布」的崩溃窗口尾部，**不是**洞。装配层不透传时按 `wal_head` 兜底
   * （= 没有未发布尾部）。它只会随 `wal_head` 出现，不单独出现。
   */
  published_head?: number;
  holes?: SessionTimelineHoleRange[];
  tainted?: boolean;
}

/** 一个洞区间（timeline 四字段里的 `holes`；**不带** reason/at 等写入内部信息）。 */
export interface SessionTimelineHoleRange {
  from_seq: number;
  to_seq: number;
}

/**
 * timeline 四字段的**读取面**（0.54 A，`sessions.get.event_cursor` 的 additive 部分）。
 *
 * 装配层注入（`src/timeline-dual-write.ts#heads`）：内存里有 writer 就读它，否则读
 * `timeline.idx` + manifest + holes；**两边都没有 ⇒ `undefined` ⇒ 字段缺省**。
 * serve 不拼磁盘路径、不读盘，与 `sessionEvents` 同一范式。
 */
export interface SessionTimelineHeadsPort {
  lookup(sessionId: string): Promise<
    | {
        timeline_head: number;
        wal_head: number;
        holes: readonly { from_seq: number; to_seq: number }[];
        tainted: boolean;
        /**
         * 0.54 pub-i2：**一定被发布过**的最大 seq（`<= wal_head`）。
         *
         * core 的 `heads()` 只报对外四字段，`publishedHead()` 是另一个方法
         * （`packages/core/src/timeline/writer.ts:381`，注释写明「不属于对外四字段」），
         * 所以装配层要显式透传。**可选**：没给 = 全部视为已发布（pub-i2 之前的装配语义，
         * 与 core 自己在 open 时的 `this.published = this.walHead` 同口径，
         * `writer.ts:486`）。`hello.published_head` 在缺省时按 `wal_head` 兜底。
         */
        published_head?: number;
      }
    | undefined
  >;
}

/**
 * `sessions.events` 里的事件体：与 SSE 回放**同一个事件对象**（`RunEvent` + `seq`），
 * 前端按 `seq` 幂等合并；字段与 `event-buffer` 广播的 `{ seq, event }` 一一对应。
 *
 * 落盘记录里的 `v` / `fencing_token` / `session_id` 是对外无意义的写入内部字段
 * （`session_id` 就是入参），**不**透出：否则前端要多判断一层“哪个字段才是身份”。
 */
export interface SessionEventView {
  seq: number;
  type: string;
  ts: number;
  run_id?: string;
  data?: unknown;
}

/**
 * 会话事件日志的读端口（`sessions.events` + `sessions.get.event_cursor`，0.53）。
 *
 * 与 `SessionContextUsagePort` / `SessionSystemContextPort` 同一范式：serve 只做
 * “游标 + 分页 + 形状对齐”，不拼磁盘路径、不读盘；实现在 `src/session-events.ts`
 * （core `SessionEventLog`，`sinceSeq` 是**排他**游标）。
 * `cursor` / `watermark` 故意分成两个方法：`watermark` 只是一次 `stat`（缓存键），
 * `cursor` 才读 `index.json` + 日志尾，只在缓存 miss 时被调到。
 */
export interface SessionEventsPort {
  /** 读 `seq > sinceSeq` 的事件，按 `seq` 升序、最多 `limit` 条（排他游标，同 core）。 */
  read(
    sessionId: string,
    options: { sinceSeq?: number; limit?: number },
  ): Promise<SessionEventView[]>;
  /** 日志最新 `seq`（文件尾定边界）；文件不存在/为空 = `undefined`。 */
  lastSeq(sessionId: string): Promise<number | undefined>;
  /** 派生水位（`index.json` 的 `derived_upto_seq` / `event_count`）；索引缺失/损坏 = `undefined`。 */
  cursor(sessionId: string): Promise<{ derived_upto_seq: number; event_count: number } | undefined>;
  /** 事件日志尾水位（`大小:mtime`）；`undefined` = 没有日志文件。 */
  watermark(sessionId: string): Promise<string | undefined>;
}

/**
 * 「派生值 + 每会话缓存（键 = session + **事件日志尾水位**）」的通用实现
 * （`context_usage` 与 `system_context` 共用这一份，口径完全一致）。
 *
 * 取值时机：Web 在页面加载 / 切会话 / 重连（epoch 变化）时取一次 `sessions.get`，
 * run 期间另有 5s 的 `agents.tree` 轮询（live 优先，见 `useChatTranscript`）；
 * 缓存让「同一份日志被反复问」不变成反复读盘。
 * - 水位没变 → 直接命中，**0 字节读盘**，只花一次 `stat`；
 * - 水位变了（有新事件）→ 重读一次尾窗：正常命中 **64 KiB**；该会话尾部确实没有
 *   目标事件时按 64K→256K→1M→4M 扩窗，一次 miss 累计最多 **≈5.3 MiB**
 *   （见 `SessionEventLog.readTailMatches`），且不会退化成全量扫盘。
 * 失效只按水位（不设时间 TTL）：append-only 日志上「水位相同 ⇒ 结果相同」是确定的，
 * 时间到期只会制造一次无用读。
 *
 * 读盘 / `stat` 失败一律按「没有数据」返回：派生值是观测性字段，不能把
 * `sessions.get` 一起打成 internal（下次水位变化时自然重试）。
 */
function watermarkCached<T>(args: {
  /** 每会话缓存上限（超出后按插入序淘汰最旧的一条）。 */
  limit: number;
  /** 端口按需取（缺省 = 未注入，派生值整体缺省）。 */
  port: () =>
    | {
        lookup(sessionId: string): Promise<T | undefined>;
        watermark(sessionId: string): Promise<string | undefined>;
      }
    | undefined;
  /** 线上形状收敛：非法值一律当「没有数据」，不猜、不补 0。 */
  normalize: (raw: T | undefined) => T | undefined;
}): (sessionId: string) => Promise<T | undefined> {
  const cache = new Map<string, { watermark: string | undefined; value: T | undefined }>();
  return async (sessionId) => {
    const port = args.port();
    if (port === undefined) return undefined;
    let watermark: string | undefined;
    let value: T | undefined;
    try {
      watermark = await port.watermark(sessionId);
      const cached = cache.get(sessionId);
      if (cached !== undefined && cached.watermark === watermark) return cached.value;
      // 没有事件日志（水位 undefined）= 这个会话还没落过任何事件，不必再开文件。
      value = watermark === undefined ? undefined : args.normalize(await port.lookup(sessionId));
    } catch {
      return undefined;
    }
    if (!cache.has(sessionId) && cache.size >= args.limit) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(sessionId, { watermark, value });
    return value;
  };
}

/**
 * 每会话派生值的缓存上限（两条派生值各一份，互不干扰）。
 *
 * 与该缓存的存在理由同一句话：缓存让「同一份日志被反复问」不变成反复读盘。
 */
const DERIVED_CACHE_LIMIT = 256;

/**
 * 会话的归属（additive `agent`，0.52）。
 *
 * 存在理由是 UI 侧的一个洞：`SessionInfo` 里没有任何指向 agent 的字段，会话卡片的第二行
 * 只能拿 session id 去三份名单反查（team members / `roster.agents` / `body_history`），
 * 而三份各有门槛 —— 非 primary body 的会话（rotate 之前的旧身体）一份都不在，就读成空行。
 * 归属数据从一开始就在 registry 里（members 的 `session_id` + `body_history[]`），
 * 只是没随会话下发。这里补上，让它**双向**。
 *
 * 全字段可选：没有适配器 / 查询失败 ⇒ 空映射，字段缺省，`sessions.list` 一字不改地能用。
 * `primary=false` 表示这是已退役 body 的会话。
 */
export interface SessionAgentBinding {
  id: string;
  name?: string;
  /** 成员状态原值（`closed` = 已停用，前端据此默认归档）。 */
  state: string;
  presence?: 'live' | 'gone';
  primary: boolean;
  /**
   * 树深度（depth-color D1 additive）：parent 链服务端真值（根 = 0），
   * 与 agents.list / teams.get roster / self-card 同一 resolver。
   * 老适配器缺省 ⇒ 不写键，前端回落 roster 反查 / 不着色。
   */
  depth?: number;
}

export interface SessionMethodsDeps {
  sessionFor(): SessionStore | undefined;
  /** 最近 RunRecord 的读取面；缺省时 `sessions.get` 只用 `legacy_run` 投影。 */
  runStoreFor?(): SessionRunLookup | undefined;
  /**
   * 会话级上下文用量（additive `context_usage`）：由装配层从**事件日志尾窗**派生
   * （历史会话 / rotate 之后 / 进程重启之后都能拿到）。
   *
   * 缺省 = `sessions.get` 不带该字段（旧行为一字不改）。serve 不拼磁盘路径、不读盘：
   * 读取面（`SessionEventLog` 所在的 data-dir）由 app 侧注入。
   */
  contextUsage?: SessionContextUsagePort;
  /**
   * 会话级请求组成快照（additive `sessions.composition`，q-context-composition）：
   * 由装配层从**事件日志尾窗**派生（`context.composition` 事实事件）。
   * 缺省 = 方法返回 `not_supported`（旧装配行为一字不改、不抛错）。
   */
  composition?: SessionCompositionPort;
  /**
   * 会话级「模型这一轮看到了什么系统消息」（additive `system_context`）：由装配层从
   * **事件日志尾窗**派生（进程重启 / 回放窗口淘汰之后仍然能拿到 —— 事件不是 message，
   * `messages` 里永远没有它）。
   *
   * 缺省 = `sessions.get` 不带该字段（旧行为一字不改、不抛错）。serve 不拼磁盘路径、
   * 不读盘：读取面（`SessionEventLog` 所在的 data-dir）由 app 侧注入。
   */
  systemContext?: SessionSystemContextPort;
  /**
   * 带图的投递状态（additive 0.56）：由装配层从**事件日志尾窗**折叠
   * （`image.sent` / `context.image_dropped`）。
   *
   * 缺省 = `sessions.get` 不带 `image_delivery`（旧行为一字不改、不抛错）。
   */
  imageDelivery?: SessionImageDeliveryPort;
  /**
   * 会话事件日志的读端口（0.53：additive `sessions.events` + `sessions.get.event_cursor`）。
   *
   * 缺省 = `sessions.events` 返回 `not_supported`、`sessions.get` 不带 `event_cursor`
   * （旧行为一字不改、不抛错）。serve 不拼磁盘路径、不读盘：读取面
   * （`SessionEventLog` 所在的 data-dir）由 app 侧注入（见 `src/session-events.ts`）。
   */
  sessionEvents?: SessionEventsPort;
  /**
   * timeline 四字段的读端口（0.54 A：additive `sessions.get.event_cursor` 的
   * `timeline_head` / `wal_head` / `holes` / `tainted`）。
   *
   * 缺省 = 四个字段一起缺省（旧装配 / 双写开关关，行为一字不改、不抛错）。
   */
  timelineHeads?: SessionTimelineHeadsPort;
  /**
   * 时间线**分页读**端口（0.54 B1；0.54 C 起是 `sessions.events` 的**唯一**读源）。
   *
   * 从时间线读（`timeline_seq` 口径，`ADR-105 §6` 单游标）。0.54 C 删掉了
   * `timeline.read_from` 回退开关与事件日志分支：全库会话已全部迁到时间线，
   * 旧源没有第二个读者需要它。
   * 缺省 = `sessions.events` 返回 `not_supported`（端口没装配就是没这个能力）。
   */
  timelineRead?: TimelineReadPort;
  /**
   * CONTRACT-0.34-context C7：仅服务 `sessions.compact` 的执行面。
   * 结构化读取可选 `compactContext(sessionId)`；缺省或方法缺失 = `compact_unavailable`。
   */
  compactRuntime?(): unknown;
  /**
   * CREATE-0.39：agent 控制面（app 注入 AgentService 适配器）。
   * 缺省 = `sessions.create|restart|activate` 仍进 manifest，但 handler 返回 `not_found`。
   */
  agent?: AgentControlLike;
  sessionData?: {
    deleteSessionData(
      sessionId: string,
      tenantId?: string,
    ): Promise<{
      sessions_deleted: number;
      runs_deleted: number;
      events_deleted: number;
    }>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `sessions.get.message_limit` 上限：与 `events.list` 的 500 对齐。 */
const MAX_MESSAGE_LIMIT = 500;
/** 有 `before` 但未给 `message_limit` 时的页大小。 */
const DEFAULT_MESSAGE_LIMIT = 100;
const MESSAGE_CURSOR_VERSION = 1;

/**
 * `sessions.events` 的分页（0.53）：与 `sessions.get.message_limit` / `events.list`
 * 同一个风格 —— 默认 100、硬顶 2000，超限按游标翻页，不一次性把日志塞进一帧。
 *
 * 0.57：硬顶 500 → **2000**。首屏要的就是 2000 条（`TIMELINE_TAIL_WINDOW_EVENTS` 一段），
 * 硬顶 500 时客户端必须**串行翻 4 页**（每页都要等上一页的 `next_seq`），而 4 页拿到的
 * 数据与 1 页一样多。抬到 2000 不改变任何一帧的数据量上限（一段仍是 2000 条），只是让
 * 「一段 = 一页」：真机 20.9 万事件的会话，读口 4×500 冷态 134 ms → 1×2000 冷态 55 ms，
 * 客户端往返 4 → 1。
 */
const DEFAULT_SESSION_EVENTS_LIMIT = 100;
const MAX_SESSION_EVENTS_LIMIT = 1000;
/**
 * 单次请求最多扫多少条落盘事件（`types` 全不中时的安全阀）：
 * 到顶就 `has_more: true` 让客户端继续翻页，宁可变慢也不让一次 RPC 卡死读整份日志。
 */
const SESSION_EVENTS_MAX_SCAN = 20_000;
/**
 * 一次 `readPage` 向时间线读口要多少条（内部翻页的页大小）。
 *
 * 这个数必须 **≤ 读口硬顶**（`src/timeline-dual-write.ts#TIMELINE_PAGE_MAX = 1000`）：
 * 要多了端口会自己裁掉，白写一次 `limit`。取 1000 而不是老的 500 的理由是「同样的
 * 数据量，开的块数差 2 倍」：一页 1000 条只定位一次块与索引，2 页要定位两次（实测
 * 46–62 ms vs 4 页的 106–152 ms）。`types` / `tool_call_id` 过滤时也一样——扫的条数不变，只是
 * 少几趟定位。
 *
 * 为什么**不**取 2000：最重的会话实测 4.6 KB/事件 ⇒ 2000 条一帧约 8.8 MB，正好撞上
 * WS 单帧的 8 MiB 硬阈值（那只拦「发之前已堆积」，单帧仍会发出去）。1000 时最坏约 4.4 MB，
 * 留足余量；往返从 4 趟降到 2 趟，已经拿走大部分收益。
 */
const SESSION_EVENTS_READ_CHUNK = 2000;
/** `types` 过滤条数上限（防止有人拿它当全量枚举使）。 */
const MAX_SESSION_EVENTS_TYPES = 64;
/** `since_seq` 的硬上界：JS 安全整数（seq 是正整数计数，超过它就不可能是真的游标）。 */
const MAX_SAFE_SEQ = Number.MAX_SAFE_INTEGER;

/**
 * 历史分页游标：绝对数组下标 + 边界锚点。
 *
 * 不用 `derived_upto_seq` / `updated_at` 做校验：运行中追加会推进它们，
 * 会把正常追加误判成前缀被改写。锚点只随「返回窗口之前那条消息」变化。
 */
interface MessageCursor {
  /** 下一页窗口的 end（绝对下标） */
  index: number;
  /** `messages[index - 1].timestamp ?? -1` */
  timestamp: number;
  /** `messages[index - 1].content.length` */
  length: number;
  /** `messages[index - 1].role` */
  role: string;
}

function encodeMessageCursor(cursor: MessageCursor): string {
  const payload = {
    v: MESSAGE_CURSOR_VERSION,
    i: cursor.index,
    t: cursor.timestamp,
    l: cursor.length,
    r: cursor.role,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** 解析失败返回 undefined；调用方映射为 `invalid_params`。 */
function decodeMessageCursor(raw: string): MessageCursor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.v !== MESSAGE_CURSOR_VERSION) return undefined;
  const { i, t, l, r } = parsed;
  if (typeof i !== 'number' || !Number.isInteger(i) || i < 0) return undefined;
  if (typeof t !== 'number' || !Number.isFinite(t)) return undefined;
  if (typeof l !== 'number' || !Number.isInteger(l) || l < 0) return undefined;
  if (typeof r !== 'string') return undefined;
  return { index: i, timestamp: t, length: l, role: r };
}

/** `message_limit`：缺省 undefined；存在但不是 1..500 的整数 → invalid_params。 */
function parseMessageLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_MESSAGE_LIMIT
  ) {
    throw new RpcError(
      'invalid_params',
      `message_limit must be an integer between 1 and ${MAX_MESSAGE_LIMIT}`,
    );
  }
  return value;
}

/** `before`：缺省 undefined；存在但不是合法游标 → invalid_params。 */
function parseMessageCursor(value: unknown): MessageCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError('invalid_params', 'before must be a non-empty cursor string');
  }
  const cursor = decodeMessageCursor(value);
  if (cursor === undefined) {
    throw new RpcError('invalid_params', 'before is not a valid cursor');
  }
  return cursor;
}

/**
 * `since_seq`（`sessions.events`）：缺省 0（从日志头开始）；非负整数之外 → invalid_params。
 * 语义是**排他**游标（只回 `seq > since_seq`），与 core `ReadSessionEventsOptions` 一致。
 */
function parseSinceSeq(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RpcError('invalid_params', 'since_seq must be a non-negative integer');
  }
  return value;
}

/** `limit`：缺省 100；1..500 之外 → invalid_params（与 `message_limit` 同口径）。 */
function parseSessionEventsLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_SESSION_EVENTS_LIMIT;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_SESSION_EVENTS_LIMIT
  ) {
    throw new RpcError(
      'invalid_params',
      `limit must be an integer between 1 and ${MAX_SESSION_EVENTS_LIMIT}`,
    );
  }
  return value;
}

/**
 * `types`：条目以 `*` 结尾按**前缀**匹配、否则精确匹配（与 `events.subscribe` 同一口径）；
 * 缺省 / 空数组 = 不过滤。非法条目（非字符串 / 空串 / 超过上限）→ invalid_params。
 */
function parseSessionEventTypes(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new RpcError('invalid_params', 'types must be an array of non-empty strings');
  }
  const types: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new RpcError('invalid_params', 'types must be an array of non-empty strings');
    }
    if (types.length >= MAX_SESSION_EVENTS_TYPES) {
      throw new RpcError(
        'invalid_params',
        `types accepts at most ${MAX_SESSION_EVENTS_TYPES} entries`,
      );
    }
    types.push(entry.trim());
  }
  return types.length === 0 ? undefined : types;
}

/**
 * `tool_call_id`（`sessions.events`，0.53 U3 additive）：只回**携带这个工具调用 id** 的事件。
 *
 * 为什么需要它：`archive_notice` 的归档卡上写着「按 `tool_call_id` 从事件日志读回原文」
 * （ADR-104 §2.3(c) 的 `readback` 行）。那条指引必须能在一条 RPC 里走完 —— 否则卡上的
 * 每一句都是要用户自己去翻 ndjson 的死链。缺省 = 不过滤（旧调用方一字不改）。
 *
 * 非法值（非字符串 / 空串 / 超长）→ `invalid_params`，与 `since_seq` / `limit` 同口径。
 */
function parseToolCallId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new RpcError('invalid_params', 'tool_call_id must be a non-empty string');
  }
  return value;
}

/**
 * `event_cursor` 收敛成线上形状：非法值一律当「没有数据」，**不猜、不补 0**
 * （与 `normalizeContextUsage` 同口径）。
 */
function normalizeEventCursor(raw: SessionEventCursor | undefined): SessionEventCursor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const lastSeq = optionalNumber(raw.last_seq);
  if (lastSeq === undefined || lastSeq < 0) return undefined;
  const derived = optionalNumber(raw.derived_upto_seq);
  const count = optionalNumber(raw.event_count);
  const timeline = normalizeTimelineHeads(raw);
  return {
    last_seq: Math.floor(lastSeq),
    ...(derived === undefined || derived < 0 ? {} : { derived_upto_seq: Math.floor(derived) }),
    ...(count === undefined || count < 0 ? {} : { event_count: Math.floor(count) }),
    ...(timeline ?? {}),
  };
}

/**
 * 时间线读源的一页（0.54 B1，`sessions.events` 换源后的实现）。
 *
 * 语义与旧日志那一页**逐条对齐**（客户端 `collectTimelineRange` 只认这两个停止条件）：
 * - `next_seq` = **已处理到的位置**（排他游标）：过滤掉的 seq 也要算进去，否则翻页会漏；
 * - `has_more` = 还有没有「未读且未跳过」的 seq —— 只按 `limit + 1` 多要一条来判，
 *   不猜、不重读一遍边界（重读会让两次边界不一致）；
 * - `latest_seq` = 有效右端 `min(wal_head, published_head)`（未发布尾部不算「追平」依据）。
 *
 * 两个过滤器（`types` / `tool_call_id`）与旧路径同为**与**关系；带过滤时按页扫，
 * 凑够 `limit + 1` 就停，扫到上限仍不够 ⇒ `has_more: true` 让客户端继续翻（宁可多翻几次，
 * 也不让一次 RPC 把 17 万条扫穿）。
 */
async function readTimelineEventPage(
  port: TimelineReadPort,
  sessionId: string,
  heads: { wal_head: number; published_head?: number },
  sinceSeq: number,
  limit: number,
  types: readonly string[] | undefined,
  toolCallId: string | undefined,
): Promise<{
  events: ReturnType<typeof toTimelineEventView>[];
  next_seq: number;
  latest_seq: number;
  has_more: boolean;
}> {
  const effectiveEnd =
    heads.published_head === undefined
      ? Math.max(0, Math.floor(heads.wal_head))
      : Math.min(Math.floor(heads.wal_head), Math.max(0, Math.floor(heads.published_head)));
  const events: ReturnType<typeof toTimelineEventView>[] = [];
  let cursor = Math.max(0, Math.floor(sinceSeq));
  let scanned = 0;
  let hasMore = false;
  // 一次内部读要多少条：**这一页还差多少**，封顶在读口硬顶。`limit` 缺省（旧调用方）
  // 时就是读口硬顶本身，与老的「一页一页读」拿到的记录逐条相同，只是少几趟定位。
  const chunk = Math.max(1, Math.min(limit, SESSION_EVENTS_READ_CHUNK));
  while (scanned < SESSION_EVENTS_MAX_SCAN) {
    if (cursor >= effectiveEnd) break;
    let page: Awaited<ReturnType<TimelineReadPort['readPage']>>;
    try {
      page = await port.readPage(sessionId, {
        afterSeq: cursor,
        untilSeq: effectiveEnd,
        limit: chunk,
      });
    } catch (error) {
      // 0.55：旧格式会话在**页读**这一层被 core 拒绝（`legacy_session_unsupported`）。
      // 必须把它升级成同一个协议码再抛 —— 让它落成 `internal` 等于把「这个会话是 0.54
      // 之前的格式」说成「服务端内部错误」，用户拿不到那句可照做的修复提示。
      if (isLegacySessionUnsupported(error)) {
        throw new MethodError('legacy_session_unsupported', legacySessionUnsupportedMessage(error));
      }
      throw error;
    }
    const ordered = selectTimelinePage(page, cursor + 1, effectiveEnd, chunk);
    if (ordered.length === 0) break;
    for (const record of ordered) {
      if (record.seq <= cursor) continue;
      cursor = record.seq;
      scanned += 1;
      if (
        types !== undefined &&
        !types.some((type) =>
          type.endsWith('*') ? record.type.startsWith(type.slice(0, -1)) : record.type === type,
        )
      ) {
        continue;
      }
      if (toolCallId !== undefined && recordDataField(record, 'tool_call_id') !== toolCallId) {
        continue;
      }
      events.push(toTimelineEventView(record));
      // 0.57（性能）：**无过滤时拿满 `limit` 条就能判定 `has_more`**，不必再多读一页只为
      // 确认「后面还有至少一条」。
      //
      // 旧口径靠多取一条（`events.length > limit`）来证明「还有更多」，于是每一页都多一次
      // 范围读（`readPage` 一次 ~50-100 ms，首屏 2000 条 = 4 页 = 白读 4 次）。而 `cursor`
      // 之后到 `effectiveEnd` 之间还有记录时，`has_more` 本来就该是 true —— 这与下面那句
      // `if (!hasMore && cursor < effectiveEnd) hasMore = true` 同口径，只是提前下结论。
      //
      // 只在**没有类型 / tool_call_id 过滤**时这么做：有过滤时「后面还有记录」不等于
      // 「后面还有**匹配的**事件」，仍要按旧路径多取一条来确认。
      if (types === undefined && toolCallId === undefined && events.length >= limit) {
        if (cursor < effectiveEnd) hasMore = true;
        break;
      }
      if (events.length > limit) {
        hasMore = true;
        break;
      }
    }
    if (hasMore) break;
    if (cursor >= effectiveEnd) break;
  }
  if (!hasMore && cursor < effectiveEnd) hasMore = true;
  const trimmed = events.length > limit ? events.slice(0, limit) : events;
  const lastReturned = trimmed.length > 0 ? trimmed[trimmed.length - 1] : undefined;
  // 溢出时游标停在**返回的最后一条**上（与旧路径同口径：否则翻页会丢事件）。
  const nextSeq = hasMore ? (lastReturned?.seq ?? cursor) : cursor;
  return {
    events: trimmed,
    next_seq: nextSeq,
    latest_seq: Math.max(effectiveEnd, lastReturned?.seq ?? 0),
    has_more: hasMore,
  };
}

/** 时间线记录 → `sessions.events` 的 wire 事件（与 `sessions.get` 同形）。 */
function toTimelineEventView(record: TimelineWireEvent): {
  seq: number;
  type: string;
  run_id?: string;
  ts: number;
  data: unknown;
} {
  return {
    seq: record.seq,
    type: record.type,
    ...(record.run_id !== undefined ? { run_id: record.run_id } : {}),
    ts: record.ts,
    data: record.data ?? {},
  };
}

function recordDataField(record: TimelineWireEvent, key: string): unknown {
  const data = record.data;
  if (typeof data !== 'object' || data === null) return undefined;
  return (data as Record<string, unknown>)[key];
}

/**
 * timeline 四字段 + `published_head` 的收敛（0.54 A / pub-i2）：**一起收或一起丢**，
 * 且非法值一律不猜。
 *
 * 不变量：`0 ≤ timeline_head ≤ published_head ≤ wal_head`（写入侧
 * `timeline_head ≤ wal_head`、`published ≤ wal_head`；`published_head` 缺省时按
 * `wal_head` 兜底 = 没有未发布尾部）。读侧不合它说明端口给错了东西（不是数据坏了），
 * 整组字段缺省比报一对矛盾数字更安全。
 */
function normalizeTimelineHeads(
  raw: SessionEventCursor,
):
  | Pick<SessionEventCursor, 'timeline_head' | 'wal_head' | 'published_head' | 'holes' | 'tainted'>
  | undefined {
  const timelineHead = optionalNumber(raw.timeline_head);
  const walHead = optionalNumber(raw.wal_head);
  const tainted = raw.tainted;
  const holes = raw.holes;
  if (timelineHead === undefined || walHead === undefined || typeof tainted !== 'boolean') {
    return undefined;
  }
  if (!Array.isArray(holes)) return undefined;
  if (timelineHead < 0 || walHead < 0 || timelineHead > walHead) return undefined;
  // pub-i2：`published_head` 缺省 = `wal_head`（装配层没透传 ⇒ 没有未发布尾部）。
  const publishedRaw = optionalNumber(raw.published_head);
  const publishedHead = publishedRaw === undefined ? walHead : publishedRaw;
  if (publishedHead < 0 || publishedHead > walHead) return undefined;
  const ranges: SessionTimelineHoleRange[] = [];
  for (const hole of holes) {
    if (!isRecord(hole)) return undefined;
    const from = optionalNumber(hole.from_seq);
    const to = optionalNumber(hole.to_seq);
    if (from === undefined || to === undefined || from < 1 || to < from) return undefined;
    ranges.push({ from_seq: Math.floor(from), to_seq: Math.floor(to) });
  }
  return {
    timeline_head: Math.floor(timelineHead),
    wal_head: Math.floor(walHead),
    published_head: Math.floor(publishedHead),
    holes: ranges,
    tainted,
  };
}

/** 游标锚点不再匹配：前缀被改写（compaction / rewind），客户端应重取尾页。 */
function historyChanged(): never {
  throw new RpcError('conflict', 'Session history changed; reload the latest page', {
    reason: 'history_changed',
  });
}

type CompactContextFn = (sessionId: string) => Promise<{ removed: number; remaining: number }>;

/** `compact_unavailable` 可能以 RpcError.code 或 message 形式到达（远程 / 本地门面）。 */
function isCompactUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    (typeof code === 'string' && code.includes('compact_unavailable')) ||
    (typeof message === 'string' && message.includes('compact_unavailable'))
  );
}

/** 终态（update_at 可作为 completed_at）。 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

// ── CREATE-0.39：sessions.create / restart / activate ──

function requireSessionAgentControl(control: AgentControlLike | undefined): AgentControlLike {
  if (!control) {
    throw new RpcError('not_found', 'Agent control is not available');
  }
  return control;
}

function teamScopeOf(ctx: RpcMethodContext): string | undefined {
  return isTeamScopedPrincipal(ctx.principal) ? ctx.principal.team_id : undefined;
}

/** team-scoped token 只允许作用在同 team 成员；解析失败按 not_found 拒绝（fail-closed）。 */
async function inTeamScope(
  control: AgentControlLike,
  scope: string,
  target: string,
): Promise<boolean> {
  const status = await control.resolve(target).catch(() => undefined);
  return status !== undefined && status.team_id === scope;
}

/** 兼容 schema 校验与直接调用：seed 缺省 undefined（服务按 copy）。 */
function readCreateSeed(value: unknown): AgentCreateSeedLike | undefined {
  if (value === undefined) return undefined;
  if (value !== 'copy' && value !== 'compact') {
    throw new RpcError('invalid_params', 'seed must be copy or compact');
  }
  return value;
}

function readKeepMessages(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RpcError('invalid_params', 'keep_messages must be a non-negative integer');
  }
  return value;
}

function readSessionMode(value: unknown): 'conversation' | 'both' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'conversation' && value !== 'both') {
    throw new RpcError('invalid_params', 'mode must be conversation or both');
  }
  return value;
}

/**
 * 0.53 U1（ADR-104 §2.1 / §6.4）：`sessions.create` 的 `projection_mode`。
 *
 * 这里只做两件在网关就能判的事：词表 + `externalize` 不可用；拒绝码与 ADR 一致，
 * 其余（收窄、不可变）都留给 agent 层的声明入口，避免两套口径。
 */
function readProjectionMode(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError('invalid_params', 'projection_mode must be a non-empty string');
  }
  try {
    return resolveProjectionMode(value);
  } catch (error) {
    if (error instanceof ProjectionPolicyError) {
      throw new RpcError('invalid_params', error.code);
    }
    throw error;
  }
}

function readSessionFiles(value: unknown): { ref: string; paths: string[] } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new RpcError('invalid_params', 'files must be an object');
  const ref = value.ref;
  const paths = value.paths;
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new RpcError('invalid_params', 'files.ref must be a non-empty string');
  }
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new RpcError('invalid_params', 'files.paths must be a non-empty string array');
  }
  return { ref, paths: [...(paths as string[])] };
}

function agentErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function agentErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Agent control failed';
}

/**
 * CREATE-0.39 §2.4 / §3.1.1 / §4.1.1：把 AgentError 业务失败映射到冻结 RPC 码。
 *
 * 不新增 `RpcErrorCode`：`not_visible` 用 `not_found` + `details.reason` 表达；
 * `restart_failed` / `restart_rollback_failed` / `activate_failed` / `create_failed`
 * 只作为 `internal` 的 message reason，不泄漏原始 `invalid_input`。
 * r10：`run_in_progress: <runId|spawn>` 的 wire message 固定为 `run_in_progress`，
 * 真实 runId 只进 `details.run_id`。
 */
function mapSessionControlError(error: unknown): never {
  if (error instanceof RpcError) throw error;
  const code = agentErrorCode(error);
  const message = agentErrorMessage(error);

  switch (code) {
    case 'unknown_member':
      if (message.includes('session_not_found')) {
        throw new RpcError('session_not_found', 'Session not found');
      }
      throw new RpcError('not_found', message);
    case 'member_not_visible':
      throw new RpcError('not_found', message, { reason: 'not_visible' });
    case 'invalid_input':
      throw new RpcError('invalid_params', message);
    case 'conflict': {
      const running = runInProgressReason(message);
      if (running !== undefined) {
        throw new RpcError(
          'conflict',
          'run_in_progress',
          running.runId !== undefined ? { run_id: running.runId } : undefined,
        );
      }
      throw new RpcError('conflict', message);
    }
    case 'member_closed':
      throw new RpcError(
        'conflict',
        message.includes('agent_closed') ? message : `agent_closed: ${message}`,
      );
    case 'team_frozen':
    case 'team_full':
      throw new RpcError('conflict', message.includes(code) ? message : `${code}: ${message}`);
    case 'spawn_failed':
      // create_failed / restart_failed / restart_rollback_failed / activate_failed
      throw new RpcError('internal', message);
    case 'quota_exceeded':
      throw new RpcError('quota_exceeded', message);
    case 'not_supported':
    case 'invalid_params':
    case 'not_found':
    case 'internal':
      throw new RpcError(code, message);
    case 'session_not_found':
      throw new RpcError('session_not_found', message);
    default:
      // 无稳定 code（或 adapter 直接 reject Error）时按 reason token 兜底。
      if (message.includes('session_not_found')) {
        throw new RpcError('session_not_found', 'Session not found');
      }
      if (message.includes('not_primary')) {
        throw new RpcError('conflict', 'not_primary');
      }
      if (message.includes('run_in_progress')) {
        const running = runInProgressReason(message) ?? {};
        throw new RpcError(
          'conflict',
          'run_in_progress',
          running.runId !== undefined ? { run_id: running.runId } : undefined,
        );
      }
      if (message.includes('source_private')) {
        throw new RpcError('invalid_params', 'source_private');
      }
      if (message.includes('agent_closed')) {
        throw new RpcError('conflict', 'agent_closed');
      }
      throw new RpcError('internal', message);
  }
}

const sessionCreateResultSchema = {
  type: 'object',
  required: ['agent_id', 'session_id', 'primary'],
  properties: {
    agent_id: { type: 'string' },
    session_id: { type: 'string' },
    source_session_id: { type: 'string' },
    seed: { type: 'string', enum: ['copy', 'compact'] },
    keep_messages: { type: 'integer', minimum: 0 },
    keep_projected: { type: 'integer', minimum: 0 },
    copied_messages: { type: 'integer', minimum: 0 },
    title: { type: 'string' },
    primary: { type: 'boolean' },
    files_restored: { type: 'integer', minimum: 0 },
    files_skipped: { type: 'integer', minimum: 0 },
  },
};

const sessionRestartResultSchema = {
  type: 'object',
  required: ['agent_id', 'session_id', 'from_epoch', 'epoch'],
  properties: {
    agent_id: { type: 'string' },
    session_id: { type: 'string' },
    from_epoch: { type: 'integer', minimum: 0 },
    epoch: { type: 'integer', minimum: 0 },
  },
};

const sessionActivateResultSchema = {
  type: 'object',
  required: ['agent_id', 'session_id', 'previous_session_id', 'epoch', 'noop'],
  properties: {
    agent_id: { type: 'string' },
    session_id: { type: 'string' },
    previous_session_id: { type: 'string' },
    epoch: { type: 'integer', minimum: 0 },
    noop: { type: 'boolean' },
  },
};

/**
 * `sessions.get` 的线上投影：SessionState 元数据 + 最近 RunRecord（或 `legacy_run`）。
 *
 * 形状保持既有 `runStateSchema`：run 字段来自 RunRecord，session 字段来自 SessionState。
 *
 * **不含 `messages`**（0.52）：消息要走 `capToolMessages` 裁剪后再出站，由调用方按窗口
 * 单独拼装；放在这里等于给未来调用方留一条「整份未裁剪历史」的后门。
 */
export function toSessionView(state: SessionState, latestRaw: unknown): Record<string, unknown> {
  const latest = isRecord(latestRaw) ? latestRaw : undefined;
  const legacy = state.legacy_run;
  const status = optionalString(latest?.status) ?? state.status ?? 'running';
  const terminal = TERMINAL_STATUSES.has(status);
  const runId = optionalString(latest?.run_id) ?? state.last_run_id ?? state.session_id;
  const startedAt = optionalNumber(latest?.created_at) ?? state.created_at;
  const updatedAt = optionalNumber(latest?.updated_at) ?? state.updated_at;
  const completedAt = terminal ? updatedAt : legacy?.completed_at;
  const usage = latest?.usage ?? legacy?.usage;
  const error = optionalString(latest?.error) ?? legacy?.error;
  const branch = optionalString(latest?.branch) ?? state.created_on_branch;
  // 0.53 U1（ADR-104 §8.2）：投射模式与「是否已锁」由**服务端**给结论，
  // 客户端不许自己从别处推断（断言「UI 不能凭历史猜模式」）。
  // - 有声明 ⇒ 声明里的 mode；旧会话（无字段）⇒ legacy 解析成 placeholder。
  // - `projection_locked`：会话已存在 ⇒ 模式写定；`sessions.get` 只读已有会话，
  //   所以恒为 true（要判断「还没创建 ⇒ 可改」的入口是 create，不是 get）。
  const projection = resolveProjection(state);

  return {
    run_id: runId,
    session_id: state.session_id,
    started_at: startedAt,
    ...(completedAt !== undefined ? { completed_at: completedAt } : {}),
    status,
    ...(usage !== undefined ? { usage } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(state.title !== undefined ? { title: state.title } : {}),
    ...(state.preview !== undefined ? { preview: state.preview } : {}),
    updated_at: updatedAt,
    ...(branch !== undefined ? { branch } : {}),
    projection_mode: projection.mode,
    projection_locked: projection.locked,
  };
}

export function createSessionMethods(deps: SessionMethodsDeps): RpcMethodDefinition[] {
  const { sessionFor, runStoreFor, sessionData, compactRuntime, agent } = deps;

  // ── 每会话派生值（additive `context_usage` / `system_context`）──
  // 缓存只按 **session + 事件日志尾水位** 失效：日志 append-only ⇒ 水位不变时派生结果
  // 不可能变（0 字节读盘，只花一次 stat），水位变了才重读尾窗。派生逻辑与读盘位置都在
  // 注入的端口里 —— serve 不认识 data-dir。两条派生值共用 `watermarkCached`，口径
  // 完全一致（同一个上限、同一套「失败 = 没有数据」）。

  /** 收敛成线上形状：非法值一律当「没有数据」，不猜、不补 0。 */
  function normalizeContextUsage(
    raw: SessionContextUsage | undefined,
  ): SessionContextUsage | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const used = raw.used;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return undefined;
    const max = raw.max;
    const at = raw.at;
    const source = raw.source;
    return {
      used: Math.floor(used),
      ...(typeof max === 'number' && Number.isFinite(max) && max > 0
        ? { max: Math.floor(max) }
        : {}),
      ...(typeof at === 'number' && Number.isFinite(at) ? { at } : {}),
      ...(source === 'pressure' ||
      source === 'changed' ||
      source === 'estimated' ||
      source === 'prompt' ||
      source === 'request'
        ? { source }
        : {}),
    };
  }

  /**
   * 收敛成线上形状：`hash` 必须有，且 `system_prompt` / `self_card` 至少一个 ——
   * 只有 hash 的空壳卡没有展示价值，一律当「没有数据」（客户端不画卡）。
   */
  function normalizeSystemContext(
    raw: SessionSystemContext | undefined,
  ): SessionSystemContext | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const hash = raw.hash;
    if (typeof hash !== 'string' || hash.length === 0) return undefined;
    const systemPrompt =
      typeof raw.system_prompt === 'string' && raw.system_prompt.length > 0
        ? raw.system_prompt
        : undefined;
    const selfCard =
      typeof raw.self_card === 'string' && raw.self_card.length > 0 ? raw.self_card : undefined;
    if (systemPrompt === undefined && selfCard === undefined) return undefined;
    const model = typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : undefined;
    const runId = typeof raw.run_id === 'string' && raw.run_id.length > 0 ? raw.run_id : undefined;
    const int = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : undefined;
    const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : undefined;
    const messageCount = int(raw.message_count);
    const toolsCount = int(raw.tools_count);
    const estimatedTokens = int(raw.estimated_tokens);
    const contextMax = int(raw.context_max);
    return {
      hash,
      ...(systemPrompt !== undefined ? { system_prompt: systemPrompt } : {}),
      ...(selfCard !== undefined ? { self_card: selfCard } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(messageCount !== undefined ? { message_count: messageCount } : {}),
      ...(toolsCount !== undefined ? { tools_count: toolsCount } : {}),
      ...(estimatedTokens !== undefined ? { estimated_tokens: estimatedTokens } : {}),
      ...(contextMax !== undefined ? { context_max: contextMax } : {}),
      ...(at !== undefined ? { at } : {}),
      ...(runId !== undefined ? { run_id: runId } : {}),
    };
  }

  const contextUsageOf = watermarkCached<SessionContextUsage>({
    limit: DERIVED_CACHE_LIMIT,
    port: () => deps.contextUsage,
    normalize: normalizeContextUsage,
  });

  const systemContextOf = watermarkCached<SessionSystemContext>({
    limit: DERIVED_CACHE_LIMIT,
    port: () => deps.systemContext,
    normalize: normalizeSystemContext,
  });

  // ── 会话事件日志（additive `sessions.events` + `sessions.get.event_cursor`，0.53）──
  // app 侧注入读端口（core `SessionEventLog`），serve 只做游标、分页、形状对齐。

  /**
   * `event_cursor` 的端口适配：一次 lookup = 文件尾 `last_seq` + `index.json` 派生水位。
   *
   * 先 `lastSeq`（文件尾 stat + 尾读，不依赖索引），拿到再读索引：没有日志文件
   * ⇒ `lookup` 返回 `undefined` ⇒ `sessions.get` 不带 `event_cursor`（旧行为一字不改）。
   * 索引缺失/损坏只是少了 `derived_upto_seq` / `event_count`，`last_seq` 仍然给。
   */
  function eventCursorPort():
    | {
        lookup(sessionId: string): Promise<SessionEventCursor | undefined>;
        watermark(sessionId: string): Promise<string | undefined>;
      }
    | undefined {
    const port = deps.sessionEvents;
    const headsPort = deps.timelineHeads;
    if (port === undefined) return undefined;
    return {
      lookup: async (sessionId) => {
        const lastSeq = await port.lastSeq(sessionId);
        if (lastSeq === undefined) return undefined;
        const derived = await port.cursor(sessionId);
        // 0.54 A：timeline 四字段（additive）。端口缺省 / 该会话没有 timeline ⇒ 一起缺省；
        // 读失败也只少这四个字段（观测值不能把 `sessions.get` 打成 internal）。
        //
        // 缓存口径与两个旧派生值相同（按**事件日志尾水位**失效）：有事件 ⇒ 水位变 ⇒ 重读。
        // 已知边界（照实写）：只发生归档、不写新事件时水位不动，`timeline_head` 可能比
        // 真值落后一次 `sessions.get`；它不是判据（ADR-105 §5：索引/派生物不得当判据）。
        // 0.55：旧格式会话**必须报错**，不能当成空会话。`lookup` 抛的
        // `legacy_session_unsupported` 在这里升级成协议错误码（其它读取失败仍按
        // 「观测值缺省」处理 —— 它们不该把 `sessions.get` 打成 internal）。
        const timeline = await headsPort?.lookup(sessionId).catch((error: unknown) => {
          if (isLegacySessionUnsupported(error)) {
            throw new MethodError(
              'legacy_session_unsupported',
              legacySessionUnsupportedMessage(error),
            );
          }
          return undefined;
        });
        return {
          last_seq: lastSeq,
          ...(derived === undefined
            ? {}
            : { derived_upto_seq: derived.derived_upto_seq, event_count: derived.event_count }),
          ...(timeline === undefined
            ? {}
            : {
                timeline_head: timeline.timeline_head,
                wal_head: timeline.wal_head,
                // 0.54 pub-i2：未发布尾部（`published_head <= wal_head`）。
                // 与 `timeline.hello` **同一个字段、同一口径**：缺省时按 `wal_head` 兜底
                // （= 该装配没有未发布尾部；core 自己在 open 时也是
                // `this.published = this.walHead`，writer.ts:486）。
                published_head: timeline.published_head ?? timeline.wal_head,
                holes: timeline.holes.map((hole) => ({
                  from_seq: hole.from_seq,
                  to_seq: hole.to_seq,
                })),
                tainted: timeline.tainted,
              }),
        };
      },
      watermark: (sessionId) => port.watermark(sessionId),
    };
  }

  const eventCursorOf = watermarkCached<SessionEventCursor>({
    limit: DERIVED_CACHE_LIMIT,
    port: eventCursorPort,
    normalize: normalizeEventCursor,
  });

  /** 图片投递状态（0.56）的收敛：只认闭集，坏载荷一律当「没有记录」。 */
  function normalizeImageDelivery(
    raw: ImageDeliveryFacts | undefined,
  ): ImageDeliveryFacts | undefined {
    if (raw === undefined) return undefined;
    const out = new Map<string, ImageDeliveryView>();
    for (const [sha8, view] of raw.facts) {
      if (typeof sha8 !== 'string' || sha8.length === 0) continue;
      if (
        view.status !== 'sent' &&
        view.status !== 'dropped' &&
        view.status !== 'not_sent' &&
        view.status !== 'unknown'
      ) {
        continue;
      }
      out.set(sha8, view);
    }
    // 事实为空也算「有话要说」：`coverage` 才是判据（complete + 空 = 从来没发过）。
    return { facts: out, coverage: raw.coverage === 'complete' ? 'complete' : 'partial' };
  }

  const imageDeliveryOf = watermarkCached<ImageDeliveryFacts>({
    limit: DERIVED_CACHE_LIMIT,
    port: () => deps.imageDelivery,
    normalize: normalizeImageDelivery,
  });

  /**
   * 读一页时间线记录的形状对齐（0.54 C：`sessions.events` 只剩时间线一个读源，
   * 旧的 `SessionEventLog` 分页器 `readEventPage` 随事件日志分支一起删除）。
   */

  function requireSession(): SessionStore {
    const resolved = sessionFor();
    if (!resolved) {
      throw new RpcError('not_found', 'No session backend configured');
    }
    return resolved;
  }

  /**
   * 取会话壳（**读侧快照**）：后端支持 `loadForRead()` 就按 (path, size, mtime) 短路，
   * 否则退回 `load()`。逐字段相同，只是不再每次 parse 那份 1.8 MB 壳。
   *
   * 只许**读**这条返回值（见 `SessionStore#loadForRead` 的契约）：要写（rename / compact /
   * fork 之后 save）的路径继续用 `backend.load()`。
   */
  async function loadSessionForRead(
    backend: SessionStore,
    sessionId: string,
  ): Promise<SessionState | null> {
    if (backend.loadForRead !== undefined) return backend.loadForRead(sessionId);
    return backend.load(sessionId);
  }

  /**
   * 存在性校验：后端支持 `exists()` 就只花一次 stat，否则退回 `load() !== null`。
   *
   * 这是「只想确认会话在、并不需要壳」的路径专用（0.56：一次 `sessions.events` 曾为了
   * 存在性 parse 整份 1.8 MB 壳，长寿进程里 ~230 ms）。需要壳的路径不许用它。
   */
  async function sessionExists(backend: SessionStore, sessionId: string): Promise<boolean> {
    if (backend.exists !== undefined) return backend.exists(sessionId);
    return (await backend.load(sessionId)) !== null;
  }

  /**
   * 会话 → 归属映射（additive `agent`）。
   *
   * 一次 `agent.list()` 换一张表：现役 body（`session_id`）+ 已退役 body（`body_history[]`）。
   * **任何失败都退化成空映射**：这个字段是 enhance，不是前置条件 —— 宁可卡片少一行，
   * 也不能让 `sessions.list` 因为拿不到成员列表而整体报错。
   */
  async function sessionAgentBindings(): Promise<Map<string, SessionAgentBinding>> {
    const bindings = new Map<string, SessionAgentBinding>();
    if (!agent) return bindings;
    let members: Awaited<ReturnType<NonNullable<typeof agent>['list']>>;
    try {
      members = await agent.list();
    } catch {
      return bindings;
    }
    for (const member of members ?? []) {
      if (!member || typeof member.id !== 'string') continue;
      const name =
        typeof member.name === 'string' && member.name.trim() !== '' ? member.name : undefined;
      const presence =
        member.presence === 'live' || member.presence === 'gone' ? member.presence : undefined;
      // 树深度（depth-color D1）：只认非负整数真值；老适配器缺省 / 形状不对 ⇒ 不写键。
      const depth =
        typeof member.depth === 'number' && Number.isInteger(member.depth) && member.depth >= 0
          ? member.depth
          : undefined;
      const base = {
        id: member.id,
        ...(name === undefined ? {} : { name }),
        state: String(member.state ?? ''),
        ...(presence === undefined ? {} : { presence }),
        ...(depth === undefined ? {} : { depth }),
      } satisfies Omit<SessionAgentBinding, 'primary'>;
      const live = typeof member.session_id === 'string' ? member.session_id : '';
      if (live !== '' && !bindings.has(live)) bindings.set(live, { ...base, primary: true });
      for (const body of member.body_history ?? []) {
        const retired = typeof body?.session_id === 'string' ? body.session_id : '';
        // `primary=true` 的那一具永远赢：迟到的 body_history 不许把现役会话标成旧身体。
        if (retired === '' || retired === live || bindings.has(retired)) continue;
        bindings.set(retired, { ...base, primary: false });
      }
    }
    return bindings;
  }

  async function listSessions(): Promise<{ sessions: unknown[] }> {
    const backend = sessionFor();
    if (!backend) {
      throw new MethodError('no_session', 'No session backend configured');
    }
    const [sessions, bindings] = await Promise.all([backend.listRich(), sessionAgentBindings()]);
    if (bindings.size === 0) return { sessions };
    return {
      sessions: sessions.map((session) => {
        const found = bindings.get(session.session_id);
        return found === undefined ? session : { ...session, agent: found };
      }),
    };
  }

  return [
    {
      name: 'sessions.list',
      permission: 'read',
      params_schema: { type: 'object' },
      result_schema: {
        type: 'object',
        required: ['sessions'],
        properties: {
          sessions: { type: 'array', items: sessionInfoSchema },
        },
      },
      handler: () => listSessions(),
    },
    {
      name: 'sessions.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['session_id'],
        properties: {
          session_id: { type: 'string', minLength: 1 },
          // S1：历史分页（additive）。不传 = 旧行为（全量 messages）。
          message_limit: { type: 'integer', minimum: 1, maximum: MAX_MESSAGE_LIMIT },
          before: { type: 'string', minLength: 1 },
        },
      },
      result_schema: {
        type: 'object',
        required: ['session'],
        properties: {
          session: runStateSchema,
          // Additive (0.52)：会话归属，与 `sessions.list` 每项的 `agent` 同一个形状。
          // 老 gateway 不返回 ⇒ 前端回落到反查三份名单（见 `SessionAgentBinding`）。
          agent: sessionInfoSchema.properties.agent,
        },
      },
      handler: async (params) => {
        const backend = requireSession();
        const state = await loadSessionForRead(backend, stringParam(params, 'session_id'));
        if (!state) throw new RpcError('not_found', 'Session not found');
        const runStore = runStoreFor?.();
        // 最后一次 run 的检查点：**在这里起意、不 await**，与下面那批派生值一起收口
        // （0.57）。早先是「先 await 一次 `runStore.load()`，再开那批并发」—— 那一次
        // 往返（读 `runs/<id>.json`，冷态几十毫秒）白等在所有派生值前面。
        const latestLoading: Promise<Awaited<ReturnType<NonNullable<typeof runStore>['load']>>> =
          runStore !== undefined && state.last_run_id !== undefined
            ? runStore.load(state.last_run_id)
            : Promise.resolve(undefined);

        const all = state.messages ?? [];
        const total = all.length;
        const requestedLimit = parseMessageLimit(params.message_limit);
        const cursor = parseMessageCursor(params.before);

        let start = 0;
        let end = total;
        if (cursor !== undefined) {
          // 游标不是授权凭据：session 权限链已在 load 前完成；这里只校验历史一致性。
          const index = cursor.index;
          if (index > total) historyChanged();
          const anchor = all[index - 1];
          if (anchor === undefined) historyChanged();
          if (
            (anchor.timestamp ?? -1) !== cursor.timestamp ||
            anchor.content.length !== cursor.length ||
            anchor.role !== cursor.role
          ) {
            historyChanged();
          }
          end = index;
          start = Math.max(0, index - (requestedLimit ?? DEFAULT_MESSAGE_LIMIT));
        } else if (requestedLimit !== undefined) {
          start = Math.max(0, total - requestedLimit);
        }

        const windowAnchor = start > 0 ? all[start - 1] : undefined;
        // 0.54（additive 投影卡）：两分支判定**在切片之前**对落盘全量 `all` 跑一遍 ——
        // 窗口切掉 owning assistant 时，`formatClearedToolResult` 会丢掉工具名与首参摘要
        //（spec §1.4 陷阱 3）。`projection_summary` 也由此累加（整会话口径，不是本窗口）。
        const projections = scanProjections(all, state);
        // 0.52：出站窗口与实时流统一 8 KiB 口径（`role==='tool'` 的 content 与
        // assistant 工具入参）。**在游标之后裁**：`next_before` 的 `length` 取自
        // 未裁剪的 `windowAnchor.content.length`，翻页校验才不会被裁剪改写。
        //
        // 消息身份（additive `run_id` / `run_segment` / `message_id`）**原样透出**：它们由
        // core 在写入时盖上（`withRunIdentity` / `withMessageId`），本方法只读库里的那一份，
        // 不派生、不回填。`message_id` 是 0.56 的稳定 id：前端按它把「实时气泡」与「落盘
        // 消息」归并成一条（不再靠正文相等猜）。缺这些字段 = 旧数据 / 旧 gateway，客户端
        // 退回内容比较（见 `apps/web/src/gateway/types/sessions.ts` 的 `Message` 注释）。
        // `bindings` / `owner` 在下面与其余派生值一起并发取（见 Promise.all）。
        const window = capToolMessages(all.slice(start, end));
        // 0.56：图片投递状态挂在**裁剪之后**的窗口上（独立小字段，与 8 KiB 裁剪无关）。
        const projected = attachProjections(window, projections, start);
        // 0.57（性能）：**只有窗口里真有「要按 sha8 查事实」的图，才值得去折事件日志**。
        //
        // `imageDelivery` 的唯一去处是 `attachImageDelivery` 里的 `facts.get(sha8)`：
        // 窗口里没有 `kind:'image'` + 有 `sha256` 的引用时，那个映射一个字段都产不出来
        // （没有 `sha256` 的旧引用只用常量 `not_ingested`，同样不读 facts）。所以跳过的
        // **输出逐字节相同**，而省掉的是「首次查要整份折一遍事件日志」：
        // `09f82ac6`（12.6 万事件）实测 28.7 s，折完却是一张空表（该会话全日志里
        // `image.sent` / `context.image_dropped` 记录为 0）。真实 338 个会话里 337 个
        // 属于这种情况 —— 也就是说这条派生值此前对几乎每个会话都在做无用功。
        const needsImageFacts = projected.some((message) =>
          message.refs?.some((ref) => ref.kind === 'image' && typeof ref.sha256 === 'string'),
        );
        // Additive：会话级用量（历史会话 / rotate 后 / 重启后都可用）、「模型这一轮看到的
        // 系统消息」、事件日志游标（0.53：与 `sessions.events` 配成一对 ——
        // `derived_upto_seq < last_seq` ⇒ 有事件没进投影，客户端据此决定要不要补洞）三个
        // 派生值互不依赖，并发取；读不到 = 字段缺省（不抛错）。图片投递状态按上一段的判据
        // 才取（否则整段跳过）。
        const [contextUsage, systemContext, imageDelivery, eventCursor, bindings, latest] =
          await Promise.all([
            contextUsageOf(state.session_id),
            systemContextOf(state.session_id),
            needsImageFacts ? imageDeliveryOf(state.session_id) : undefined,
            eventCursorOf(state.session_id),
            sessionAgentBindings(),
            latestLoading,
          ]);
        const owner = bindings.get(state.session_id);
        const withImages =
          imageDelivery === undefined ? projected : attachImageDelivery(projected, imageDelivery);
        return {
          ...(owner === undefined ? {} : { agent: owner }),
          session: {
            ...toSessionView(state, latest),
            ...(contextUsage !== undefined ? { context_usage: contextUsage } : {}),
            ...(systemContext !== undefined ? { system_context: systemContext } : {}),
            ...(eventCursor !== undefined ? { event_cursor: eventCursor } : {}),
            messages: withImages,
            // sparse：一条都没被投影 ⇒ 不带这个字段（与今天逐字节相同）。
            ...(projections.summary.total > 0 ? { projection_summary: projections.summary } : {}),
            messages_total: total,
            ...(windowAnchor !== undefined
              ? {
                  next_before: encodeMessageCursor({
                    index: start,
                    timestamp: windowAnchor.timestamp ?? -1,
                    length: windowAnchor.content.length,
                    role: windowAnchor.role,
                  }),
                }
              : {}),
          },
        };
      },
    },
    {
      // Additive（0.53）：读会话事件日志 —— 复用 `sessions.get.event_cursor` 的同一份
      // 磁盘事实，按 `seq` 翻页回放，形状与 SSE 回放的事件对象一一对应，前端按 `seq`
      // 幂等合并。设计出处：`docs/specs/refresh-gap-design.md` §3 方案 B。
      name: 'sessions.events',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['session_id'],
        properties: {
          session_id: { type: 'string', minLength: 1, maxLength: 256 },
          // **排他**游标：只回 seq > since_seq；缺省 = 0（从头）。分页/补洞都靠它，
          // 客户端把上一页的 next_seq 原样传回来即可，不重不漏。
          since_seq: { type: 'integer', minimum: 0, maximum: MAX_SAFE_SEQ },
          // 默认 100、硬顶 2000（0.57 起；同 sessions.get.message_limit / events.list 风格）。
          limit: { type: 'integer', minimum: 1, maximum: MAX_SESSION_EVENTS_LIMIT },
          // 事件类型过滤；`tool.*` 这种 `*` 后缀 = 前缀匹配（同 events.subscribe）。
          types: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            maxItems: MAX_SESSION_EVENTS_TYPES,
          },
          // 0.53 U3（additive）：只回携带这个工具调用 id 的事件 —— 归档卡上「按 call id
          // 读回原文」那条指引的落点（`data.tool_call_id` 精确匹配，与 `types` 取交集）。
          tool_call_id: { type: 'string', minLength: 1, maxLength: 256 },
        },
      },
      result_schema: {
        type: 'object',
        required: ['events', 'next_seq', 'has_more'],
        properties: {
          events: { type: 'array', items: sessionEventSchema },
          // 已处理到的位置（排他游标）：下次作 since_seq 传回。没溢出时可能大于最后
          // 一条返回事件的 seq —— 中间的记录被 types 过滤掉了。
          next_seq: { type: 'integer', minimum: 0 },
          // 日志文件尾的最新 seq（本次读取之后重读一次）：has_more=false 且
          // next_seq < latest_seq 说明尾部有坏行/刚被追加，客户端按间隔再轮询。
          latest_seq: { type: 'integer', minimum: 0 },
          has_more: { type: 'boolean' },
        },
      },
      handler: async (params) => {
        const sessionId = stringParam(params, 'session_id');
        const backend = requireSession();
        // 存在性 / 授权与 sessions.get 走同一条口径（不额外开一个越权读盘口子）。
        // 0.56：这条路径**不读壳**（时间线是唯一读源），存在性只值一次 stat。
        const exists = await sessionExists(backend, sessionId);
        if (!exists) {
          throw new RpcError('not_found', 'Session not found');
        }
        const sinceSeq = parseSinceSeq(params.since_seq);
        const limit = parseSessionEventsLimit(params.limit);
        const types = parseSessionEventTypes(params.types);
        const toolCallId = parseToolCallId(params.tool_call_id);
        // 0.54 B1/C（ADR-105 §6 单游标）：`sessions.events` 的**唯一**读源是时间线。
        //
        // 为什么必须切：写者迁到时间线之后，旧事件日志不再增长。时间线里 17 万条的会话，
        // 旧日志可能只有几千条 —— 客户端按 `event_cursor.wal_head` 声明 1..174404 的区间去拉，
        // 只拿到 1..2855，于是报「1–174404 这一段读不回」。这不是数据问题，是读源没切。
        //
        // 0.54 C 删掉的两条回退（都是迁移窗口的过渡件，全库会话迁完之后没有读者）：
        // - `timeline.read_from = 'legacy'` 开关（回退上限 48 小时，已过期）；
        // - 事件日志分支（0.55 起旧格式会话连读都不支持：`legacy-format.ts` 抛
        //   `legacy_session_unsupported`，由 `deps.timelineHeads.lookup` 冒泡上来）。
        const timelinePort = deps.timelineRead;
        if (timelinePort === undefined) {
          // 与 `compact_unavailable` 同思路：能力没注入就是没注入，不假装空日志、
          // 也不悄悄退回旧源（那会让 `seq` 语义在两种编号之间跳）。
          throw new RpcError('not_supported', 'Session timeline is not configured');
        }
        // `heads` 缺省（新会话还没写过任何事件）⇒ 空段，不是错误：见
        // `EMPTY_TIMELINE_HEADS` 的注释。旧格式会话在这里抛 `legacy_session_unsupported`
        // （core 读口判的），原样升级成协议错误码 —— 不报空页。
        let timelineHeads: Awaited<ReturnType<NonNullable<typeof deps.timelineHeads>['lookup']>>;
        try {
          timelineHeads = await deps.timelineHeads?.lookup(sessionId);
        } catch (error) {
          if (isLegacySessionUnsupported(error)) {
            throw new MethodError(
              'legacy_session_unsupported',
              legacySessionUnsupportedMessage(error),
            );
          }
          throw error;
        }
        return readTimelineEventPage(
          timelinePort,
          sessionId,
          timelineHeads ?? EMPTY_TIMELINE_HEADS,
          sinceSeq,
          limit,
          types,
          toolCallId,
        );
      },
    },
    {
      name: 'sessions.composition',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['session_id'],
        properties: {
          session_id: { type: 'string', minLength: 1, maxLength: 256 },
          // 回看最近几次请求的组成快照（新 → 旧）；缺省 1 = 只看最近一次。
          limit: { type: 'integer', minimum: 1, maximum: MAX_COMPOSITION_SNAPSHOTS },
        },
      },
      result_schema: {
        type: 'object',
        required: ['snapshots'],
        properties: {
          snapshots: {
            type: 'array',
            items: {
              type: 'object',
              required: ['total_tokens', 'message_count', 'components'],
              properties: {
                at: { type: 'number' },
                run_id: { type: 'string' },
                attempt: { type: 'integer', minimum: 1 },
                model: { type: 'string' },
                total_tokens: { type: 'integer', minimum: 0 },
                corrected_tokens: { type: 'integer', minimum: 0 },
                context_max: { type: 'integer', minimum: 1 },
                message_count: { type: 'integer', minimum: 0 },
                components: {
                  type: 'object',
                  additionalProperties: {
                    type: 'object',
                    required: ['tokens', 'count', 'share'],
                    properties: {
                      tokens: { type: 'integer', minimum: 0 },
                      count: { type: 'integer', minimum: 0 },
                      share: { type: 'number', minimum: 0, maximum: 1 },
                    },
                  },
                },
                cleared_original_tokens: { type: 'integer', minimum: 0 },
                cleared_saved_tokens: { type: 'integer', minimum: 0 },
              },
            },
          },
        },
      },
      handler: async (params) => {
        const sessionId = stringParam(params, 'session_id');
        const backend = requireSession();
        // 存在性 / 授权与 sessions.get / sessions.events 同一条口径。
        const exists = await sessionExists(backend, sessionId);
        if (!exists) {
          throw new RpcError('not_found', 'Session not found');
        }
        const port = deps.composition;
        if (port === undefined) {
          // 能力没注入就是没注入（同 sessions.events 的 timelineRead 口径）。
          throw new RpcError('not_supported', 'Session composition is not configured');
        }
        const rawLimit = params.limit;
        const limit =
          typeof rawLimit === 'number' && Number.isFinite(rawLimit)
            ? Math.min(Math.max(Math.floor(rawLimit), 1), MAX_COMPOSITION_SNAPSHOTS)
            : 1;
        const snapshots = await port.lookup(sessionId, limit);
        return { snapshots };
      },
    },
    {
      name: 'sessions.search',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 256 },
          limit: { type: 'integer', minimum: 1, maximum: MAX_SESSION_SEARCH_LIMIT },
        },
      },
      result_schema: {
        type: 'object',
        required: ['sessions'],
        properties: {
          sessions: { type: 'array', items: sessionSearchHitSchema },
        },
      },
      handler: async (params) => {
        const query = normalizeSearchQuery(params.query);
        if (query === null) {
          throw new RpcError('invalid_params', 'query must be 1..256 characters');
        }
        const limit = parseSearchLimit(params.limit);
        if (limit === null) {
          throw new RpcError(
            'invalid_params',
            `limit must be an integer between 1 and ${MAX_SESSION_SEARCH_LIMIT}`,
          );
        }
        const backend = requireSession();
        try {
          return { sessions: await searchSessions(backend, query, limit) };
        } catch (error) {
          mapTenantError(error);
        }
      },
    },
    {
      name: 'sessions.delete',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['session_id'],
        properties: { session_id: { type: 'string', minLength: 1 } },
      },
      result_schema: {
        type: 'object',
        required: ['sessions_deleted', 'runs_deleted', 'events_deleted'],
        properties: {
          sessions_deleted: { type: 'integer' },
          runs_deleted: { type: 'integer' },
          events_deleted: { type: 'integer' },
        },
      },
      handler: async (params) => {
        if (!sessionData) {
          throw new RpcError('internal', 'deleteSessionData is not configured');
        }
        try {
          return await sessionData.deleteSessionData(stringParam(params, 'session_id'));
        } catch (error) {
          mapTenantError(error);
        }
      },
    },
    {
      name: 'sessions.rename',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['session_id', 'title'],
        properties: {
          session_id: { type: 'string', minLength: 1 },
          title: { type: 'string', maxLength: 512 },
        },
      },
      result_schema: {
        type: 'object',
        required: ['session_id', 'title'],
        properties: {
          session_id: { type: 'string' },
          title: { type: 'string' },
        },
      },
      handler: async (params) => {
        const backend = requireSession();
        const sessionId = stringParam(params, 'session_id');
        const title = stringParam(params, 'title');
        const state = await backend.load(sessionId);
        if (!state) throw new RpcError('not_found', 'Session not found');
        // Human rename marks the title as manual: automatic AI naming must never
        // overwrite it again (SessionState.title_source, additive).
        await backend.save({
          ...state,
          title,
          title_source: 'manual',
          updated_at: Date.now(),
        });
        return { session_id: sessionId, title };
      },
    },
    {
      // CONTRACT-0.34-context C7：手动压缩。远程 / connect 走本方法；
      // 本地 TUI 直接经 ExecutionUnit.compactContext。
      name: 'sessions.compact',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['session_id'],
        properties: { session_id: { type: 'string', minLength: 1 } },
      },
      result_schema: {
        type: 'object',
        required: ['removed', 'remaining', 'reason'],
        properties: {
          removed: { type: 'integer', minimum: 0 },
          remaining: { type: 'integer', minimum: 0 },
          reason: { type: 'string', enum: ['manual'] },
        },
      },
      handler: async (params) => {
        const backend = requireSession();
        const sessionId = stringParam(params, 'session_id');
        // 0.56：这条路径拿到的 `state` 只用来判存在，压缩本身按 session id 干活
        // ⇒ 不再 parse 整份壳（一次 stat 就够）。
        const exists = await sessionExists(backend, sessionId);
        if (!exists) throw new RpcError('session_not_found', 'Session not found');

        const runtime = compactRuntime?.() as { compactContext?: CompactContextFn } | undefined;
        const compactContext = runtime?.compactContext;
        if (typeof compactContext !== 'function') {
          throw new RpcError('compact_unavailable', 'Context compaction is not available');
        }

        try {
          const result = await compactContext.call(runtime, sessionId);
          return {
            removed: result.removed,
            remaining: result.remaining,
            reason: 'manual' as const,
          };
        } catch (error) {
          // runtime 门面把“没有 live EU / 无方法”也报成 compact_unavailable；
          // 其它错误原样抛给 dispatcher（内部错误不伪装成不可用）。
          if (isCompactUnavailable(error)) {
            throw new RpcError('compact_unavailable', 'Context compaction is not available');
          }
          throw error;
        }
      },
    },
    {
      /**
       * `sessions.create`（CREATE-0.39 §2，write）：同一 agent 的新 session 成为
       * 唯一 primary；无来源 = 空 session，有来源 = 复制 / 压缩前缀。
       *
       * `mode=both` 的 git restore 由注入的 `restoreFiles` 在切换 session 前执行；
       * 未注入 = `not_supported`，不会静默忽略文件。
       */
      name: 'sessions.create',
      permission: 'write',
      params_schema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', minLength: 1 },
          from_session_id: { type: 'string', minLength: 1 },
          seed: { type: 'string', enum: ['copy', 'compact'] },
          keep_messages: { type: 'integer', minimum: 0 },
          startup_prompt: { type: 'string', minLength: 1 },
          /** Additive (title_source): human name for the new session, max 120 chars. */
          title: { type: 'string', minLength: 1, maxLength: 120 },
          mode: { type: 'string', enum: ['conversation', 'both'] },
          /**
           * 0.53 U1（ADR-104 §8.3，additive）：新会话的上下文投射模式。
           *
           * 不传 = 默认 `placeholder`（用户口径）；`passthrough` 是手动 opt-in 的逃生门。
           * 词表校验在 agent 层（`declareProjection`）：未知值 ⇒
           * `projection_declaration_invalid`，`externalize` ⇒ `projection_mode_unavailable`，
           * 子不能放松父 ⇒ `projection_mode_not_allowed`。
           */
          projection_mode: { type: 'string', minLength: 1 },
          files: {
            type: 'object',
            required: ['ref', 'paths'],
            properties: {
              ref: { type: 'string', minLength: 1 },
              paths: { type: 'array', items: { type: 'string', minLength: 1 } },
            },
          },
        },
      },
      result_schema: sessionCreateResultSchema,
      handler: async (params, ctx) => {
        const control = requireSessionAgentControl(agent);
        const fromSessionId = optionalString(params.from_session_id);
        const agentId = optionalString(params.agent_id);
        const seed = readCreateSeed(params.seed);
        const keepMessages = readKeepMessages(params.keep_messages);
        const startupPrompt = optionalString(params.startup_prompt);
        // Additive: trimmed here; blank / over-long titles are rejected, never truncated.
        const title = optionalString(params.title)?.trim();
        if (title === '') {
          throw new RpcError('invalid_params', 'title must not be blank');
        }
        const mode = readSessionMode(params.mode);
        const files = readSessionFiles(params.files);
        // 0.53 U1（ADR-104）：投射模式在这里**只做词表校验**（拿到 RPC 就拒，别等到
        // agent 层才发现）；不可用 / 收窄的判定与拒绝码全部收口在 agent 层的
        // `declareProjection` + `assertProjectionModeAllowedForChild`。
        const projectionMode = readProjectionMode(params.projection_mode);

        if (fromSessionId === undefined) {
          if (seed !== undefined || keepMessages !== undefined) {
            throw new RpcError('invalid_params', 'seed / keep_messages require from_session_id');
          }
          if (mode !== undefined || files !== undefined) {
            throw new RpcError('invalid_params', 'mode / files require from_session_id');
          }
          if (agentId === undefined) {
            throw new RpcError('invalid_params', 'agent_id is required without from_session_id');
          }
        }
        if (mode === 'both' && files === undefined) {
          throw new RpcError('invalid_params', 'files is required when mode=both');
        }

        // CREATE-0.39 §2.2：wire `keep_messages` 是 `sessions.get().messages` 下标；
        // agent 层 `buildSeed` 用 `projectMessages(events)` 下标（不含 base system）。
        // 先按 wire 数组校验，再换算成投影下标传给服务；响应回填原始 wire 值。
        let projectedKeep = keepMessages;
        if (fromSessionId !== undefined && keepMessages !== undefined) {
          const backend = sessionFor();
          if (!backend) {
            throw new RpcError('internal', 'session store is not configured for keep_messages');
          }
          const state = await backend.load(fromSessionId);
          if (state === null) throw new RpcError('session_not_found', 'Session not found');
          const messages = state.messages ?? [];
          if (keepMessages > messages.length) {
            throw new RpcError(
              'invalid_params',
              `keep_messages out of range: ${keepMessages} > ${messages.length}`,
            );
          }
          projectedKeep = projectedKeepCount(messages, keepMessages);
        }

        // team-scoped control token：只能操作同 team 的成员。
        const scope = teamScopeOf(ctx);
        if (scope !== undefined) {
          const target = fromSessionId ?? agentId;
          if (target === undefined || !(await inTeamScope(control, scope, target))) {
            throw new RpcError('not_found', `agent not found: ${target ?? ''}`);
          }
        }

        let restored: { files_restored: number; files_skipped: number } | undefined;
        if (mode === 'both') {
          const restore = control.restoreFiles;
          if (typeof restore !== 'function') {
            throw new RpcError('not_supported', 'git restore is not available');
          }
          const sourceId = fromSessionId as string;
          const source = await control.resolve(sourceId);
          if (source === undefined) {
            throw new RpcError('session_not_found', 'Session not found');
          }
          try {
            // 硬失败在 session 改动前中止；单路径失败由 asm 端口计入 files_skipped。
            restored = await restore.call(control, {
              agent_id: source.id,
              session_id: sourceId,
              files: files as { ref: string; paths: string[] },
            });
          } catch (error) {
            mapSessionControlError(error);
          }
        }

        const input: SessionCreateLikeInput = {
          ...(agentId !== undefined ? { agent_id: agentId } : {}),
          ...(fromSessionId !== undefined ? { from_session_id: fromSessionId } : {}),
          ...(seed !== undefined ? { seed } : {}),
          ...(projectedKeep !== undefined ? { keep_messages: projectedKeep } : {}),
          ...(startupPrompt !== undefined ? { startup_prompt: startupPrompt } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(mode !== undefined ? { mode } : {}),
          ...(files !== undefined ? { files } : {}),
          ...(projectionMode !== undefined ? { projection_mode: projectionMode } : {}),
        };

        try {
          const result = await control.createSession(input);
          return {
            ...result,
            // 响应里的 keep_messages 保持 wire 语义（SessionState 下标）；
            // keep_projected 仍是 agent 层实际使用的投影边界。
            ...(keepMessages !== undefined ? { keep_messages: keepMessages } : {}),
            ...(restored !== undefined
              ? {
                  files_restored: restored.files_restored,
                  files_skipped: restored.files_skipped,
                }
              : {}),
          };
        } catch (error) {
          mapSessionControlError(error);
        }
      },
    },
    {
      /**
       * `sessions.restart`（CREATE-0.39 §3，write）：同一 session 原地换 binding
       * （epoch+1）；transcript / SessionState 不变。失败回滚由 agent 层保证。
       */
      name: 'sessions.restart',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['session_id'],
        properties: {
          session_id: { type: 'string', minLength: 1 },
          startup_prompt: { type: 'string', minLength: 1 },
        },
      },
      result_schema: sessionRestartResultSchema,
      handler: async (params) => {
        const control = requireSessionAgentControl(agent);
        const sessionId = stringParam(params, 'session_id');
        const startupPrompt = optionalString(params.startup_prompt);
        const input: SessionRestartLikeInput = {
          session_id: sessionId,
          ...(startupPrompt !== undefined ? { startup_prompt: startupPrompt } : {}),
        };
        try {
          return await control.restartSession(input);
        } catch (error) {
          mapSessionControlError(error);
        }
      },
    },
    {
      /**
       * `sessions.activate`（CREATE-0.39 §4，write）：把 primary / bindingHistory 中
       * 的 session 切回 primary；目标已是 primary 时 `noop: true`。
       */
      name: 'sessions.activate',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['session_id'],
        properties: {
          session_id: { type: 'string', minLength: 1 },
          startup_prompt: { type: 'string', minLength: 1 },
        },
      },
      result_schema: sessionActivateResultSchema,
      handler: async (params) => {
        const control = requireSessionAgentControl(agent);
        const sessionId = stringParam(params, 'session_id');
        const startupPrompt = optionalString(params.startup_prompt);
        const input: SessionActivateLikeInput = {
          session_id: sessionId,
          ...(startupPrompt !== undefined ? { startup_prompt: startupPrompt } : {}),
        };
        try {
          return await control.activateSession(input);
        } catch (error) {
          mapSessionControlError(error);
        }
      },
    },
  ];
}
