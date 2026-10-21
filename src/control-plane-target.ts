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

import { loadConfig, type VesselConfig } from '../packages/config/src/index';
import { resolveDataDir } from './data-paths';
import {
  type CommandRunner,
  DEFAULT_GATEWAY_INSTANCE,
  type GatewayPidRecord,
  gatewayPidFileName,
  listGatewayPidStates,
} from './gateway/pid';
import { gatewayBaseUrl } from './gateway/reload';
import type { RpcClient } from './rpc';
import { createHttpRpcClient, normalizeConnectUrl } from './rpc/http-client';
import { resolveGatewayToken } from './transport-factory';

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
  platform?: NodeJS.Platform;
  runCommand?: CommandRunner;
  requestTimeoutMs?: number;
  /** 测试注入：直接使用该目标（不探测 PID / 不建 HTTP 客户端） */
  target?: ControlPlaneTarget;
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
 * 解析本地 attach 的实例：default 优先；否则只有一个运行实例时用它。
 * 多实例且 default 未运行 → `multiple_instances`（提示用 --connect）。
 */
export function selectLocalGatewayRecord(
  entries: Awaited<ReturnType<typeof listGatewayPidStates>>,
):
  | { record: GatewayPidRecord; instance: string }
  | { error: string; code: 'no_gateway' | 'multiple_instances' } {
  const running: Array<{ instance: string; record: GatewayPidRecord }> = [];
  for (const entry of entries) {
    if (entry.state.kind === 'running') {
      running.push({ instance: entry.instance, record: entry.state.record });
    }
  }
  if (running.length === 0) {
    return {
      error:
        'No local gateway is running. Start one with `vessel gateway start`, or use `--connect <url>`.',
      code: 'no_gateway',
    };
  }
  const preferred = running.find((entry) => entry.instance === DEFAULT_GATEWAY_INSTANCE);
  if (preferred !== undefined) return preferred;
  if (running.length === 1) {
    const only = running[0];
    if (only !== undefined) return only;
  }
  return {
    error:
      `Multiple gateway instances are running (${running.map((entry) => entry.instance).join(', ')}). ` +
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

  const connectUrl = nonEmpty(options.connectUrl) ?? nonEmpty(env.VESSEL_CONNECT);
  if (connectUrl !== undefined) {
    const baseUrl = normalizeConnectUrl(connectUrl);
    const token =
      nonEmpty(options.connectToken) ??
      nonEmpty(env.VESSEL_CONNECT_TOKEN) ??
      nonEmpty(config.connect?.token) ??
      nonEmpty(config.serve?.token) ??
      nonEmpty(config.transport?.token) ??
      '';
    const ca = await readCa(nonEmpty(options.caFile) ?? nonEmpty(config.connect?.caFile));
    const client: RpcClient & { close(): Promise<void> } = createHttpRpcClient({
      baseUrl,
      token,
      subscribe: false,
      requestTimeoutMs: timeoutMs,
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
        request: (method, params) => client.request(method, params),
        close: () => client.close(),
      },
    };
  }

  const entries = await listGatewayPidStates(dataDir, {
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
  });

  async function localTarget(instance: string, record: GatewayPidRecord) {
    const token = resolveGatewayToken(config, env) ?? '';
    const tls = config.serve?.tls !== undefined;
    const baseUrl = gatewayBaseUrl(record, tls);
    const ca = tls
      ? await readCa(nonEmpty(config.connect?.caFile) ?? nonEmpty(config.serve?.tls?.certFile))
      : undefined;
    const client: RpcClient & { close(): Promise<void> } = createHttpRpcClient({
      baseUrl,
      token,
      subscribe: false,
      requestTimeoutMs: timeoutMs,
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
        request: <T = unknown>(method: string, params?: unknown) =>
          client.request<T>(method, params),
        close: () => client.close(),
      },
    };
  }

  if (options.instance !== undefined) {
    const match = entries.find((entry) => entry.instance === options.instance);
    if (match === undefined || match.state.kind !== 'running') {
      return {
        ok: false,
        error: `Gateway instance "${options.instance}" is not running.`,
        code: 'no_gateway',
      };
    }
    return localTarget(match.instance, match.state.record);
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
