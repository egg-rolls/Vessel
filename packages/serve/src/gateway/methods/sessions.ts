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
import { mapTenantError, type TenantControlLike } from '../../tenant.js';
import { MethodError } from '../errors.js';
import { runInProgressReason, stringParam, tenantParamSchema } from './common.js';
import { runStateSchema, sessionInfoSchema, sessionSearchHitSchema } from './schemas.js';

/** run 记录的最小读取面（gateway 只需要按 run_id 取最近一条）。 */
export interface SessionRunLookup {
  load(runId: string): Promise<unknown>;
}

export interface SessionMethodsDeps {
  defaultTenantId: string;
  sessionFor(): SessionStore | undefined;
  /** 最近 RunRecord 的读取面；缺省时 `sessions.get` 只用 `legacy_run` 投影。 */
  runStoreFor?(): SessionRunLookup | undefined;
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
  /** CREATE-0.39：`sessions.create` 的 tenant 配额（`tenants.checkQuota`）。 */
  tenants?: TenantControlLike;
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

function requireSessionAgentControl(
  control: AgentControlLike | undefined,
  ctx: RpcMethodContext,
): AgentControlLike {
  if (!control || control.tenantId !== ctx.tenantId) {
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
    messages: state.messages ?? [],
    started_at: startedAt,
    ...(completedAt !== undefined ? { completed_at: completedAt } : {}),
    status,
    ...(usage !== undefined ? { usage } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(state.title !== undefined ? { title: state.title } : {}),
    ...(state.preview !== undefined ? { preview: state.preview } : {}),
    updated_at: updatedAt,
    ...(branch !== undefined ? { branch } : {}),
    ...(state.tenant_id !== undefined ? { tenant_id: state.tenant_id } : {}),
  };
}

export function createSessionMethods(deps: SessionMethodsDeps): RpcMethodDefinition[] {
  const { defaultTenantId, sessionFor, runStoreFor, sessionData, compactRuntime, agent, tenants } =
    deps;

  function requireSession(tenantId: string): SessionStore {
    const resolved = sessionFor();
    if (!resolved) {
      if (tenantId !== defaultTenantId) {
        throw new RpcError('forbidden', `Tenant session backend is not configured: ${tenantId}`);
      }
      throw new RpcError('not_found', 'No session backend configured');
    }
    return resolved;
  }

  async function listSessions(
    tenantId: string = defaultTenantId,
  ): Promise<{ sessions: unknown[] }> {
    const backend = sessionFor();
    if (!backend) {
      // 非 default tenant 未注入 session 后端 → 明确的 forbidden；default 保持旧语义。
      if (tenantId !== defaultTenantId) {
        throw new RpcError('forbidden', `Tenant session backend is not configured: ${tenantId}`);
      }
      throw new MethodError('no_session', 'No session backend configured');
    }
    return { sessions: await backend.listRich() };
  }

  return [
    {
      name: 'sessions.list',
      permission: 'read',
      params_schema: tenantParamSchema,
      result_schema: {
        type: 'object',
        required: ['sessions'],
        properties: {
          sessions: { type: 'array', items: sessionInfoSchema },
        },
      },
      handler: (_params, ctx) => listSessions(ctx.tenantId),
    },
    {
      name: 'sessions.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['session_id'],
        properties: { session_id: { type: 'string', minLength: 1 } },
      },
      result_schema: {
        type: 'object',
        required: ['session'],
        properties: { session: runStateSchema },
      },
      handler: async (params, ctx) => {
        const backend = requireSession(ctx.tenantId);
        const state = await backend.load(stringParam(params, 'session_id'));
        if (!state) throw new RpcError('not_found', 'Session not found');
        const runStore = runStoreFor?.();
        const latest =
          runStore !== undefined && state.last_run_id !== undefined
            ? await runStore.load(state.last_run_id)
            : undefined;
        return { session: toSessionView(state, latest) };
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
      handler: async (params, ctx) => {
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
        const backend = requireSession(ctx.tenantId);
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
      handler: async (params, ctx) => {
        if (!sessionData) {
          throw new RpcError('internal', 'deleteSessionData is not configured');
        }
        try {
          return await sessionData.deleteSessionData(
            stringParam(params, 'session_id'),
            ctx.tenantId,
          );
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
      handler: async (params, ctx) => {
        const backend = requireSession(ctx.tenantId);
        const sessionId = stringParam(params, 'session_id');
        const title = stringParam(params, 'title');
        const state = await backend.load(sessionId);
        if (!state) throw new RpcError('not_found', 'Session not found');
        await backend.save({ ...state, title, updated_at: Date.now() });
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
      handler: async (params, ctx) => {
        const backend = requireSession(ctx.tenantId);
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
        const control = requireSessionAgentControl(agent, ctx);
        const fromSessionId = optionalString(params.from_session_id);
        const agentId = optionalString(params.agent_id);
        const seed = readCreateSeed(params.seed);
        const keepMessages = readKeepMessages(params.keep_messages);
        const startupPrompt = optionalString(params.startup_prompt);
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

        // 配额：复用同名 tenant 操作 `sessions.create`。
        try {
          await tenants?.checkQuota?.(ctx.tenantId, 'sessions.create');
        } catch (error) {
          mapTenantError(error);
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
      handler: async (params, ctx) => {
        const control = requireSessionAgentControl(agent, ctx);
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
      handler: async (params, ctx) => {
        const control = requireSessionAgentControl(agent, ctx);
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
