/**
 * CLI flag → 配置覆盖层（0.8.1 C）。
 *
 * CLI 只负责把**显式** flag 转成 `Partial<VesselConfig>`，由 config loader
 * 统一按 `CLI > env > tenant overlay > project > user > default` 合并；
 * serve / connect 不再各自读取 argv。
 *
 * @module vessel/cli-overrides
 */

import type { VesselConfig } from '../packages/config/src/index';

/** 与 `parseArgs` 结果的子集保持一致；缺省/null 表示未显式给出。 */
export interface CliConfigOverridesInput {
  /** `--serve` 解析出的端口；未给 --serve 时为 null */
  servePort?: number | null;
  /** 用户是否显式写了端口（否则交给 config.serve.port / 默认值） */
  servePortExplicit?: boolean;
  /** `--serve-host` */
  serveHost?: string | null;
  /** `--allow-remote` */
  allowRemote?: boolean;
  /** `--tls-cert` / `--tls-key`（cli-args 保证成对） */
  tlsCert?: string | null;
  tlsKey?: string | null;
  /** `--allowed-origin`（可重复；整体替换 YAML 列表） */
  allowedOrigins?: readonly string[];
  /** `--connect-token` */
  connectToken?: string | null;
  /** `--ca` / `--connect-ca` */
  caFile?: string | null;
  /** 0.15：全局 `--data-dir <path>`（CLI > env > config） */
  dataDir?: string | null;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * 构造 CLI 覆盖层。只包含显式给出的 flag，未给出的字段不出现在层里，
 * 从而让 env / project / user / default 正常生效。
 */
export function buildCliConfigOverrides(input: CliConfigOverridesInput): Partial<VesselConfig> {
  const serve: NonNullable<VesselConfig['serve']> = {};

  if (input.servePortExplicit === true && input.servePort != null) {
    serve.port = input.servePort;
  }
  const hostname = nonEmpty(input.serveHost);
  if (hostname !== undefined) serve.hostname = hostname;
  if (input.allowRemote === true) serve.allowRemote = true;
  const certFile = nonEmpty(input.tlsCert);
  const keyFile = nonEmpty(input.tlsKey);
  if (certFile !== undefined && keyFile !== undefined) {
    serve.tls = { certFile, keyFile };
  }
  if (input.allowedOrigins !== undefined && input.allowedOrigins.length > 0) {
    serve.allowedOrigins = [...input.allowedOrigins];
  }

  const connect: NonNullable<VesselConfig['connect']> = {};
  const connectToken = nonEmpty(input.connectToken);
  if (connectToken !== undefined) connect.token = connectToken;
  const caFile = nonEmpty(input.caFile);
  if (caFile !== undefined) connect.caFile = caFile;

  const dataDir = nonEmpty(input.dataDir);
  return {
    ...(Object.keys(serve).length > 0 ? { serve } : {}),
    ...(Object.keys(connect).length > 0 ? { connect } : {}),
    ...(dataDir !== undefined ? { dataDir } : {}),
  };
}
