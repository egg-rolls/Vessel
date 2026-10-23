/**
 * REPL owner 的最小 loopback 控制端点（0.17 Phase A）。
 *
 * - 文件：`<dataDir>/agent-owner.json`，JSON
 *   `{pid, host, port, token, started_at, tenant_id}`，原子写 0600；
 * - 只监听 127.0.0.1（缺省 :0），校验 Host 防 DNS rebinding；
 * - 端点只是传输：`agent.new/send/close/list/dispatch/rotate` 委托 AgentService，
 *   `team.list/get/post/members/budget` 委托 TeamService（0.19 S3 / S4）。
 *
 * @module vessel/agent-owner-server
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AgentService,
  AgentTeamService,
  BudgetDimension,
  DispatchInput,
  NewBatchInput,
  NewMemberInput,
  RotateInput,
  SendInput,
  TeamMembersInput,
  TeamPostInput,
} from '@vessel-agent/agent';
import type { Logger } from '@vessel-agent/core';
import { isProcessAlive } from './gateway/pid';

/** owner 记录文件名（dataDir 根） */
export const AGENT_OWNER_FILE = 'agent-owner.json';

/** 请求体上限；成员单条消息 64 KiB，批量留余量 */
export const AGENT_OWNER_MAX_BODY_BYTES = 1024 * 1024;

/** 端点方法名（冻结形状） */
export type AgentOwnerMethod =
  | 'agent.new'
  | 'agent.send'
  | 'agent.close'
  | 'agent.list'
  | 'agent.dispatch'
  | 'agent.rotate'
  | 'team.list'
  | 'team.get'
  | 'team.post'
  | 'team.members'
  | 'team.budget';

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
  service: AgentService;
  /** 0.19 S3：CLI `vessel team ...` 的私有端点 */
  team: AgentTeamService;
  dataDir: string;
  tenantId: string;
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

/** snake_case 字段 → AgentService 入参；owner/parent 固定为 root owner */
function mapNewEntry(entry: Record<string, unknown>, ownerId: string): Record<string, unknown> {
  const input: Record<string, unknown> = { owner: ownerId, parentId: ownerId };
  if (entry.name !== undefined) input.name = entry.name;
  if (entry.model !== undefined) input.model = entry.model;
  if (entry.system_prompt !== undefined) input.systemPrompt = entry.system_prompt;
  if (entry.visibility !== undefined) input.visibility = entry.visibility;
  // 0.19 S3：CLI `agent new --workspace` 显式绑定 Team。
  if (entry.workspace !== undefined) input.workspace = entry.workspace;
  return input;
}

function invalidInput(method: string, message: string): AgentOwnerError {
  return new AgentOwnerError('invalid_input', `${method}: ${message}`, 400);
}

/** 最小参数校验：非空字符串 */
function requireString(method: string, params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value === '') {
    throw invalidInput(method, `${key} must be a non-empty string`);
  }
  return value;
}

/** 可选非空字符串；缺省返回 undefined */
function optionalString(
  method: string,
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw invalidInput(method, `${key} must be a non-empty string`);
  }
  return value;
}

const BUDGET_DIMENSIONS = new Set<string>(['hops', 'turns', 'tokens', 'wall_clock', 'cycle']);

function readMentions(method: string, params: Record<string, unknown>): string[] | undefined {
  const mentions = params.mentions;
  if (mentions === undefined) return undefined;
  if (!Array.isArray(mentions) || !mentions.every((mention) => typeof mention === 'string')) {
    throw invalidInput(method, 'mentions must be an array of strings');
  }
  return mentions as string[];
}

function readLimit(method: string, params: Record<string, unknown>): number | undefined {
  const limit = params.limit;
  if (limit === undefined) return undefined;
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw invalidInput(method, 'limit must be a number');
  }
  return limit;
}

/** `team.*` 私有方法 → TeamService；unknown team 统一 404 */
async function dispatchTeam(
  team: AgentTeamService,
  ownerId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'team.list':
      return team.list({ viewer: ownerId });
    case 'team.get': {
      const teamId = requireString(method, params, 'team_id');
      const limit = readLimit(method, params);
      const detail = await team.get(teamId, {
        viewer: ownerId,
        ...(limit !== undefined ? { limit } : {}),
      });
      if (detail === undefined) {
        throw new AgentOwnerError('team_not_found', `team_not_found: ${teamId}`, 404);
      }
      return detail;
    }
    case 'team.post': {
      const teamId = requireString(method, params, 'team_id');
      const content = requireString(method, params, 'content');
      const mentions = readMentions(method, params);
      const conversationId = optionalString(method, params, 'conversation_id');
      return team.post({
        team_id: teamId,
        content,
        ...(mentions !== undefined ? { mentions } : {}),
        ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
        from: ownerId,
      } satisfies TeamPostInput);
    }
    case 'team.members': {
      const teamId = requireString(method, params, 'team_id');
      const action = params.action;
      if (action !== 'add' && action !== 'remove') {
        throw invalidInput(method, 'action must be add or remove');
      }
      const member = requireString(method, params, 'member');
      const result = await team.members({
        team_id: teamId,
        action,
        member,
        from: ownerId,
      } satisfies TeamMembersInput);
      if (result === undefined) {
        throw new AgentOwnerError('team_not_found', `team_not_found: ${teamId}`, 404);
      }
      return result;
    }
    case 'team.budget': {
      if (typeof team.budget !== 'function') {
        throw new AgentOwnerError('team_not_found', 'budget unavailable', 404);
      }
      const teamId = requireString(method, params, 'team_id');
      const action = params.action;
      if (action !== 'status' && action !== 'override') {
        throw invalidInput(method, 'action must be status or override');
      }
      const conversationId = optionalString(method, params, 'conversation_id');
      if (action === 'status') {
        return team.budget({
          team_id: teamId,
          ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
        });
      }
      if (conversationId === undefined) {
        throw invalidInput(method, 'conversation_id is required for override');
      }
      const dimension = params.dimension;
      if (typeof dimension !== 'string' || !BUDGET_DIMENSIONS.has(dimension)) {
        throw invalidInput(method, 'dimension must be hops, turns, tokens, wall_clock or cycle');
      }
      if (!Object.hasOwn(params, 'max')) {
        throw invalidInput(method, 'max is required for override');
      }
      const max = params.max;
      if (max !== null && (typeof max !== 'number' || !Number.isInteger(max) || max < 0)) {
        throw invalidInput(method, 'max must be a non-negative integer or null');
      }
      return team.budget({
        team_id: teamId,
        conversation_id: conversationId,
        dimension: dimension as BudgetDimension,
        max: max as number | null,
        via: 'cli',
      });
    }
    default:
      throw new AgentOwnerError(
        'agent_owner_unknown_method',
        `unknown method: ${method} (expected agent.new|agent.send|agent.close|agent.list|agent.dispatch|agent.rotate|team.list|team.get|team.post|team.members|team.budget)`,
        404,
      );
  }
}

function mapNewBatch(params: Record<string, unknown>, ownerId: string): NewBatchInput {
  const members = params.members;
  if (!Array.isArray(members)) {
    throw new AgentOwnerError('invalid_input', 'agent.new: members must be an array', 400);
  }
  return {
    members: members.map((entry) =>
      isRecord(entry) ? mapNewEntry(entry, ownerId) : entry,
    ) as unknown as NewMemberInput[],
  };
}

function mapSendBatch(params: Record<string, unknown>, ownerId: string): SendInput {
  const messages = params.messages;
  if (!Array.isArray(messages)) {
    throw new AgentOwnerError('invalid_input', 'agent.send: messages must be an array', 400);
  }
  return {
    messages: messages.map((entry) => {
      if (!isRecord(entry)) return entry;
      return {
        ...(entry.to !== undefined ? { to: entry.to } : {}),
        ...(entry.content !== undefined ? { content: entry.content } : {}),
        ...(entry.conversation_id !== undefined ? { conversation_id: entry.conversation_id } : {}),
        from: ownerId,
      };
    }),
  } as unknown as SendInput;
}

/** 端点方法 → AgentService；错误在 handler 外层统一映射 */
async function dispatch(
  service: AgentService,
  team: AgentTeamService,
  ownerId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (method.startsWith('team.')) {
    return dispatchTeam(team, ownerId, method, params);
  }
  switch (method) {
    case 'agent.new':
      if (params.members !== undefined) return service.new(mapNewBatch(params, ownerId));
      return service.new(mapNewEntry(params, ownerId) as unknown as NewMemberInput);
    case 'agent.send':
      if (params.messages !== undefined) return service.send(mapSendBatch(params, ownerId));
      return service.send({
        ...(params.to !== undefined ? { to: params.to } : {}),
        ...(params.content !== undefined ? { content: params.content } : {}),
        ...(params.conversation_id !== undefined
          ? { conversation_id: params.conversation_id }
          : {}),
        from: ownerId,
      } as unknown as SendInput);
    case 'agent.close':
      if (params.members !== undefined)
        return service.close({ members: params.members as string[] });
      return service.close({
        ...(params.member !== undefined ? { member: params.member } : {}),
        ...(params.to !== undefined ? { to: params.to } : {}),
      } as { member?: string; to?: string });
    case 'agent.list': {
      const filter: Record<string, unknown> = { viewer: ownerId };
      if (params.visibility !== undefined) filter.visibility = params.visibility;
      if (params.state !== undefined) filter.state = params.state;
      if (params.parent_id !== undefined) filter.parentId = params.parent_id;
      return service.list(filter as Parameters<AgentService['list']>[0]);
    }
    case 'agent.dispatch':
      return service.dispatch({
        ...(params.to !== undefined ? { to: params.to } : {}),
        ...(params.content !== undefined ? { content: params.content } : {}),
        ...(params.conversation_id !== undefined
          ? { conversation_id: params.conversation_id }
          : {}),
        ...(params.allow_fork !== undefined ? { allow_fork: params.allow_fork } : {}),
        from: ownerId,
      } as DispatchInput);
    case 'agent.rotate':
      // 人类路径不带 from_session_id：CLI / owner 端点可换任意可见 Agent。
      return service.rotate({
        ...(params.to !== undefined ? { to: params.to } : {}),
        ...(params.startup_prompt !== undefined ? { startup_prompt: params.startup_prompt } : {}),
        ...(params.handoff_path !== undefined ? { handoff_path: params.handoff_path } : {}),
        from: ownerId,
      } as RotateInput);
    default:
      throw new AgentOwnerError(
        'agent_owner_unknown_method',
        `unknown method: ${method} (expected agent.new|agent.send|agent.close|agent.list|agent.dispatch|agent.rotate)`,
        404,
      );
  }
}

function errorStatus(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof AgentOwnerError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (isRecord(error) && typeof error.code === 'string') {
    // AgentService 的稳定错误码（invalid_input / unknown_member / ...）
    return {
      code: error.code,
      message: error instanceof Error ? error.message : String(error),
      status: 400,
    };
  }
  return {
    code: 'agent_owner_error',
    message: error instanceof Error ? error.message : String(error),
    status: 500,
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

  const ownerId = 'main';
  const token = randomBytes(32).toString('hex');
  const host = options.host ?? '127.0.0.1';

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
          const result = await dispatch(
            options.service,
            options.team,
            ownerId,
            body.method,
            params,
          );
          return jsonResponse(200, { ok: true, result });
        } catch (error) {
          const mapped = errorStatus(error);
          options.logger?.warn('agent.owner.request_failed', {
            method: body.method,
            code: mapped.code,
          });
          return errorResponse(mapped.code, mapped.message, mapped.status);
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
