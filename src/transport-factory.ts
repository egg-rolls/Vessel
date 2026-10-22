/**
 * Transport 装配（0.2 A4；0.6 增加 remote）。
 *
 * - loopback 只在 `--serve` 且 `transport.kind=loopback` 时构造；
 * - remote 由 `tryCreateRemoteTransport` 构造（静态 nodes，HTTP/WS + token/CA）；
 * - endpoint 用 gateway 实际地址，loopback token 与 gateway 共用（U7）；
 * - 任何失败返回结构化 error，由调用方告警并降级，不影响单 agent 路径。
 *
 * web 的 loopback 实现用动态 import，in-process/关闭路径不加载 serve transport。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_TRANSPORT_OPTIONS, type VesselConfig } from '../packages/config/src/index';
import type { AgentStatus, RunEvent, Transport } from '../packages/core/src/index';
import { RemoteTransport } from './remote-transport';
import type { WebSocketFactory } from './rpc/index';

export interface LoopbackTransportOptionsLike {
  nodeId: string;
  endpoint: string;
  token: string;
  peersDir: string;
  heartbeatMs?: number;
  peerTtlMs?: number;
  /** 本节点成员快照；写入注册表供远端短 id 解析（web P1-1） */
  agents?: () => AgentStatus[];
}

/** 动态加载的 web loopback 入口形状（测试可注入 fake） */
export interface LoopbackTransportModule {
  createLoopbackTransport(options: LoopbackTransportOptionsLike): Promise<Transport>;
}

export interface CreateLoopbackOptions {
  config: VesselConfig;
  nodeId: string;
  /** gateway 实际地址（Bun.serve 端口） */
  endpoint: string;
  /** gateway 已生成/已解析的 token；作为 config/env 之后最后回退 */
  gatewayToken?: string;
  /** 本节点成员快照（短 id 远端发现）；缺省不发布成员 */
  agents?: () => AgentStatus[];
  loadModule?: () => Promise<LoopbackTransportModule>;
}

export type TransportResult = { ok: true; transport: Transport } | { ok: false; error: string };

export type LoopbackResult = TransportResult;

export interface CreateRemoteOptions {
  config: VesselConfig;
  /** 唯一来源：host.node_id */
  nodeId: string;
  /** B4：远端事件回调（调用方负责回灌到本地 gateway 事件流） */
  onEvent?: (event: RunEvent) => void;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  webSocket?: WebSocketFactory;
  heartbeatMs?: number;
  peerTtlMs?: number;
  requestTimeoutMs?: number;
  eventReconnect?: {
    initialMs?: number;
    maxMs?: number;
    helloTimeoutMs?: number;
  };
}

/** 默认 loader：只在 loopback 生效时加载 web transport */
async function loadLoopbackModule(): Promise<LoopbackTransportModule> {
  const mod = await import('../packages/serve/src/transport/loopback.js');
  return { createLoopbackTransport: mod.createLoopbackTransport };
}

/**
 * 解析 gateway/本地客户端 token（绝不返回 serve.tokens 条目）：
 * `serve.token` / `serve.token_env` → `serve.admin_token(_env)` →
 * `VESSEL_GATEWAY_TOKEN` → `transport.token`。
 * `serve.tokens` 是客户端认证凭据，不能当作 gateway token。
 * 返回 undefined 表示交给 gateway 生成。
 */
export function resolveGatewayToken(
  config: VesselConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const nonEmpty = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;

  return (
    nonEmpty(config.serve?.token) ??
    nonEmpty(config.serve?.tokenEnv ? env[config.serve.tokenEnv] : undefined) ??
    nonEmpty(config.serve?.adminToken) ??
    nonEmpty(config.serve?.adminTokenEnv ? env[config.serve.adminTokenEnv] : undefined) ??
    nonEmpty(env.VESSEL_GATEWAY_TOKEN) ??
    nonEmpty(config.transport?.token)
  );
}

/**
 * 解析 `--connect` / 远程控制面使用的客户端凭据（0.18，DECISION-033）。
 *
 * 优先级（高 → 低）：
 * `options.connectToken` → `VESSEL_CONNECT_TOKEN` → `config.connect.token` →
 * `resolveGatewayToken(config, env)`。
 * 空串视为未设置；永不读取 / 返回 `serve.tokens`。
 * token 只返回给调用方，不打印、不进日志或错误消息。
 */
export function resolveConnectToken(
  config: VesselConfig,
  options: { connectToken?: string | null; env?: Record<string, string | undefined> } = {},
): string | undefined {
  const env = options.env ?? process.env;
  const nonEmpty = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value : undefined;

  return (
    nonEmpty(options.connectToken) ??
    nonEmpty(env.VESSEL_CONNECT_TOKEN) ??
    nonEmpty(config.connect?.token) ??
    resolveGatewayToken(config, env)
  );
}

/** 解析 peers 目录：支持 `~`；相对路径按进程 cwd 解析 */
export function resolvePeersDir(input?: string): string {
  const raw = input && input.length > 0 ? input : DEFAULT_TRANSPORT_OPTIONS.peersDir;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return path.isAbsolute(raw) ? raw : path.resolve(raw);
}

/** 构造 loopback transport；失败返回 { ok:false }，不抛出 */
export async function tryCreateLoopbackTransport(
  options: CreateLoopbackOptions,
): Promise<LoopbackResult> {
  const token = resolveGatewayToken(options.config) ?? options.gatewayToken;
  if (!token) {
    return {
      ok: false,
      error:
        'loopback requires a gateway token ' +
        '(serve.token, serve.tokens, admin_token, transport.token, or VESSEL_GATEWAY_TOKEN)',
    };
  }

  try {
    const loader = options.loadModule ?? loadLoopbackModule;
    const { createLoopbackTransport } = await loader();
    const transport = await createLoopbackTransport({
      nodeId: options.nodeId,
      endpoint: options.endpoint,
      token,
      peersDir: resolvePeersDir(options.config.transport?.peersDir),
      heartbeatMs: options.config.transport?.heartbeatMs,
      peerTtlMs: options.config.transport?.peerTtlMs,
      ...(options.agents ? { agents: options.agents } : {}),
    });
    return { ok: true, transport };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 构造 remote transport；失败返回 { ok:false }，不抛。
 * 配置错误（无 nodes / 非法 URL / CA 不可读）在这里转为启动告警。
 */
export async function tryCreateRemoteTransport(
  options: CreateRemoteOptions,
): Promise<TransportResult> {
  const nodes = options.config.transport?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return {
      ok: false,
      error: 'transport.kind=remote requires transport.nodes (static node list)',
    };
  }
  try {
    const transport = await RemoteTransport.create({
      nodeId: options.nodeId,
      nodes,
      registryOptions: {
        ...(options.env ? { env: options.env } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.heartbeatMs !== undefined
          ? { heartbeatMs: options.heartbeatMs }
          : options.config.transport?.heartbeatMs !== undefined
            ? { heartbeatMs: options.config.transport.heartbeatMs }
            : {}),
        ...(options.peerTtlMs !== undefined
          ? { peerTtlMs: options.peerTtlMs }
          : options.config.transport?.peerTtlMs !== undefined
            ? { peerTtlMs: options.config.transport.peerTtlMs }
            : {}),
        ...(options.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: options.requestTimeoutMs }
          : {}),
      },
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.webSocket ? { webSocket: options.webSocket } : {}),
      ...(options.eventReconnect ? { eventReconnect: options.eventReconnect } : {}),
    });
    return { ok: true, transport };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 按 `transport.kind` 构造；in-process 返回 ok:false 由调用方保持默认路径 */
export async function tryCreateConfiguredTransport(
  options: CreateRemoteOptions & {
    endpoint: string;
    gatewayToken?: string;
    agents?: () => AgentStatus[];
  },
): Promise<TransportResult> {
  const kind = options.config.transport?.kind;
  if (kind === 'remote') return tryCreateRemoteTransport(options);
  if (kind === 'loopback') {
    return tryCreateLoopbackTransport({
      config: options.config,
      nodeId: options.nodeId,
      endpoint: options.endpoint,
      ...(options.gatewayToken ? { gatewayToken: options.gatewayToken } : {}),
      ...(options.agents ? { agents: options.agents } : {}),
    });
  }
  return { ok: false, error: `transport.kind "${kind ?? 'in-process'}" has no external transport` };
}
