/**
 * `vessel attention` 的 RPC 客户端（0.22 S9.1）。
 *
 * 只封装 `interactions.list` / `permission.respond` / `ask.respond` / `health.get`
 * / `teams.get`；不做重试、不打印 token。`answered_via: 'cli'` 是审计字段，
 * 所有应答请求都必须带。
 *
 * @module vessel/attention-client
 */

import type { ControlPlaneTarget } from './control-plane-target';
import { RpcClientError } from './rpc';

export interface AttentionInteraction {
  kind: 'permission' | 'ask';
  request_id: string;
  run_id: string;
  agent_id?: string;
  team_id?: string;
  tool?: string;
  /** ask 专用：模型给出的问题（离线模式也展示；权限请求没有）。 */
  questions?: unknown;
  created_at: number;
  status: string;
}

export interface AttentionPage {
  interactions: AttentionInteraction[];
  /** 服务端过滤后的总数（不含 cursor / limit）；客户端 agent 过滤后会重算。 */
  total: number;
  nextCursor?: string;
}

export interface ListInteractionsParams {
  status: 'pending' | 'orphaned';
  limit: number;
  teamId?: string;
  tenantId?: string;
  /** 服务端过滤（在 team/session/run 之后、total/cursor/limit 之前）。 */
  agentId?: string;
  order?: 'oldest' | 'newest';
  cursor?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseInteraction(value: unknown): AttentionInteraction | undefined {
  if (!isRecord(value)) return undefined;
  const kind =
    value.kind === 'ask' ? 'ask' : value.kind === 'permission' ? 'permission' : undefined;
  const requestId = optionalString(value, 'request_id');
  const runId = optionalString(value, 'run_id');
  const createdAt = value.created_at;
  if (
    kind === undefined ||
    requestId === undefined ||
    runId === undefined ||
    typeof createdAt !== 'number' ||
    !Number.isFinite(createdAt)
  ) {
    return undefined;
  }
  return {
    kind,
    request_id: requestId,
    run_id: runId,
    ...(optionalString(value, 'agent_id') !== undefined
      ? { agent_id: optionalString(value, 'agent_id') }
      : {}),
    ...(optionalString(value, 'team_id') !== undefined
      ? { team_id: optionalString(value, 'team_id') }
      : {}),
    ...(optionalString(value, 'tool') !== undefined ? { tool: optionalString(value, 'tool') } : {}),
    ...(value.questions !== undefined ? { questions: value.questions } : {}),
    created_at: createdAt,
    status: optionalString(value, 'status') ?? 'pending',
  };
}

/** `interactions.list` 结果 → 页面；非法条目丢弃，`total` 缺失时回退本页条数。 */
export function parseInteractionPage(result: unknown): AttentionPage {
  const record = isRecord(result) ? result : {};
  const raw = Array.isArray(record.interactions) ? record.interactions : [];
  const interactions = raw
    .map((entry) => parseInteraction(entry))
    .filter((entry): entry is AttentionInteraction => entry !== undefined);
  const total =
    typeof record.total === 'number' && Number.isFinite(record.total)
      ? record.total
      : interactions.length;
  const nextCursor = optionalString(record, 'next_cursor');
  return {
    interactions,
    total,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

export async function listInteractions(
  target: ControlPlaneTarget,
  params: ListInteractionsParams,
): Promise<AttentionPage> {
  const result = await target.request('interactions.list', {
    status: params.status,
    limit: params.limit,
    ...(params.teamId !== undefined ? { team_id: params.teamId } : {}),
    ...(params.tenantId !== undefined ? { tenant_id: params.tenantId } : {}),
    ...(params.agentId !== undefined ? { agent_id: params.agentId } : {}),
    ...(params.order !== undefined ? { order: params.order } : {}),
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
  });
  return parseInteractionPage(result);
}

/** `health.get` 的 `node.node_id`；缺失返回 undefined（调用方按 mismatch 处理）。 */
export async function healthNodeId(target: ControlPlaneTarget): Promise<string | undefined> {
  const result = await target.request('health.get', {});
  if (!isRecord(result) || !isRecord(result.node)) return undefined;
  return optionalString(result.node, 'node_id');
}

/** 只有 401 是“凭据不可用”；403 是 scope 不足，不得误报成 peer token。 */
function isAuthRpcError(error: unknown): boolean {
  return (
    error instanceof RpcClientError && (error.httpStatus === 401 || error.code === 'unauthorized')
  );
}

/**
 * `--agent <id|name>` → agent_id。
 *
 * 纯 id 直接下发，不查 `agents.list`（team token 的 control scope 对它返回 403）。
 * 只有带 `--team` 时才查 roster，把 present 成员的 name 解析成 id；
 * 401 上抛，403 / 其它失败按输入原样当 id（服务端过滤对未知 id 返回空集）。
 */
export async function resolveAgentFilter(input: {
  target: ControlPlaneTarget;
  agent: string;
  teamId?: string;
}): Promise<string> {
  if (input.teamId === undefined) return input.agent;

  try {
    const result = await input.target.request('teams.get', {
      team_id: input.teamId,
      members_limit: 100,
    });
    const members = isRecord(result) && Array.isArray(result.members) ? result.members : [];
    let byName: string | undefined;
    for (const member of members) {
      if (!isRecord(member) || member.membership !== 'present') continue;
      const id = optionalString(member, 'agent_id');
      if (id === undefined) continue;
      if (id === input.agent) return id;
      if (byName === undefined && optionalString(member, 'name') === input.agent) byName = id;
    }
    if (byName !== undefined) return byName;
  } catch (error) {
    if (isAuthRpcError(error)) throw error;
  }
  return input.agent;
}

/** `permission.respond`；`answered_via` 固定 `cli`，`answered_by` 由服务端固定 human。 */
export async function respondPermission(
  target: ControlPlaneTarget,
  requestId: string,
  decision: 'allow' | 'deny',
  remember: boolean,
): Promise<unknown> {
  return target.request('permission.respond', {
    request_id: requestId,
    decision,
    remember,
    answered_via: 'cli',
  });
}

/** `ask.respond`；`answers` 必须是数组（服务端校验）。 */
export async function respondAsk(
  target: ControlPlaneTarget,
  requestId: string,
  answers: unknown[],
): Promise<unknown> {
  return target.request('ask.respond', {
    request_id: requestId,
    answers,
    answered_via: 'cli',
  });
}
