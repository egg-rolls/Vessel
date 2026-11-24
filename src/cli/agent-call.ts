/**
 * q-node-target：`agent` / `team` 命令的统一 RPC 传输入口。
 *
 * 两条路，结果形状完全一致（owner 端点与 gateway 分发同一张 canonical 方法表，
 * ADR-091 Addendum 0.26）：
 *
 * - **无 targeting**（缺省）：逐字旧行为 —— `resolveAgentOwner(dataDir)` 读
 *   `<dataDir>/agent-owner.json` → POST loopback owner 端点。不碰 `--connect`。
 * - **有 targeting**（`--connect <url>` 和/或 `--node <id>`）：走
 *   `resolveControlPlaneTarget` → `createHttpRpcClient`。`--node` 经平台代理
 *   `/nodes/<id>/v1/rpc`（平台鉴权后由代理覆写 node token，node token 不出网关）；
 *   仅 `--connect` 直连该 URL 的 `/v1/rpc`。
 *
 * 错误统一映射回 `AgentOwnerRequestError` / `AgentOwnerUnavailableError`，
 * 命令渲染层（agent-command / team-command 的 `failure()`）零改动。
 *
 * @module vessel/agent-call
 */

import {
  AgentOwnerRequestError,
  AgentOwnerUnavailableError,
  callAgentOwner,
  resolveAgentOwner,
} from '../agent/agent-owner-client';
import type { AgentOwnerMethod } from '../agent/agent-owner-server';
import { RpcClientError } from '../rpc';
import { resolveControlPlaneTarget } from './control-plane-target';

export interface AgentCallOptions {
  dataDir: string;
  connectUrl?: string | null;
  connectToken?: string | null;
  caFile?: string | null;
  nodeId?: string | null;
  /** 测试注入 */
  isAlive?: (pid: number) => boolean;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

/** 统一调用面：方法名 = canonical 方法名；params 缺省空对象。 */
export interface AgentCall {
  call(method: AgentOwnerMethod, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
  /** 诊断用：'owner'（本地 loopback）/ 'local'（本地平台）/ 'remote'（--connect）。 */
  transport: 'owner' | 'local' | 'remote';
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** 是否显式 targeting（只有显式旗标才改道；不吃 VESSEL_CONNECT env，保持缺省宿主行为）。 */
export function hasTargeting(options: AgentCallOptions): boolean {
  return nonEmpty(options.connectUrl) !== undefined || nonEmpty(options.nodeId) !== undefined;
}

/** 解析传输并返回统一调用面。失败抛 AgentOwner*Error（与旧 owner 路径同口径）。 */
export async function resolveAgentCall(options: AgentCallOptions): Promise<AgentCall> {
  if (!hasTargeting(options)) {
    const record = await resolveAgentOwner(options.dataDir, {
      ...(options.isAlive !== undefined ? { isAlive: options.isAlive } : {}),
    });
    return {
      transport: 'owner',
      call: (method, params) =>
        callAgentOwner(record, method, params ?? {}, {
          ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
        }),
      close: async () => {},
    };
  }

  const resolved = await resolveControlPlaneTarget({
    connectUrl: options.connectUrl,
    connectToken: options.connectToken,
    caFile: options.caFile,
    nodeId: options.nodeId,
    dataDir: options.dataDir,
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
  });
  if (!resolved.ok) {
    throw new AgentOwnerUnavailableError(resolved.error);
  }
  const target = resolved.target;
  return {
    transport: target.kind,
    call: async (method, params) => {
      try {
        return await target.request(method, params ?? {});
      } catch (error) {
        if (error instanceof RpcClientError) {
          throw new AgentOwnerRequestError(error.code, error.message, error.httpStatus);
        }
        throw new AgentOwnerUnavailableError(
          `cannot reach target at ${target.baseUrl}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
    close: () => target.close(),
  };
}
