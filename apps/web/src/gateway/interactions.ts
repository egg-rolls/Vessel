/**
 * 权限 / 提问交互的纯逻辑：过期时间、去重入队、not_found 判定与单次提交守卫。
 *
 * 过期时间必须由**事件时间**推导（`event.ts + TTL`），不能用浏览器收到事件的
 * `Date.now()`：重放/刷新后旧请求会被重新计时，点击时服务端已丢弃 → not_found。
 */
import { t } from '../i18n';
import type { AskUserRequest, PermissionRequest, PermissionScope, RunEvent } from './types';

/**
 * 历史上与 gateway interaction TTL 对齐的常量（DECISION-022 §2.1）。
 *
 * 0.18 起只用于旧数据 / 排序回推；ask 不再自动过期，权限请求本来就不按时间过期。
 */
export const INTERACTION_TTL_MS = 120_000;

/**
 * ask 的 `expiresAt` 哨兵：永不过期（0.18）。
 *
 * 保留 `expiresAt` 字段是为了不破坏既有类型（排序 / 旧数据兼容），
 * 但取值改为正无穷，`expireInteractions` 与 `isInteractionExpired` 都不会淘汰它。
 */
export const ASK_EXPIRES_AT_NEVER = Number.POSITIVE_INFINITY;

export interface Interaction {
  requestId: string;
  expiresAt: number;
}

/**
 * 事件时间 → 过期时间。缺失/非法 ts（旧 gateway）回退当前时间，避免丢掉实时请求。
 */
export function interactionExpiresAt(
  eventTs: unknown,
  ttl = INTERACTION_TTL_MS,
  fallbackNow = Date.now(),
): number {
  const base =
    typeof eventTs === 'number' && Number.isFinite(eventTs) && eventTs > 0 ? eventTs : fallbackNow;
  return base + ttl;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 交互请求所属子 agent（0.17 additive）。
 *
 * 优先级：`delegate_id` / `delegateId`（delegate 插件转发的内层 agent 更精确）
 * → `agent_id` / `agentId`（0.16 成员 bridge）→ `parent_delegate_id`（最后兜底）。
 * 旧事件缺这些字段时返回 undefined，不改变原有行为。
 */
export function interactionAgentId(data: Record<string, unknown>): string | undefined {
  return (
    stringField(data.delegate_id) ??
    stringField(data.delegateId) ??
    stringField(data.agent_id) ??
    stringField(data.agentId) ??
    stringField(data.parent_delegate_id) ??
    stringField(data.parentDelegateId)
  );
}

/**
 * `tool.permission.request` → 前端卡片模型。
 *
 * Addendum A：权限等待默认不超时，`deadline_at` 不再映射为过期时间；
 * 关联字段缺失时保持 undefined（旧 gateway 兼容）。
 */
export function permissionFromEvent(event: RunEvent, now = Date.now()): PermissionRequest | null {
  const data = event.data as {
    requestId?: unknown;
    request_id?: unknown;
    tool?: unknown;
    input?: unknown;
    session_id?: unknown;
    tool_call_id?: unknown;
    source?: unknown;
  };
  const rawId = data.requestId ?? data.request_id;
  if (typeof rawId !== 'string' || rawId.length === 0) return null;
  const agentId = interactionAgentId(data);
  return {
    requestId: rawId,
    tool: typeof data.tool === 'string' ? data.tool : 'tool',
    input: data.input,
    runId: event.run_id,
    ...(typeof data.session_id === 'string' && data.session_id.length > 0
      ? { sessionId: data.session_id }
      : {}),
    ...(typeof data.tool_call_id === 'string' && data.tool_call_id.length > 0
      ? { toolCallId: data.tool_call_id }
      : {}),
    ...(typeof data.source === 'string' && data.source.length > 0 ? { source: data.source } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    requestedAt: validTimestamp(event.ts) ? event.ts : now,
  };
}

/**
 * `ask.user.requested` → 前端卡片模型。
 *
 * 事件本身不带 session_id：由调用方从 `run.started` 反查后传入。
 * 关联字段（agentId）与权限请求同一套映射；旧事件缺字段时保持 undefined。
 *
 * 0.18：ask 不再按 120s 过期，`expiresAt` 固定为 `ASK_EXPIRES_AT_NEVER`；
 * 卡片只由应答 / run 终态 / 其他端事件移除。
 */
export function askFromEvent(
  event: RunEvent,
  sessionId?: string,
  // 保留第三参数以兼容调用方 / 测试；ask 不再由事件时间推导过期。
  _now = Date.now(),
): AskUserRequest | null {
  const data = event.data as {
    requestId?: unknown;
    request_id?: unknown;
    questions?: unknown;
  };
  const rawId = data.requestId ?? data.request_id;
  if (typeof rawId !== 'string' || rawId.length === 0) return null;
  if (!Array.isArray(data.questions)) return null;
  const questions = data.questions.filter(
    (item): item is AskUserRequest['questions'][number] =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as { question?: unknown }).question === 'string',
  );
  if (questions.length === 0) return null;
  const agentId = interactionAgentId(event.data);
  return {
    requestId: rawId,
    questions,
    runId: event.run_id,
    expiresAt: ASK_EXPIRES_AT_NEVER,
    ...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
  };
}

/** 权限请求入队（无时间过期，只做 requestId 去重）。 */
export function enqueuePermission<T extends { requestId: string }>(
  prev: readonly T[],
  item: T,
): readonly T[] {
  if (prev.some((entry) => entry.requestId === item.requestId)) return prev;
  return [...prev, item];
}

/** 是否已过期（等于 TTL 边界也视为过期）。 */
export function isInteractionExpired(item: Pick<Interaction, 'expiresAt'>, now: number): boolean {
  return item.expiresAt <= now;
}

/**
 * 入队：过期请求直接丢弃（重放旧 `tool.permission.request` 不再弹窗）；
 * 同一 requestId 只保留一份。
 */
export function enqueueInteraction<T extends Interaction>(
  prev: readonly T[],
  item: T,
  now = Date.now(),
): readonly T[] {
  if (isInteractionExpired(item, now)) return prev;
  if (prev.some((entry) => entry.requestId === item.requestId)) return prev;
  return [...prev, item];
}

/** 移除指定请求（应答成功 / 服务端 not_found / 其他端已应答）。 */
export function removeInteraction<T extends { requestId: string }>(
  prev: readonly T[],
  requestId: string,
): readonly T[] {
  return prev.some((entry) => entry.requestId === requestId)
    ? prev.filter((entry) => entry.requestId !== requestId)
    : prev;
}

/**
 * 移除已过期项；保留项不变。
 *
 * 0.18：ask 的 `expiresAt` 是 `ASK_EXPIRES_AT_NEVER`，因此本函数不会淘汰 ask；
 * 提问卡片只由应答 / run 终态 / 其他端事件收起。
 */
export function expireInteractions<T extends Pick<Interaction, 'expiresAt'>>(
  prev: readonly T[],
  now: number,
): readonly T[] {
  return prev.filter((entry) => entry.expiresAt > now);
}

/**
 * `not_found` 兼容两种错误形状：
 * - WS RPC：`Error("not_found: Permission request not found")`
 * - HTTP：`GatewayHttpError`，带 `code === 'not_found'`
 */
export function isNotFoundError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === 'not_found') return true;
  }
  return error instanceof Error && error.message.startsWith('not_found:');
}

/**
 * `expired` 错误：请求已过期 / 已随 run 取消（DECISION-024 §2.2）。
 * 与 `not_found` 一样收起卡片；区别只在提示语义。
 */
export function isExpiredError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === 'expired') return true;
  }
  return error instanceof Error && error.message.startsWith('expired:');
}

/** `run_ended` / 持久化后找不到 run：权限请求已失效（不是“未允许”）。 */
export function isRunEndedError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === 'run_ended' || code === 'orphaned') return true;
  }
  return error instanceof Error && error.message.startsWith('run_ended:');
}

/** 过期/丢失请求的统一提示（ConnectionProvider 的 toast 与测试共用）。 */
export function interactionExpiredMessage(): string {
  return t('permission.expired');
}

/** run 已结束的提示（Addendum A §4）。 */
export function interactionRunEndedMessage(): string {
  return t('permission.runEnded');
}

/**
 * `permission.respond` 参数：`remember:true` 是旧 gateway 的 always 兼容写法。
 * 取值为 `once` 时可省略，服务端缺省即 once。
 */
export function permissionRespondParams(
  decision: 'allow' | 'deny',
  scope: PermissionScope = 'once',
): Record<string, unknown> {
  return {
    decision,
    scope,
    ...(scope === 'always' ? { remember: true } : {}),
  };
}

/**
 * 单次提交守卫：`begin()` 同步占位，双击/重复点击只有第一次返回 true。
 * 调用方必须在 finally 中 `end()`。
 */
export class SubmitGuard {
  private readonly inFlight = new Set<string>();

  begin(requestId: string): boolean {
    if (!requestId || this.inFlight.has(requestId)) return false;
    this.inFlight.add(requestId);
    return true;
  }

  end(requestId: string): void {
    this.inFlight.delete(requestId);
  }

  has(requestId: string): boolean {
    return this.inFlight.has(requestId);
  }
}
