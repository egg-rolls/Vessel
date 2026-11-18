/**
 * 头部账号浮层的**唯一数据源适配层**（契约先行）。
 *
 * 需要的汇总接口（后端可能还没上线）：
 *
 * ```ts
 * {
 *   identity: { name, id, role },
 *   node: { id, name, state },
 *   team: { id, name },
 *   backends: [{ id, label, kind }],
 *   auth_mode: 'cookie' | 'bearer' | 'none'
 * }
 * ```
 *
 * 0.6x：它由 `auth.whoami` RPC 提供（单子 B）。**上线前一律静默降级**：
 * 404 / 方法未注册 / 网络不通 / 载荷不成形 ⇒ 返回 `degraded`，调用方改用现有
 * `whoami` 事实（`/auth/status` 的身份 + `useNodes()` 的节点列表），既不弹错也不 toast。
 *
 * 换数据源只改本文件：`AUTH_SUMMARY_METHOD` 与 `fetchAuthSummary` 的取数方式。
 *
 * @module web/domains/auth/auth-summary
 */

/** 汇总接口的 RPC 方法名（一处定义，换接口只改这里）。 */
export const AUTH_SUMMARY_METHOD = 'auth.whoami';

export type SummaryAuthMode = 'cookie' | 'bearer' | 'none';

/** 节点健康投影：与平台 `platform.nodes.list` 的 status 同义。 */
export type SummaryNodeState = 'up' | 'down' | 'unknown';

/** 降级原因（只用于本地判断，**不呈现给用户**）。 */
export type SummaryFailure =
  /** 接口不存在 / 方法未注册：预期内的「还没上线」，最常见的一种。 */
  | 'missing'
  /** 接口在，但返回的形状对不上契约。 */
  | 'invalid'
  /** 连不上 / 超时 / 鉴权失败。 */
  | 'unreachable';

export interface SummaryBackend {
  id: string;
  label: string;
  kind: string;
}

export interface SummaryIdentity {
  id: string;
  name: string;
  role: string | null;
  avatarUrl: string | null;
}

export interface SummaryNode {
  id: string;
  name: string;
  state: SummaryNodeState;
}

export interface SummaryTeam {
  id: string;
  name: string;
}

export interface AuthSummary {
  identity: SummaryIdentity;
  node: SummaryNode | null;
  team: SummaryTeam | null;
  /** 已注册的登录策略（可能为空：部署没配任何后端）。 */
  backends: readonly SummaryBackend[];
  /**
   * `null` = 后端没给或不认识这个值。此时调用方按 `/auth/status` 的会话事实判断，
   * 不要自己猜一个「已登录」出来。
   */
  authMode: SummaryAuthMode | null;
}

export type AuthSummaryResult =
  | { kind: 'ok'; summary: AuthSummary }
  | { kind: 'degraded'; failure: SummaryFailure };

/** 汇总接口的取数签名（`GatewayClient#rpc` 的形状；测试里可以直接塞假函数）。 */
export type SummaryRpc = (method: string, params?: unknown) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function nodeState(raw: unknown): SummaryNodeState {
  switch (text(raw)?.toLowerCase()) {
    case 'up':
    case 'online':
    case 'connected':
    case 'healthy':
      return 'up';
    case 'down':
    case 'offline':
    case 'unreachable':
    case 'error':
      return 'down';
    default:
      return 'unknown';
  }
}

function parseIdentity(raw: unknown): SummaryIdentity | null {
  const value = record(raw);
  if (value === null) return null;
  const id = text(value.id) ?? text(value.user_id) ?? text(value.userId);
  // 没有 id 的身份是不能渲染的（id 是身份本身，显示名只是装饰）。
  if (id === null) return null;
  return {
    id,
    name: text(value.name) ?? text(value.username) ?? text(value.display_name) ?? id,
    role: text(value.role),
    avatarUrl: text(value.avatar_url) ?? text(value.avatarUrl),
  };
}

function parseNode(raw: unknown): SummaryNode | null {
  const value = record(raw);
  if (value === null) return null;
  const id = text(value.id) ?? text(value.node_id);
  if (id === null) return null;
  return { id, name: text(value.name) ?? id, state: nodeState(value.state) };
}

function parseTeam(raw: unknown): SummaryTeam | null {
  const value = record(raw);
  if (value === null) return null;
  const id = text(value.id);
  const name = text(value.name);
  if (id === null || name === null) return null;
  return { id, name };
}

function parseBackends(raw: unknown): SummaryBackend[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const list: SummaryBackend[] = [];
  for (const item of raw) {
    const value = record(item);
    if (value === null) continue;
    const id = text(value.id);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    list.push({
      id,
      label: text(value.label) ?? id,
      kind: text(value.kind)?.toLowerCase() ?? 'unknown',
    });
  }
  return list;
}

function parseAuthMode(raw: unknown): SummaryAuthMode | null {
  const value = text(raw)?.toLowerCase();
  return value === 'cookie' || value === 'bearer' || value === 'none' ? value : null;
}

/**
 * 契约 → 前端形状。**形状不对就返回 `null`**（调用方降级），
 * 不做「能凑多少凑多少」的容错 —— 半张身份卡比没有身份卡更容易误导。
 */
export function parseAuthSummary(raw: unknown): AuthSummary | null {
  const value = record(raw);
  if (value === null) return null;
  const identity = parseIdentity(value.identity);
  if (identity === null) return null;
  return {
    identity,
    node: parseNode(value.node),
    team: parseTeam(value.team),
    backends: parseBackends(value.backends),
    authMode: parseAuthMode(value.auth_mode) ?? parseAuthMode(value.authMode),
  };
}

function errorCode(error: unknown): string | null {
  const direct = record(error);
  const code = direct === null ? null : text(direct.code);
  if (code !== null) return code.toLowerCase();
  // WS 错误把 code 拼在 message 前面（`not_found: ...`）。
  const message = error instanceof Error ? error.message : '';
  const match = /^([a-z_]+):/.exec(message);
  return match?.[1] ?? null;
}

function errorStatus(error: unknown): number | null {
  const value = record(error);
  return typeof value?.status === 'number' ? value.status : null;
}

/**
 * 「接口还没上线」的判定：404 / 405 / 方法未注册。
 *
 * 这类失败是**预期内**的（本单先做 UI、接口随后），调用方按降级处理，
 * 既不 toast 也不写红色 console。
 */
export function isMissingSummaryError(error: unknown): boolean {
  const code = errorCode(error);
  if (
    code === 'not_found' ||
    code === 'method_not_found' ||
    code === 'method_not_allowed' ||
    code === 'unsupported_method'
  ) {
    return true;
  }
  const status = errorStatus(error);
  if (status === 404 || status === 405) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.startsWith('not_found') || message.includes('method not found');
}

/**
 * 取一次汇总。**永不抛错**：调用方拿到 `degraded` 就用现有事实画界面。
 */
export async function fetchAuthSummary(rpc: SummaryRpc): Promise<AuthSummaryResult> {
  try {
    const summary = parseAuthSummary(await rpc(AUTH_SUMMARY_METHOD));
    return summary === null ? { kind: 'degraded', failure: 'invalid' } : { kind: 'ok', summary };
  } catch (error) {
    return { kind: 'degraded', failure: isMissingSummaryError(error) ? 'missing' : 'unreachable' };
  }
}

/** `/auth/status` 的一条登录后端（与 `web/auth/auth-client` 的 `AuthBackendInfo` 同形）。 */
export interface StatusBackend {
  id: string;
  kind: string;
  label: string;
  startPath: string;
}

/** 一条可执行的登录策略。 */
export interface LoginStrategy {
  id: string;
  label: string;
  kind: string;
  /**
   * 302 起步地址（OAuth 类）。`null` = **没有独立起步地址**：口令表单就在登录页，
   * 已登录时点它等价于「换账号」—— 调用方先登出，登录页会接管。
   */
  startPath: string | null;
}

/** 口令后端的 `startPath` 就是登录页自身（`/auth/status` 的 LOGIN_PATH）。 */
const LOGIN_PAGE_PATH = '/login';

/**
 * 汇总接口只给 `{id,label,kind}`，起步地址在 `/auth/status` 里，这里按 id 对齐、
 * 再按 kind 兜底（同一部署里 kind 唯一）。都对不上 ⇒ `startPath: null`。
 */
export function joinLoginStrategies(
  backends: readonly SummaryBackend[],
  status: readonly StatusBackend[],
): LoginStrategy[] {
  return backends.map((backend) => {
    const match =
      status.find((item) => item.id === backend.id) ??
      status.find((item) => item.kind === backend.kind) ??
      null;
    const raw = match?.startPath ?? null;
    const startPath =
      backend.kind === 'password' || raw === null || raw === LOGIN_PAGE_PATH ? null : raw;
    return { id: backend.id, label: backend.label, kind: backend.kind, startPath };
  });
}

/**
 * 降级模式（或策略列表为空）时的唯一登录动作：沿用 `/auth/status` 的首个后端。
 *
 * 没配任何后端 ⇒ `startPath` 为空 ⇒ 返回 `null`，界面上不出现死按钮。
 */
export function fallbackStrategy(
  label: string,
  startPath: string | null | undefined,
): LoginStrategy | null {
  const path = (startPath ?? '').trim();
  if (path === '') return null;
  return {
    id: 'primary',
    label,
    kind: 'unknown',
    startPath: path === LOGIN_PAGE_PATH ? null : path,
  };
}
