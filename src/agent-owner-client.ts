/**
 * `vessel agent` 的 owner 客户端（0.17 Phase A）。
 *
 * 读取 `<dataDir>/agent-owner.json` → POST 到 loopback 端点。
 * 缺失 / pid 已死 / 连不上统一抛 `agent_owner_unavailable`：
 * Phase A 不自动启动 gateway，owner 只能由交互 REPL 提供。
 *
 * @module vessel/agent-owner-client
 */

import {
  type AgentOwnerMethod,
  type AgentOwnerRecord,
  agentOwnerPath,
  parseAgentOwnerRecord,
} from './agent-owner-server';
import { isProcessAlive } from './gateway/pid';

/** owner 不可用（缺失 / stale / 连接失败） */
export class AgentOwnerUnavailableError extends Error {
  readonly code = 'agent_owner_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'AgentOwnerUnavailableError';
  }
}

/** 端点返回的业务错误（code 来自 AgentService 或端点） */
export class AgentOwnerRequestError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'AgentOwnerRequestError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface ResolveAgentOwnerOptions {
  /** 测试注入 */
  isAlive?: (pid: number) => boolean;
}

/** 读取并校验 owner；pid 已死视为不可用 */
export async function resolveAgentOwner(
  dataDir: string,
  options: ResolveAgentOwnerOptions = {},
): Promise<AgentOwnerRecord> {
  const file = agentOwnerPath(dataDir);
  let raw: string;
  try {
    raw = await Bun.file(file).text();
  } catch {
    throw new AgentOwnerUnavailableError(
      `no agent owner at ${file}; start the interactive REPL first`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgentOwnerUnavailableError(`invalid agent owner record at ${file}`);
  }
  const record = parseAgentOwnerRecord(parsed);
  if (!record) {
    throw new AgentOwnerUnavailableError(`invalid agent owner record at ${file}`);
  }

  const isAlive = options.isAlive ?? isProcessAlive;
  if (!isAlive(record.pid)) {
    throw new AgentOwnerUnavailableError(
      `agent owner pid ${record.pid} is not running (stale ${file})`,
    );
  }
  return record;
}

export interface CallAgentOwnerOptions {
  /** 测试注入 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** POST 一个端点方法；业务错误转 AgentOwnerRequestError，连接失败转 unavailable */
export async function callAgentOwner(
  record: AgentOwnerRecord,
  method: AgentOwnerMethod,
  params: Record<string, unknown> = {},
  options: CallAgentOwnerOptions = {},
): Promise<unknown> {
  const url = `http://${record.host}:${record.port}/`;
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${record.token}`,
      },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AgentOwnerUnavailableError(`cannot reach agent owner at ${url}: ${detail}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AgentOwnerRequestError(
      'agent_owner_error',
      `invalid response from ${url} (HTTP ${response.status})`,
      response.status,
    );
  }

  if (!isRecord(body)) {
    throw new AgentOwnerRequestError(
      'agent_owner_error',
      `invalid response from ${url} (HTTP ${response.status})`,
      response.status,
    );
  }
  if (body.ok === true) return body.result;

  const error = isRecord(body.error) ? body.error : {};
  const code =
    typeof error.code === 'string' && error.code !== '' ? error.code : 'agent_owner_error';
  const message = typeof error.message === 'string' ? error.message : `HTTP ${response.status}`;
  throw new AgentOwnerRequestError(code, message, response.status);
}
