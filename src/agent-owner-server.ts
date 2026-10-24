/**
 * REPL owner 的最小 loopback 控制端点（0.17 Phase A；0.26 收口为 canonical 传输）。
 *
 * - 文件：`<dataDir>/agent-owner.json`，JSON
 *   `{pid, host, port, token, started_at, tenant_id}`，原子写 0600；
 * - 只监听 127.0.0.1（缺省 :0），校验 Host 防 DNS rebinding；
 * - 端点只是传输：用合成 owner principal 分发 canonical `agents.*` / `teams.*`
 *   方法表，不复制第二套 action 列表或结果形状（ADR-091 Addendum 0.26）。
 *
 * @module vessel/agent-owner-server
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger } from '@vessel-agent/core';
import {
  type AgentControlLike,
  createAgentMethods,
  createAgentRegistry,
  createRpcDispatcher,
  createTeamMethods,
  defineMethods,
  type RpcMethodContext,
  type TeamControlLike,
} from '../packages/serve/src/index';
import { isProcessAlive } from './gateway/pid';

/** owner 记录文件名（dataDir 根） */
export const AGENT_OWNER_FILE = 'agent-owner.json';

/** 请求体上限；成员单条消息 64 KiB，批量留余量 */
export const AGENT_OWNER_MAX_BODY_BYTES = 1024 * 1024;

/**
 * 端点方法名 = canonical 方法名（pre-1.0，不保留 `agent.*` / `team.*` legacy 别名）。
 */
export type AgentOwnerMethod =
  | 'agents.create'
  | 'agents.send'
  | 'agents.close'
  | 'agents.list'
  | 'agents.dispatch'
  | 'agents.rotate'
  | 'teams.list'
  | 'teams.get'
  | 'teams.post'
  | 'teams.members'
  | 'teams.budget'
  | 'teams.create'
  | 'teams.update'
  | 'teams.archive';

/** owner 记录（E3 冻结字段） */
export interface AgentOwnerRecord {
  pid: number;
  host: string;
  port: number;
  token: string;
  /** ISO-8601 */
  started_at: string;
  tenant_id: string;
}

/** 端点错误：code 稳定，供 CLI / 日志映射 */
export class AgentOwnerError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = 'AgentOwnerError';
    this.code = code;
    this.status = status;
  }
}

/** owner 记录路径 */
export function agentOwnerPath(dataDir: string): string {
  return path.join(dataDir, AGENT_OWNER_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验并解析 owner 记录；字段非法返回 null */
export function parseAgentOwnerRecord(raw: unknown): AgentOwnerRecord | null {
  if (!isRecord(raw)) return null;
  const { pid, host, port, token, started_at, tenant_id } = raw;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof host !== 'string' || host.trim() === '') return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) return null;
  if (typeof token !== 'string' || token === '') return null;
  if (typeof started_at !== 'string' || Number.isNaN(Date.parse(started_at))) return null;
  if (typeof tenant_id !== 'string' || tenant_id === '') return null;
  return { pid, host, port, token, started_at, tenant_id };
}

/** 读取记录；缺失 / 损坏返回 null（不探测进程） */
export async function readAgentOwnerRecord(dataDir: string): Promise<AgentOwnerRecord | null> {
  try {
    const raw = await readFile(agentOwnerPath(dataDir), 'utf8');
    return parseAgentOwnerRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 原子写 owner 记录（0600） */
export async function writeAgentOwnerRecord(
  dataDir: string,
  record: AgentOwnerRecord,
): Promise<void> {
  const filePath = agentOwnerPath(dataDir);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = path.join(
    path.dirname(filePath),
    `.${AGENT_OWNER_FILE}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
  } catch {
    // Windows 上 chmod 只影响 readonly 位；忽略
  }
  try {
    await rename(tmp, filePath);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  try {
    await chmod(filePath, 0o600);
  } catch {
    // best-effort
  }
}

/** 删除记录；`owner` 给定时只在 pid/token 匹配时删除（避免误删后继 owner） */
export async function removeAgentOwnerRecord(
  dataDir: string,
  owner?: { pid: number; token: string },
): Promise<void> {
  if (owner) {
    const current = await readAgentOwnerRecord(dataDir);
    if (!current || current.pid !== owner.pid || current.token !== owner.token) return;
  }
  try {
    await unlink(agentOwnerPath(dataDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** 同步删除：进程退出路径用；不抛错 */
export function removeAgentOwnerRecordSync(
  dataDir: string,
  owner?: { pid: number; token: string },
): void {
  try {
    const filePath = agentOwnerPath(dataDir);
    if (owner) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      const record = parseAgentOwnerRecord(parsed);
      if (!record || record.pid !== owner.pid || record.token !== owner.token) return;
    }
    fs.unlinkSync(filePath);
  } catch {
    // 文件不存在 / 损坏 / 无权限：退出路径不抛错
  }
}

/** 已启动的 owner 端点 */
export interface AgentOwnerServer {
  readonly record: AgentOwnerRecord;
  readonly url: string;
  /** 幂等：停 server 并删除自己的 token 文件 */
  stop(): Promise<void>;
}

export interface StartAgentOwnerServerOptions {
  /** canonical `agents.*` 控制面（app 侧 AgentService 适配器）。 */
  control: AgentControlLike;
  /** canonical `teams.*` 控制面；缺省时方法仍在表内，返回 `not_found`。 */
  teams?: TeamControlLike;
  dataDir: string;
  tenantId: string;
  /** 合成 principal 的 sender / viewer；缺省 `main`（root owner）。 */
  ownerId?: string;
  /** 缺省 127.0.0.1 */
  host?: string;
  /** 缺省 0（系统分配） */
  port?: number;
  logger?: Logger;
}

/** Host 头必须是回环名（防 DNS rebinding） */
export function isLoopbackHostHeader(host: string | null): boolean {
  if (host === null) return false;
  let name = host.trim().toLowerCase();
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end === -1) return false;
    name = name.slice(1, end);
  } else {
    const colon = name.lastIndexOf(':');
    if (colon !== -1) name = name.slice(0, colon);
  }
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse(status, { ok: false, error: { code, message } });
}

function headerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/** owner 传输的合成 principal：admin 作用域 + owner agent id 作为 sender/viewer。 */
function ownerPrincipal(tenantId: string, ownerId: string): RpcMethodContext['principal'] {
  return { tenant_id: tenantId, role: 'admin', scope: 'admin', agent_id: ownerId };
}

/** canonical 错误码 → HTTP 状态（保持 owner 端点此前的业务语义）。 */
export function statusForRpcCode(code: string): number {
  switch (code) {
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'invalid_params':
      return 400;
    case 'conflict':
    case 'tenant_locked':
    case 'run_ended':
      return 409;
    case 'quota_exceeded':
      return 429;
    case 'expired':
      return 410;
    case 'not_supported':
      return 501;
    default:
      return 500;
  }
}

interface OwnerRpc {
  dispatch(
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; code: string; message: string }>;
}

/**
 * 与 gateway 同源的 canonical 方法表：`createAgentMethods` + `createTeamMethods`。
 * 只多一个合成 principal（owner agent id），不复制校验 / 错误映射。
 */
function createOwnerRpc(options: {
  control: AgentControlLike;
  teams?: TeamControlLike;
  tenantId: string;
  ownerId: string;
}): OwnerRpc {
  const table = defineMethods([
    ...createAgentMethods({
      registry: createAgentRegistry(),
      runs: new Map(),
      defaultTenantId: options.tenantId,
      agent: options.control,
      ...(options.teams !== undefined ? { teams: options.teams } : {}),
    }),
    ...createTeamMethods({ teams: options.teams }),
  ]);
  const principal = ownerPrincipal(options.tenantId, options.ownerId);
  const dispatcher = createRpcDispatcher({
    table,
    localPrincipal: principal,
    makeContext: (_method, _params, resolved) => ({
      principal: resolved,
      tenantId: resolved.tenant_id,
      isAdmin: true,
      allTenants: false,
      connection: 'local',
    }),
  });

  return {
    async dispatch(method, params) {
      const response = await dispatcher.dispatchFor(
        { v: 1, id: 'agent-owner', method, params },
        principal,
        'local',
      );
      if (response.ok) return { ok: true, result: response.result };
      return { ok: false, code: response.error.code, message: response.error.message };
    },
  };
}

/** 启动 loopback 端点并写入 token 文件 */
export async function startAgentOwnerServer(
  options: StartAgentOwnerServerOptions,
): Promise<AgentOwnerServer> {
  const existing = await readAgentOwnerRecord(options.dataDir);
  if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
    throw new AgentOwnerError(
      'agent_owner_in_use',
      `agent owner already running (pid ${existing.pid}, ${existing.host}:${existing.port})`,
      409,
    );
  }

  const ownerId = options.ownerId ?? 'main';
  const token = randomBytes(32).toString('hex');
  const host = options.host ?? '127.0.0.1';
  const rpc = createOwnerRpc({
    control: options.control,
    ...(options.teams !== undefined ? { teams: options.teams } : {}),
    tenantId: options.tenantId,
    ownerId,
  });

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: host,
      port: options.port ?? 0,
      async fetch(request) {
        if (!isLoopbackHostHeader(request.headers.get('host'))) {
          return errorResponse('agent_owner_forbidden_host', 'loopback host required', 403);
        }
        if (request.method !== 'POST') {
          return errorResponse('agent_owner_bad_request', 'method must be POST', 405);
        }
        const url = new URL(request.url);
        if (url.pathname !== '/') {
          return errorResponse('agent_owner_not_found', 'not found', 404);
        }
        if (headerToken(request) !== token) {
          return errorResponse('agent_owner_unauthorized', 'invalid token', 401);
        }

        const declared = Number(request.headers.get('content-length') ?? '0');
        if (Number.isFinite(declared) && declared > AGENT_OWNER_MAX_BODY_BYTES) {
          return errorResponse(
            'agent_owner_payload_too_large',
            `body exceeds ${AGENT_OWNER_MAX_BODY_BYTES} bytes`,
            413,
          );
        }
        let text: string;
        try {
          text = await request.text();
        } catch {
          return errorResponse('agent_owner_bad_request', 'unreadable body', 400);
        }
        if (Buffer.byteLength(text, 'utf8') > AGENT_OWNER_MAX_BODY_BYTES) {
          return errorResponse(
            'agent_owner_payload_too_large',
            `body exceeds ${AGENT_OWNER_MAX_BODY_BYTES} bytes`,
            413,
          );
        }

        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return errorResponse('agent_owner_bad_request', 'invalid JSON body', 400);
        }
        if (!isRecord(body) || typeof body.method !== 'string') {
          return errorResponse('agent_owner_bad_request', 'method must be a string', 400);
        }
        const params = isRecord(body.params) ? body.params : {};

        try {
          const result = await rpc.dispatch(body.method, params);
          if (!result.ok) {
            options.logger?.warn('agent.owner.request_failed', {
              method: body.method,
              code: result.code,
            });
            return errorResponse(result.code, result.message, statusForRpcCode(result.code));
          }
          return jsonResponse(200, { ok: true, result: result.result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          options.logger?.warn('agent.owner.request_failed', {
            method: body.method,
            code: 'agent_owner_error',
          });
          return errorResponse('agent_owner_error', message, 500);
        }
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentOwnerError('agent_owner_bind_failed', message, 500);
  }

  const record: AgentOwnerRecord = {
    pid: process.pid,
    host,
    port: server.port ?? options.port ?? 0,
    token,
    started_at: new Date().toISOString(),
    tenant_id: options.tenantId,
  };

  try {
    await writeAgentOwnerRecord(options.dataDir, record);
  } catch (error) {
    server.stop(true);
    throw new AgentOwnerError(
      'agent_owner_record_failed',
      error instanceof Error ? error.message : String(error),
      500,
    );
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    server.stop(true);
    await removeAgentOwnerRecord(options.dataDir, { pid: record.pid, token: record.token });
  };

  return {
    record,
    url: `http://${host}:${record.port}`,
    stop,
  };
}
