/**
 * 控制面 CLI 的 RPC 目标解析（0.14）。
 *
 * - `--connect` / `VESSEL_CONNECT` → 远端 HTTP RPC；
 * - 否则选择本地运行中的 gateway（default 优先；只有一个实例时直接用它）；
 * - 只读命令不构造 runtime、不获取 tenant 写锁。
 *
 * 永不打印 token；token 只进 Authorization / auth 帧。
 *
 * @module vessel/control-plane-target
 */

import { loadConfig, type VesselConfig } from '../../packages/config/src/index';
import { resolveDataDir } from '../data/data-paths';
import {
  type CommandRunner,
  collectGatewayState,
  DEFAULT_GATEWAY_INSTANCE,
  type GatewayPidRecord,
  type GatewayStateEntry,
  type GatewayStateSnapshot,
  gatewayPidFileName,
} from '../gateway/pid';
import { gatewayBaseUrl } from '../gateway/reload';
import { resolveConnectToken, resolveGatewayToken } from '../gateway/transport-factory';
import { effectiveNodeTokenAuto, effectivePlatformToken } from '../node/token-derive';
import type { RpcClient } from '../rpc';
import { createHttpRpcClient, normalizeConnectUrl } from '../rpc/http-client';

/**
 * node_id 形状（与平台代理 `proxy-config.ts` 的 NODE_ID_PATTERN 同口径）：
 * 注册表 id 由 CLI 生成，只可能是这套字符。`--node` 直接拼进代理路径，必须先过这道闸。
 */
const NODE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** 解析选项 */
export interface ControlPlaneTargetOptions {
  connectUrl?: string | null;
  connectToken?: string | null;
  caFile?: string | null;
  tenantId?: string | null;
  config?: VesselConfig;
  env?: Record<string, string | undefined>;
  dataDir?: string;
  /** 0.15：显式选择本地实例（`gateway status --rpc --instance`） */
  instance?: string;
  /**
   * q-node-target：经平台代理把 RPC 打到指定 node（`/nodes/<id>/v1/rpc`）。
   * 与 `connectUrl` 组合 = 远端平台代理；单独给出 = 本地平台代理。
   * 缺省（undefined/null）= 逐字旧行为（直连 node/gateway 的 `/v1/rpc`）。
   */
  nodeId?: string | null;
  platform?: NodeJS.Platform;
  runCommand?: CommandRunner;
  requestTimeoutMs?: number;
  /** 测试注入：直接使用该目标（不探测 PID / 不建 HTTP 客户端） */
  target?: ControlPlaneTarget;
  /** 内部：已收集的状态视图（status 命令复用以避免二次扫描） */
  entries?: GatewayStateEntry[];
}

/** 可用的 RPC 目标 */
export interface ControlPlaneTarget {
  kind: 'local' | 'remote';
  baseUrl: string;
  token: string;
  /** 本地 attach 时的实例名（remote 为 undefined） */
  instance?: string;
  /** 本地 attach 时的 PID 记录（remote 为 undefined） */
  record?: GatewayPidRecord;
  /** q-node-target：经代理 targeting 的 node_id（直连时为 undefined） */
  nodeId?: string;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  close(): Promise<void>;
}

export type ResolveControlPlaneTargetResult =
  | { ok: true; target: ControlPlaneTarget; config: VesselConfig; dataDir: string }
  | { ok: false; error: string; code: 'no_gateway' | 'multiple_instances' | 'invalid_connect' };

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

async function readCa(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined;
  try {
    const text = await Bun.file(path).text();
    return text.trim() === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * 解析本地 attach 的实例：候选为进程仍活着的 `running` / `degraded`（running 优先，
 * default 作为同级的优先项）。多实例且无法唯一确定 → `multiple_instances`。
 */
export function selectLocalGatewayRecord(
  entries: GatewayStateEntry[],
):
  | { record: GatewayPidRecord; instance: string }
  | { error: string; code: 'no_gateway' | 'multiple_instances' } {
  const live: Array<{ instance: string; record: GatewayPidRecord; state: string }> = [];
  for (const entry of entries) {
    if (entry.record === undefined) continue;
    if (entry.state === 'running' || entry.state === 'degraded') {
      live.push({ instance: entry.instance, record: entry.record, state: entry.state });
    }
  }
  if (live.length === 0) {
    return {
      error:
        'No local gateway is running. Start one with `vessel gateway start`, or use `--connect <url>`.',
      code: 'no_gateway',
    };
  }
  const running = live.filter((entry) => entry.state === 'running');
  const pool = running.length > 0 ? running : live;
  const preferred = pool.find((entry) => entry.instance === DEFAULT_GATEWAY_INSTANCE);
  if (preferred !== undefined) return preferred;
  if (pool.length === 1) {
    const only = pool[0];
    if (only !== undefined) return { instance: only.instance, record: only.record };
  }
  return {
    error:
      `Multiple gateway instances are running (${pool.map((entry) => entry.instance).join(', ')}). ` +
      'Use `--connect <url>` to choose one.',
    code: 'multiple_instances',
  };
}

/** 解析 RPC 目标；只读命令共用。 */
export async function resolveControlPlaneTarget(
  options: ControlPlaneTargetOptions = {},
): Promise<ResolveControlPlaneTargetResult> {
  const env = options.env ?? process.env;
  const config = options.config ?? (await loadConfig({ env })).config;
  const dataDir = options.dataDir ?? resolveDataDir(config, env);
  const timeoutMs = options.requestTimeoutMs ?? 10_000;

  if (options.target !== undefined) {
    return { ok: true, target: options.target, config, dataDir };
  }

  const nodeId = nonEmpty(options.nodeId);
  if (nodeId !== undefined && !NODE_ID_PATTERN.test(nodeId)) {
    return {
      ok: false,
      error: `Invalid --node "${nodeId}": expected a node_id (letters, digits, . _ - ; max 64)`,
      code: 'invalid_connect',
    };
  }
  // 经代理时 RPC 路径换成 `/nodes/<id>/v1/rpc`；平台鉴权后由代理覆写 node token。
  const rpcPath = nodeId !== undefined ? `/nodes/${nodeId}/v1/rpc` : undefined;

  // `--node` 而无 `--connect` 恒指**本地平台**代理：不吃 VESSEL_CONNECT env 回退
  // （否则一个指向远端 node 的 env 会把「本地平台 + node」悄悄改写成「远端直连」）。
  const connectUrl =
    nonEmpty(options.connectUrl) ??
    (nodeId === undefined ? nonEmpty(env.VESSEL_CONNECT) : undefined);
  if (connectUrl !== undefined) {
    const baseUrl = normalizeConnectUrl(connectUrl);
    // R-7：显式凭据链（--connect-token > VESSEL_CONNECT_TOKEN > connect.token >
    // resolveGatewayToken）皆空时补**只读派生回退**（create:false，查询不写盘）：
    // - 经代理（--node）：平台 token（与本地代理路 localPlatformToken 同口径）；
    // - 直连：node 生效 token（effectiveNodeTokenAuto，node stop / fleet restart
    //   兄弟 seam 同口径；serve 网关把该派生值注册为追加 admin 凭据）。
    // 派生不可得（无 root-secret / 未知 node id）→ undefined → ''（逐字旧行为）。
    const token =
      resolveConnectToken(config, { connectToken: options.connectToken, env }) ??
      (nodeId !== undefined
        ? localPlatformToken()
        : (() => {
            const resolved = effectiveNodeTokenAuto({ config, dataDir, env, create: false });
            return resolved.ok ? resolved.value.token : undefined;
          })()) ??
      '';
    const ca = await readCa(nonEmpty(options.caFile) ?? nonEmpty(config.connect?.caFile));
    const client: RpcClient & { close(): Promise<void> } = createHttpRpcClient({
      baseUrl,
      token,
      subscribe: false,
      requestTimeoutMs: timeoutMs,
      ...(rpcPath !== undefined ? { rpcPath } : {}),
      ...(ca !== undefined ? { ca } : {}),
    });
    return {
      ok: true,
      config,
      dataDir,
      target: {
        kind: 'remote',
        baseUrl,
        token,
        ...(nodeId !== undefined ? { nodeId } : {}),
        request: (method, params) => client.request(method, params),
        close: () => client.close(),
      },
    };
  }

  let entries: GatewayStateSnapshot['entries'];
  if (options.entries !== undefined) {
    entries = options.entries;
  } else {
    // 经代理 targeting 本地平台时，探活用平台 token（与 localTarget 的凭据同口径）。
    const token =
      nodeId !== undefined
        ? (nonEmpty(options.connectToken) ??
          nonEmpty(env.VESSEL_CONNECT_TOKEN) ??
          localPlatformToken())
        : resolveGatewayToken(config, env);
    entries = (
      await collectGatewayState(dataDir, {
        ...(token !== undefined ? { token } : {}),
      })
    ).entries;
  }

  /** 本地平台 token（只读派生，不生成 root-secret）；不可读 → undefined（回环匿名）。 */
  function localPlatformToken(): string | undefined {
    const resolved = effectivePlatformToken({ config, dataDir, env, create: false });
    return resolved.ok ? resolved.value.token : undefined;
  }

  async function localTarget(instance: string, record: GatewayPidRecord) {
    // 经代理 targeting 本地平台时，凭据是**平台 token**（gateway.token >
    // gateway.token_env > 派生 vessel:platform），不是 node token 键；
    // 显式 --connect-token / VESSEL_CONNECT_TOKEN 仍然最优先。
    const token =
      nodeId !== undefined
        ? (nonEmpty(options.connectToken) ??
          nonEmpty(env.VESSEL_CONNECT_TOKEN) ??
          localPlatformToken() ??
          '')
        : (resolveGatewayToken(config, env) ?? '');
    const tls = config.node?.tls !== undefined;
    const baseUrl = gatewayBaseUrl(record, tls);
    const ca = tls
      ? await readCa(nonEmpty(config.connect?.caFile) ?? nonEmpty(config.node?.tls?.certFile))
      : undefined;
    const client: RpcClient & { close(): Promise<void> } = createHttpRpcClient({
      baseUrl,
      token,
      subscribe: false,
      requestTimeoutMs: timeoutMs,
      ...(rpcPath !== undefined ? { rpcPath } : {}),
      ...(ca !== undefined ? { ca } : {}),
    });
    return {
      ok: true as const,
      config,
      dataDir,
      target: {
        kind: 'local' as const,
        baseUrl,
        token,
        instance,
        record,
        ...(nodeId !== undefined ? { nodeId } : {}),
        request: <T = unknown>(method: string, params?: unknown) =>
          client.request<T>(method, params),
        close: () => client.close(),
      },
    };
  }

  if (options.instance !== undefined) {
    const match = entries.find((entry) => entry.instance === options.instance);
    if (
      match === undefined ||
      match.record === undefined ||
      (match.state !== 'running' && match.state !== 'degraded')
    ) {
      return {
        ok: false,
        error: `Gateway instance "${options.instance}" is not running.`,
        code: 'no_gateway',
      };
    }
    return localTarget(match.instance, match.record);
  }
  const selected = selectLocalGatewayRecord(entries);
  if ('error' in selected) {
    return { ok: false, error: selected.error, code: selected.code };
  }
  return localTarget(selected.instance, selected.record);
}

/** PID 文件展示用（status 无 attach 时） */
export function pidFileName(instance: string): string {
  return gatewayPidFileName(instance);
}
