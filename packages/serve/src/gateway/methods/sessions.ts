/**
 * sessions.* 方法（list / get / search / delete / rename）。
 *
 * @module @vessel-agent/serve
 */

import {
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
import { capToolMessages } from '../../tool-events.js';
import { MethodError } from '../errors.js';
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
 * 会话事件游标（additive `sessions.get.event_cursor`，0.53）。
 *
 * 两个数是**不同**的东西，别混（前端据此决定“要不要补洞、从哪儿补”）：
 * - `last_seq` = 事件日志里最后一条事件的 `seq`（从文件尾定边界，不依赖索引）；
 * - `derived_upto_seq` = 元数据派生**覆盖到**的 `seq`（`index.json`）：它 `< last_seq`
 *   说明还有事件没进会话投影（正跑 / 刚崩 / 派生失败重试中）。
 *
 * 整字段缺省 = 这个会话**还没有事件日志**（一条都没落过），不是 0、不是 null。
 * `event_count` 与 `derived_upto_seq` 同源（`index.json`），索引缺失/损坏时一起缺省——
 * 此时 `last_seq` 仍然给（文件尾定边界不依赖索引）。
 */
export interface SessionEventCursor {
  last_seq: number;
  derived_upto_seq?: number;
  event_count?: number;
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
   * 会话级「模型这一轮看到了什么系统消息」（additive `system_context`）：由装配层从
   * **事件日志尾窗**派生（进程重启 / 回放窗口淘汰之后仍然能拿到 —— 事件不是 message，
   * `messages` 里永远没有它）。
   *
   * 缺省 = `sessions.get` 不带该字段（旧行为一字不改、不抛错）。serve 不拼磁盘路径、
   * 不读盘：读取面（`SessionEventLog` 所在的 data-dir）由 app 侧注入。
   */
  systemContext?: SessionSystemContextPort;
  /**
   * 会话事件日志的读端口（0.53：additive `sessions.events` + `sessions.get.event_cursor`）。
   *
   * 缺省 = `sessions.events` 返回 `not_supported`、`sessions.get` 不带 `event_cursor`
   * （旧行为一字不改、不抛错）。serve 不拼磁盘路径、不读盘：读取面
   * （`SessionEventLog` 所在的 data-dir）由 app 侧注入（见 `src/session-events.ts`）。
   */
  sessionEvents?: SessionEventsPort;
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
 * 同一个风格 —— 默认 100、硬顶 500，超限按游标翻页，不一次性把日志塞进一帧。
 */
const DEFAULT_SESSION_EVENTS_LIMIT = 100;
const MAX_SESSION_EVENTS_LIMIT = 500;
/**
 * 带 `types` 过滤时每次向磁盘要的**块**大小（游标推进的步长，不是响应上限）：
 * 过滤可能整块都不中，所以块比页大；响应仍然只回 `limit` 条。
 */
const SESSION_EVENTS_READ_CHUNK = 500;
/**
 * 单次请求最多扫多少条落盘事件（`types` 全不中时的安全阀）：
 * 到顶就 `has_more: true` 让客户端继续翻页，宁可变慢也不让一次 RPC 卡死读整份日志。
 */
const SESSION_EVENTS_MAX_SCAN = 20_000;
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

/** `types` 过滤（缺省 = 不过滤）；`*` 后缀 = 前缀，其余精确。 */
function matchesEventTypes(types: readonly string[] | undefined, type: string): boolean {
  if (types === undefined) return true;
  for (const pattern of types) {
    if (pattern.endsWith('*')) {
      if (type.startsWith(pattern.slice(0, -1))) return true;
    } else if (type === pattern) {
      return true;
    }
  }
  return false;
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
  return {
    last_seq: Math.floor(lastSeq),
    ...(derived === undefined || derived < 0 ? {} : { derived_upto_seq: Math.floor(derived) }),
    ...(count === undefined || count < 0 ? {} : { event_count: Math.floor(count) }),
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
    if (port === undefined) return undefined;
    return {
      lookup: async (sessionId) => {
        const lastSeq = await port.lastSeq(sessionId);
        if (lastSeq === undefined) return undefined;
        const derived = await port.cursor(sessionId);
        return {
          last_seq: lastSeq,
          ...(derived === undefined
            ? {}
            : { derived_upto_seq: derived.derived_upto_seq, event_count: derived.event_count }),
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

  /**
   * 读一页事件：**按游标分块**，不把整份日志一次读进内存。
   *
   * - 无 `types`：`read(since_seq, limit + 1)` 一次搞定 —— 多要一条就是 `has_more` 的证据，
   *   不再单独读一遍日志尾（避免「两次边界不一致」：读到一半又被追加）。
   * - 有 `types`：按 `SESSION_EVENTS_READ_CHUNK` 推进游标扫块，凑够 `limit + 1` 就停；
   *   扫到 `SESSION_EVENTS_MAX_SCAN` 还没够 → `has_more: true` 让客户端接着翻页
   *   （宁可变慢也不让一次 RPC 把整份日志扫穿）。
   *
   * `next_seq` 是**已处理到的位置**（排他游标）：没溢出时它可能大于最后一条返回事件的
   * `seq`（中间那些被 `types` 过滤掉了）；一旦多拿到一条（溢出），游标必须停在**返回的
   * 最后一条**上 —— 否则翻页会丢事件。
   *
   * 注意（core 现状，写清楚免得被误读成 O(limit)）：`SessionEventLog.read()` 内部会从
   * 游标附近定位起点、把**剩余记录流一遍**、按 `seq` 排序后再截断 —— 多写者可能把行写乱，
   * 早停不安全。所以单次 `read()` 的峰值内存仍是「游标之后剩下的记录」。本函数保证的是
   * 响应只回 `limit` 条、页与页之间靠游标推进、同一段不重复解析，不把整份日志塞进一帧；
   * 要严格 O(limit) 的峰值需要 core 提供带序保证的分块读（follow-up，不在本单）。
   */
  async function readEventPage(
    port: SessionEventsPort,
    sessionId: string,
    sinceSeq: number,
    limit: number,
    types: readonly string[] | undefined,
  ): Promise<{ events: SessionEventView[]; nextSeq: number; hasMore: boolean }> {
    const wanted = limit + 1;
    const events: SessionEventView[] = [];
    let cursor = sinceSeq;
    let scanned = 0;
    let truncated = false;
    for (;;) {
      // 不过滤时只要「还差几条 + 1」；过滤时按固定步长推游标（整块可能全不中）。
      const chunkSize = types === undefined ? wanted - events.length : SESSION_EVENTS_READ_CHUNK;
      if (chunkSize < 1) break;
      const chunk = await port.read(sessionId, { sinceSeq: cursor, limit: chunkSize });
      if (chunk.length === 0) break;
      let consumed = cursor;
      for (const event of chunk) {
        consumed = event.seq;
        scanned += 1;
        if (!matchesEventTypes(types, event.type)) continue;
        events.push(event);
        if (events.length >= wanted) break;
      }
      // 游标只推到「真正读过的那一条」：chunk 内的记录按 seq 升序。
      cursor = consumed;
      if (events.length >= wanted) break;
      if (chunk.length < chunkSize) break; // 日志到底了
      if (scanned >= SESSION_EVENTS_MAX_SCAN) {
        truncated = true;
        break;
      }
    }
    const overflow = events.length > limit;
    const page = overflow ? events.slice(0, limit) : events;
    const last = page.length > 0 ? page[page.length - 1] : undefined;
    const nextSeq = overflow ? (last === undefined ? sinceSeq : last.seq) : cursor;
    return { events: page, nextSeq, hasMore: overflow || truncated };
  }

  function requireSession(): SessionStore {
    const resolved = sessionFor();
    if (!resolved) {
      throw new RpcError('not_found', 'No session backend configured');
    }
    return resolved;
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
      const base = {
        id: member.id,
        ...(name === undefined ? {} : { name }),
        state: String(member.state ?? ''),
        ...(presence === undefined ? {} : { presence }),
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
        const state = await backend.load(stringParam(params, 'session_id'));
        if (!state) throw new RpcError('not_found', 'Session not found');
        const runStore = runStoreFor?.();
        const latest =
          runStore !== undefined && state.last_run_id !== undefined
            ? await runStore.load(state.last_run_id)
            : undefined;

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
        // Additive：会话级用量与「模型这一轮看到的系统消息」（历史会话 / rotate 后 /
        // 重启后都可用）。两个派生值互不依赖，并发取；读不到 = 字段缺省（不抛错）。
        const [contextUsage, systemContext] = await Promise.all([
          contextUsageOf(state.session_id),
          systemContextOf(state.session_id),
        ]);
        // Additive (0.53)：事件日志游标。与 `sessions.events` 配成一对 ——
        // `derived_upto_seq < last_seq` ⇒ 有事件没进投影，客户端据此决定要不要补洞。
        // 读不到（没有日志 / 端口未注入 / 索引坏了）= 字段缺省，**不抛错**。
        const eventCursor = await eventCursorOf(state.session_id);
        // 0.52：出站窗口与实时流统一 8 KiB 口径（`role==='tool'` 的 content 与
        // assistant 工具入参）。**在游标之后裁**：`next_before` 的 `length` 取自
        // 未裁剪的 `windowAnchor.content.length`，翻页校验才不会被裁剪改写。
        //
        // 消息身份（additive `run_id` / `run_segment`）**原样透出**：它们由 core 在落盘前
        // 盖上（`RunJournal.saveSessionState`），本方法只读库里的那一份，不派生、不回填。
        // 缺这两个字段 = 旧数据 / 旧 gateway，客户端退回内容比较（见
        // `apps/web/src/gateway/types/sessions.ts` 的 `Message` 注释）。
        const bindings = await sessionAgentBindings();
        const owner = bindings.get(state.session_id);
        return {
          ...(owner === undefined ? {} : { agent: owner }),
          session: {
            ...toSessionView(state, latest),
            ...(contextUsage !== undefined ? { context_usage: contextUsage } : {}),
            ...(systemContext !== undefined ? { system_context: systemContext } : {}),
            ...(eventCursor !== undefined ? { event_cursor: eventCursor } : {}),
            messages: capToolMessages(all.slice(start, end)),
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
      // 幂等合并。设计出处：`docs/dev/handoff/refresh-gap-design.md` §3 方案 B。
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
          // 默认 100、硬顶 500（同 sessions.get.message_limit / events.list 风格）。
          limit: { type: 'integer', minimum: 1, maximum: MAX_SESSION_EVENTS_LIMIT },
          // 事件类型过滤；`tool.*` 这种 `*` 后缀 = 前缀匹配（同 events.subscribe）。
          types: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            maxItems: MAX_SESSION_EVENTS_TYPES,
          },
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
        const port = deps.sessionEvents;
        if (port === undefined) {
          // 与 `compact_unavailable` 同思路：能力没注入就是没注入，别假装空日志。
          throw new RpcError('not_supported', 'Session event log is not configured');
        }
        const sessionId = stringParam(params, 'session_id');
        const backend = requireSession();
        // 存在性 / 授权与 sessions.get 走同一条口径（不额外开一个越权读盘口子）。
        const state = await backend.load(sessionId);
        if (!state) {
          throw new RpcError('not_found', 'Session not found');
        }
        const sinceSeq = parseSinceSeq(params.since_seq);
        const limit = parseSessionEventsLimit(params.limit);
        const types = parseSessionEventTypes(params.types);
        const page = await readEventPage(port, sessionId, sinceSeq, limit, types);
        // 边界只读一次（`lastSeq` = 文件尾 stat + 尾读，便宜）：与 `sessions.get.event_cursor`
        // 是同一个数，客户端可以拿它判断「已经追平了」。
        const latestSeq = await port.lastSeq(sessionId);
        const lastReturned =
          page.events.length > 0 ? page.events[page.events.length - 1] : undefined;
        return {
          events: page.events,
          next_seq: page.nextSeq,
          latest_seq: Math.max(latestSeq ?? 0, lastReturned === undefined ? 0 : lastReturned.seq),
          has_more: page.hasMore,
        };
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
        const state = await backend.load(sessionId);
        if (!state) throw new RpcError('session_not_found', 'Session not found');

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
