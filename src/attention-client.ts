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

/**
 * `--agent <id|name>` → agent_id。
 *
 * agent_id 精确匹配优先（观察到的 interaction + team roster）；team 存在时
 * 再用 present 成员 name 解析。无 team 且未观察到时按 agent_id 原样使用。
 */
export async function resolveAgentFilter(input: {
  target: ControlPlaneTarget;
  agent: string;
  teamId?: string;
  observedAgentIds?: ReadonlySet<string>;
}): Promise<string | undefined> {
  if (input.observedAgentIds?.has(input.agent) === true) return input.agent;
  if (input.teamId === undefined) return input.agent;

  let members: unknown[] = [];
  try {
    const result = await input.target.request('teams.get', {
      team_id: input.teamId,
      members_limit: 100,
    });
    members = isRecord(result) && Array.isArray(result.members) ? result.members : [];
  } catch (error) {
    if (
      error instanceof RpcClientError &&
      (error.httpStatus === 401 ||
        error.httpStatus === 403 ||
        error.code === 'unauthorized' ||
        error.code === 'forbidden')
    ) {
      throw error;
    }
    return undefined;
  }

  let byName: string | undefined;
  for (const member of members) {
    if (!isRecord(member) || member.membership !== 'present') continue;
    const id = optionalString(member, 'agent_id');
    if (id === undefined) continue;
    if (id === input.agent) return id;
    if (byName === undefined && optionalString(member, 'name') === input.agent) byName = id;
  }
  return byName;
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
