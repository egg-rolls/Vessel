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
  const hostname = (config.serve?.hostname ?? DEFAULT_SERVE_OPTIONS.hostname).trim();

  if (!validHostname(hostname)) {
    return {
      ok: false,
      error: `Invalid serve hostname "${hostname}": expected a host or IP without scheme or path.`,
    };
  }

  const port = config.serve?.port ?? DEFAULT_SERVE_OPTIONS.port;
  const allowRemote = config.serve?.allowRemote === true;

  if (!isLoopbackHostname(hostname) && !allowRemote) {
    return {
      ok: false,
      error:
        `Refusing to listen on non-loopback hostname "${hostname}": ` +
        'set serve.allow_remote=true or pass --allow-remote to expose the gateway.',
    };
  }

  let tls: { certFile: string; keyFile: string } | undefined;
  if (config.serve?.tls) {
    const { certFile, keyFile } = config.serve.tls;
    if (!certFile || !keyFile) {
      return {
        ok: false,
        error: 'serve.tls requires both cert_file and key_file (or pass --tls-cert/--tls-key)',
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
