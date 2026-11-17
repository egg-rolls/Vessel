/**
 * serve 启动选项解析（0.3 A1；0.8.1 C 收敛为单一 resolver）。
 *
 * 输入是 config loader 的最终结果：CLI flag 已在 loader 的 CLI 层合并
 * （`CLI > env > tenant overlay > project > user > default`），这里只做
 * `serve.*` → 默认值补全与启动前校验，不再单独合并 argv。
 *
 * 校验与 web 的 `GatewayOptions` 一致：非回环必须显式 allow_remote；
 * TLS 与 allow_remote 独立，但 cert/key 必须成对。
 */

import * as fs from 'node:fs';
import {
  DEFAULT_SERVE_OPTIONS,
  isLoopbackHostname,
  type VesselConfig,
} from '../packages/config/src/index';

/** 传给 `startGateway` 的解析结果 */
export interface ServeRuntimeOptions {
  hostname: string;
  port: number;
  allowRemote: boolean;
  tls?: { certFile: string; keyFile: string };
}

export type ServeOptionsResult =
  | { ok: true; options: ServeRuntimeOptions }
  | { ok: false; error: string };

/** 校验 hostname 语法（不含 scheme/path/空白） */
function validHostname(host: string): boolean {
  return host.trim() !== '' && !/\s/.test(host) && !host.includes('/') && !host.includes('://');
}

/**
 * 解析最终监听选项（单一来源：已合并 CLI 层的 config）。
 * @param config 已校验的配置
 */
export function resolveServeOptions(config: VesselConfig): ServeOptionsResult {
  const hostname = (config.node?.hostname ?? DEFAULT_SERVE_OPTIONS.hostname).trim();

  if (!validHostname(hostname)) {
    return {
      ok: false,
      error: `Invalid serve hostname "${hostname}": expected a host or IP without scheme or path.`,
    };
  }

  const port = config.node?.port ?? DEFAULT_SERVE_OPTIONS.port;
  const allowRemote = config.node?.allowRemote === true;

  if (!isLoopbackHostname(hostname) && !allowRemote) {
    return {
      ok: false,
      error:
        `Refusing to listen on non-loopback hostname "${hostname}": ` +
        'set node.allow_remote=true or pass --allow-remote to expose the gateway.',
    };
  }

  let tls: { certFile: string; keyFile: string } | undefined;
  if (config.node?.tls) {
    const { certFile, keyFile } = config.node.tls;
    if (!certFile || !keyFile) {
      return {
        ok: false,
        error: 'node.tls requires both cert_file and key_file (or pass --tls-cert/--tls-key)',
      };
    }
    tls = { certFile, keyFile };
  }

  return {
    ok: true,
    options: { hostname, port, allowRemote, ...(tls ? { tls } : {}) },
  };
}

/**
 * 启动前检查 TLS 文件存在且非空（web 会真正读取 PEM）。
 * @returns 错误文本；null 表示可用
 */
export function checkTlsFiles(
  tls: { certFile: string; keyFile: string } | undefined,
): string | null {
  if (!tls) return null;

  for (const [label, file] of [
    ['cert', tls.certFile],
    ['key', tls.keyFile],
  ] as const) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return `TLS ${label} file is not a file: ${file}`;
      if (stat.size === 0) return `TLS ${label} file is empty: ${file}`;
    } catch {
      return `TLS ${label} file not found: ${file}`;
    }
  }
  return null;
}

/**
 * 平台 → node 代理的两个响应头超时（0.57）。
 *
 * 为什么用 env 而不是新配置键：`proxy.limits` 是 serve 的**部署参数**（组合根注入），
 * 与 `serve.proxy_secret_env` 同一个套路——只读环境变量，不配就完全沿用缺省值。
 * 这样既不新增配置面（不需要改 config schema / validator），也不给「写错一个键就静默
 * 变慢」留口子。
 *
 * - `VESSEL_PROXY_TIMEOUT_MS`：普通 RPC 的响应头超时（缺省 30s，serve 侧定义）；
 * - `VESSEL_PROXY_HEALTH_TIMEOUT_MS`：健康探测类路径（`/health` 等）的响应头超时
 *   （缺省 1.5s）。node 没起来时它必须**快失败**，否则每个探活请求都白等 30s。
 *
 * 非法值（非有限正数）忽略——保持缺省，不让一个拼错的变量把超时变成 0 / NaN。
 */
export function resolveProxyTimeoutLimits(env: Record<string, string | undefined> = process.env): {
  requestTimeoutMs?: number;
  probeTimeoutMs?: number;
} {
  const positive = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    const value = Number(trimmed);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  };
  const requestTimeoutMs = positive(env.VESSEL_PROXY_TIMEOUT_MS);
  const probeTimeoutMs = positive(env.VESSEL_PROXY_HEALTH_TIMEOUT_MS);
  return {
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    ...(probeTimeoutMs !== undefined ? { probeTimeoutMs } : {}),
  };
}
