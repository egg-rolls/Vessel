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
import type { Logger, SessionStore } from '@vessel-agent/core';
import { isLoopbackHostname } from '../packages/config/src/index';
import { createSessionMethods } from '../packages/serve/src/gateway/methods/sessions';
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
import {
  createCommandRunner,
  deleteRecordIfOwned,
  inspectProcess,
  isBeforeBoot,
  isProcessAlive as pidIsAlive,
  quarantineCorruptRecordIfUnchanged,
  readGatewayStateFile,
} from './gateway/pid';

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
  // CREATE-0.39：session 主键入口（CLI 人工 rotate / restart / compact-fork 已删除）。
  | 'sessions.create'
  | 'sessions.restart'
  | 'sessions.activate'
  | 'teams.list'
  | 'teams.get'
  | 'teams.post'
  | 'teams.members'
  | 'teams.budget'
  | 'teams.create'
  | 'teams.update'
  | 'teams.archive'
  | 'teams.spawnFrozen';

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
  if (!isLoopbackHostname(host.trim().toLowerCase())) return null;
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

/** owner 端点探测超时（契约：500ms） */
const OWNER_PROBE_TIMEOUT_MS = 500;

/** E2 命令行回退超时（仅 owner 启动路径） */
const OWNER_COMMAND_TIMEOUT_MS = 2_000;

/** owner 分类结果 */
export type AgentOwnerState = 'running' | 'degraded' | 'stale';

export interface AgentOwnerClassification {
  state: AgentOwnerState;
  reason?: string;
  record: AgentOwnerRecord;
}

export interface ClassifyAgentOwnerOptions {
  /** 测试注入 */
  probe?: (record: AgentOwnerRecord, timeoutMs: number) => Promise<boolean>;
  isAlive?: (pid: number) => boolean;
  /** pre-boot 判定基线（epoch ms） */
  bootTime?: number;
}

/** 记录内 token 的只读探测：收到任何响应即 reachable；不打印 token。 */
async function probeAgentOwnerEndpoint(
  record: AgentOwnerRecord,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${record.token}`,
      },
      body: JSON.stringify({ method: 'agents.list', params: {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.text().catch(() => '');
    return true;
  } catch {
    return false;
  }
}

/** server 与 client 共用的 owner 身份判定。 */
export async function classifyAgentOwnerRecord(
  record: AgentOwnerRecord,
  options: ClassifyAgentOwnerOptions = {},
): Promise<AgentOwnerClassification> {
  const alive = options.isAlive ?? pidIsAlive;
  if (!alive(record.pid)) return { state: 'stale', reason: 'dead', record };
  if (
    isBeforeBoot(
      record.started_at,
      options.bootTime !== undefined ? { bootTime: options.bootTime } : {},
    )
  ) {
    return { state: 'stale', reason: 'pre-boot', record };
  }
  const probe = options.probe ?? probeAgentOwnerEndpoint;
  try {
    const reachable = await probe(record, OWNER_PROBE_TIMEOUT_MS);
    return reachable
      ? { state: 'running', record }
      : { state: 'degraded', reason: 'unreachable', record };
  } catch {
    return { state: 'degraded', reason: 'unreachable', record };
  }
}

/** 文件里的 host 是否为非回环（用于拒绝覆盖，不做探测/删除）。 */
async function hasNonLoopbackOwnerHost(filePath: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!isRecord(parsed) || typeof parsed.host !== 'string') return false;
    const host = parsed.host.trim().toLowerCase();
    return host !== '' && !isLoopbackHostname(host);
  } catch {
    return false;
  }
}

/** E2：pid 活、端点不可达时判断是否明显为 PID 复用。 */
async function ownerPidLooksReused(pid: number): Promise<boolean> {
  let info: Awaited<ReturnType<typeof inspectProcess>>;
  try {
    info = await inspectProcess(pid, {
      runCommand: createCommandRunner(OWNER_COMMAND_TIMEOUT_MS),
    });
  } catch {
    return false;
  }
  if (!info.alive) return true;
  const commandLine = info.commandLine;
  if (commandLine === undefined || commandLine.trim() === '') return false;
  return !/vessel|src[\\/]cli/i.test(commandLine);
}

export type AgentOwnerRecordDecision =
  | { kind: 'proceed' }
  | { kind: 'busy'; record?: AgentOwnerRecord; reason: string };

export interface PrepareAgentOwnerRecordOptions extends ClassifyAgentOwnerOptions {
  /** 测试注入：命令行回退结果（true = 明显 PID 复用） */
  pidLooksReused?: (pid: number) => Promise<boolean>;
  now?: () => number;
}

/**
 * 启动前处理旧 owner 记录：
 * - absent / 可回收的损坏记录 → proceed（损坏记录先 quarantine）；
 * - pre-boot / pid 死 → 隔离为 `.reclaim-<ts>` 后 proceed；
 * - pid 活 post-boot：端点可达 → busy；不可达 → E2 命令行回退；
 * - 非回环 host / I/O 错误 → busy，不探测、不覆盖、不删除。
 */
export async function prepareAgentOwnerRecord(
  dataDir: string,
  options: PrepareAgentOwnerRecordOptions = {},
): Promise<AgentOwnerRecordDecision> {
  const filePath = agentOwnerPath(dataDir);
  const snapshot = await readGatewayStateFile<AgentOwnerRecord>(filePath, {
    ...(options.now !== undefined ? { now: options.now() } : {}),
    parse: parseAgentOwnerRecord,
  });

  if (snapshot.kind === 'absent') return { kind: 'proceed' };
  if (snapshot.kind === 'io-error') {
    return {
      kind: 'busy',
      reason: `agent owner record is unreadable: ${snapshot.error.message}`,
    };
  }
  if (snapshot.kind === 'corrupt') {
    if (await hasNonLoopbackOwnerHost(filePath)) {
      return { kind: 'busy', reason: 'agent owner record host is not loopback' };
    }
    if (!snapshot.reclaimable) {
      return { kind: 'busy', reason: `agent owner record is ${snapshot.reason}` };
    }
    const quarantined = await quarantineCorruptRecordIfUnchanged(filePath, snapshot.mtimeMs, {
      ...(options.now !== undefined ? { now: options.now() } : {}),
    });
    return quarantined
      ? { kind: 'proceed' }
      : { kind: 'busy', reason: 'agent owner record changed during recovery' };
  }

  const existing = snapshot.value;
  if (existing.pid === process.pid) return { kind: 'proceed' };

  const classification = await classifyAgentOwnerRecord(existing, options);
  let stale = classification.state === 'stale';
  if (classification.state === 'degraded') {
    stale = await (options.pidLooksReused ?? ownerPidLooksReused)(existing.pid);
  }
  if (!stale) {
    return { kind: 'busy', record: existing, reason: 'agent_owner_in_use' };
  }

  const deleted = await deleteRecordIfOwned(
    filePath,
    { pid: existing.pid, started_at: existing.started_at },
    {
      quarantine: true,
      ...(options.now !== undefined ? { now: options.now() } : {}),
      parse: parseAgentOwnerRecord,
    },
  );
  return deleted
    ? { kind: 'proceed' }
    : { kind: 'busy', record: existing, reason: 'agent owner record changed during recovery' };
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

/** 删除记录；`owner` 给定时只在 pid + token + started_at 匹配时删除。 */
export async function removeAgentOwnerRecord(
  dataDir: string,
  owner?: { pid: number; token: string; started_at: string },
): Promise<void> {
  const current = await readAgentOwnerRecord(dataDir);
  if (!current) return;
  if (
    owner !== undefined &&
    (current.pid !== owner.pid ||
      current.token !== owner.token ||
      current.started_at !== owner.started_at)
  ) {
    return;
  }
  await deleteRecordIfOwned(
    agentOwnerPath(dataDir),
    { pid: current.pid, started_at: current.started_at },
    { parse: parseAgentOwnerRecord },
  );
}

/** 同步删除：进程退出路径用；比较 pid + token + started_at，先 rename 再删。 */
export function removeAgentOwnerRecordSync(
  dataDir: string,
  owner?: { pid: number; token: string; started_at: string },
): void {
  try {
    const filePath = agentOwnerPath(dataDir);
    const record = parseAgentOwnerRecord(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    if (!record) return;
    if (
      owner !== undefined &&
      (record.pid !== owner.pid ||
        record.token !== owner.token ||
        record.started_at !== owner.started_at)
    ) {
      return;
    }
    const reclaimPath = `${filePath}.reclaim-${Date.now()}`;
    fs.renameSync(filePath, reclaimPath);
    fs.rmSync(reclaimPath, { force: true });
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
  /** `sessions.create|restart|activate` 的 session 后端（serve 方法表要求）。 */
  sessionFor?: (tenantId: string) => SessionStore | undefined;
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
  sessionFor?: (tenantId: string) => SessionStore | undefined;
  teams?: TeamControlLike;
  tenantId: string;
  ownerId: string;
}): OwnerRpc {
  const sessionMethods = createSessionMethods({
    defaultTenantId: options.tenantId,
    sessionFor: options.sessionFor ?? (() => undefined),
    agent: options.control,
  }).filter((method) =>
    // CLI 只需要 session 创建 / 换体 / 切 primary；其余 sessions.* 仍走 gateway。
    ['sessions.create', 'sessions.restart', 'sessions.activate'].includes(method.name),
  );
  const table = defineMethods([
    ...createAgentMethods({
      registry: createAgentRegistry(),
      liveRuns: () => [],
      defaultTenantId: options.tenantId,
      agent: options.control,
      ...(options.teams !== undefined ? { teams: options.teams } : {}),
    }),
    ...sessionMethods,
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
  const decision = await prepareAgentOwnerRecord(options.dataDir);
  if (decision.kind === 'busy') {
    const existing = decision.record;
    throw new AgentOwnerError(
      existing !== undefined ? 'agent_owner_in_use' : 'agent_owner_unavailable',
      existing !== undefined
        ? `agent owner already running (pid ${existing.pid}, ${existing.host}:${existing.port})`
        : decision.reason,
      409,
    );
  }

  const ownerId = options.ownerId ?? 'main';
  const token = randomBytes(32).toString('hex');
  const host = options.host ?? '127.0.0.1';
  const rpc = createOwnerRpc({
    control: options.control,
    ...(options.sessionFor !== undefined ? { sessionFor: options.sessionFor } : {}),
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
    await removeAgentOwnerRecord(options.dataDir, {
      pid: record.pid,
      token: record.token,
      started_at: record.started_at,
    });
  };

  return {
    record,
    url: `http://${host}:${record.port}`,
    stop,
  };
}
