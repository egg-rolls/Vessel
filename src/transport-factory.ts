/**
 * 0.2 Transport 装配（A4）。
 *
 * - loopback 只在 `--serve` 且 `transport.kind=loopback` 时构造；
 * - endpoint 用 gateway 实际地址，token 与 gateway 共用（U7）；
 * - 任何失败返回结构化 error，由调用方告警并降级，不影响单 agent 路径。
 *
 * web 的 loopback 实现用动态 import，in-process/关闭路径不加载 serve transport。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_TRANSPORT_OPTIONS, type VesselConfig } from '../packages/config/src/index';
import type { AgentStatus, Transport } from '../packages/core/src/index';

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

export type LoopbackResult = { ok: true; transport: Transport } | { ok: false; error: string };

/** 默认 loader：只在 loopback 生效时加载 web transport */
async function loadLoopbackModule(): Promise<LoopbackTransportModule> {
  const mod = await import('../packages/serve/src/transport/loopback.js');
  return { createLoopbackTransport: mod.createLoopbackTransport };
}

/**
 * token 优先级（DECISION-006 R4）：
 * `transport.token` > `VESSEL_GATEWAY_TOKEN` > gateway 生成值。
 * 该函数只解析前两级；返回 undefined 表示交给 gateway 生成。
 */
export function resolveGatewayToken(config: VesselConfig): string | undefined {
  const fromConfig = config.transport?.token;
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.VESSEL_GATEWAY_TOKEN;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
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
      error: 'loopback requires a gateway token (config or VESSEL_GATEWAY_TOKEN)',
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
