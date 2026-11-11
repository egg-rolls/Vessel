/**
 * sessions.* 方法（list / get / search / delete / rename）。
 *
 * @module @vessel-agent/serve
 */

import { projectedKeepCount, type SessionState, type SessionStore } from '@vessel-agent/core';
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
import { runStateSchema, sessionInfoSchema, sessionSearchHitSchema } from './schemas.js';

/** run 记录的最小读取面（gateway 只需要按 run_id 取最近一条）。 */
export interface SessionRunLookup {
  load(runId: string): Promise<unknown>;
}

/**
 * 会话级上下文用量（`sessions.get.context_usage`，additive）。
 *
 * `used` = 该会话最近一次真实用量；`max` 缺省 = 上下文窗口未知（客户端据此不画
 * 比例）；`at` = 那条事件的 `ts`；`source` = 这个数字是谁给的（自查用）。
 * **整字段缺省 = 没有可用数据**，不写 0、不写 null。
 */
export interface SessionContextUsage {
  used: number;
  max?: number;
  at?: number;
  source?: 'pressure' | 'changed' | 'estimated' | 'prompt';
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
 * `context_usage` 的每会话缓存（键 = session + **事件日志尾水位**）。
 *
 * 取值时机：Web 在页面加载 / 切会话 / 重连（epoch 变化）时取一次 `sessions.get`，
 * run 期间另有 5s 的 `agents.tree` 轮询（live 优先，见 `useChatTranscript`）；
 * 缓存让「同一份日志被反复问」不变成反复读盘。
 * - 水位没变 → 直接命中，**0 字节读盘**，只花一次 `stat`；
 * - 水位变了（有新事件）→ 重读一次尾窗：正常命中 **64 KiB**；该会话尾部确实没有
 *   用量事件时按 64K→256K→1M→4M 扩窗，一次 miss 累计最多 **≈5.3 MiB**
 *   （见 `SessionEventLog.readTailMatches`），且不会退化成全量扫盘。
 * 失效只按水位（不设时间 TTL）：append-only 日志上「水位相同 ⇒ 结果相同」是确定的，
 * 时间到期只会制造一次无用读。
 */
const CONTEXT_USAGE_CACHE_LIMIT = 256;

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
  };
}

export function createSessionMethods(deps: SessionMethodsDeps): RpcMethodDefinition[] {
  const { sessionFor, runStoreFor, sessionData, compactRuntime, agent } = deps;

  // ── 会话级上下文用量（additive `context_usage`）──
  // 缓存只按 **session + 事件日志尾水位** 失效：日志 append-only ⇒ 水位不变时
  // 派生结果不可能变（0 字节读盘，只花一次 stat），水位变了才重读尾窗。
  // 派生逻辑与读盘位置都在注入的 `contextUsage` 端口里 —— serve 不认识 data-dir。
  const contextUsageCache = new Map<
    string,
    { watermark: string | undefined; value: SessionContextUsage | undefined }
  >();

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
      source === 'prompt'
        ? { source }
        : {}),
    };
  }

  async function contextUsageOf(sessionId: string): Promise<SessionContextUsage | undefined> {
    const port = deps.contextUsage;
    if (port === undefined) return undefined;

    let watermark: string | undefined;
    let value: SessionContextUsage | undefined;
    try {
      watermark = await port.watermark(sessionId);
      const cached = contextUsageCache.get(sessionId);
      if (cached !== undefined && cached.watermark === watermark) return cached.value;
      // 没有事件日志（水位 undefined）= 这个会话还没落过任何事件，不必再开文件。
      value =
        watermark === undefined ? undefined : normalizeContextUsage(await port.lookup(sessionId));
    } catch {
      // 用量是观测性字段：读盘 / stat 失败不能把 `sessions.get` 一起打成 internal。
      // 按「没有数据」处理（客户端不画环），下次水位变化时自然重试。
      return undefined;
    }

    if (!contextUsageCache.has(sessionId) && contextUsageCache.size >= CONTEXT_USAGE_CACHE_LIMIT) {
      const oldest = contextUsageCache.keys().next().value;
      if (oldest !== undefined) contextUsageCache.delete(oldest);
    }
    contextUsageCache.set(sessionId, { watermark, value });
    return value;
  }

  function requireSession(): SessionStore {
    const resolved = sessionFor();
    if (!resolved) {
      throw new RpcError('not_found', 'No session backend configured');
    }
    return resolved;
  }

  async function listSessions(): Promise<{ sessions: unknown[] }> {
    const backend = sessionFor();
    if (!backend) {
      throw new MethodError('no_session', 'No session backend configured');
    }
    return { sessions: await backend.listRich() };
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
        properties: { session: runStateSchema },
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
        // Additive：会话级用量（历史会话 / rotate 后 / 重启后都可用）。读不到 = 字段缺省。
        const contextUsage = await contextUsageOf(state.session_id);
        // 0.52：出站窗口与实时流统一 8 KiB 口径（`role==='tool'` 的 content 与
        // assistant 工具入参）。**在游标之后裁**：`next_before` 的 `length` 取自
        // 未裁剪的 `windowAnchor.content.length`，翻页校验才不会被裁剪改写。
        return {
          session: {
            ...toSessionView(state, latest),
            ...(contextUsage !== undefined ? { context_usage: contextUsage } : {}),
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
