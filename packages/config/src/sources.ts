/**
 * 配置快照（0.5 E12 / A-3 §10.6）
 *
 * CLI `config show --sources` 与 web RPC 共用同一形状，保证输出一致。
 * 快照内 config 始终脱敏；sources 只含来源标签，不含值。
 *
 * @module @vessel-agent/config
 */

import { redactConfig } from './secrets.js';
import type {
  ConfigSnapshot,
  ConfigSources,
  RedactedConfigSources,
  VesselConfig,
} from './types.js';

/**
 * buildConfigSnapshot 输入。
 *
 * 0.49 T4：`tenantId` / `tenantOverlayKeys` 仅为 src/cli.ts 过渡调用保留
 * （M5 独占路径，本切片不写）；快照不再输出 tenant 字段。
 */
export interface BuildConfigSnapshotInput {
  config: VesselConfig;
  sources: ConfigSources;
  paths: { user: string; project: string };
  tenantId?: string;
  tenantOverlayKeys?: string[];
}

/** `*.apiKey` / `*.token` 的来源值不再暴露（只表示“已设置”）。 */
const SENSITIVE_SOURCE_LEAF = /(?:^|\.)(?:apiKey|token)$/;

/**
 * 脱敏来源映射（DECISION-020 §R1.1）。
 *
 * - `serve.tokens.<token>.*`：token 段替换为 `<set>`（多个 token 依次 `<set#2>`），
 *   且整条来源值替换为 `<set>`；
 * - `*.apiKey` / `*.token`：来源值替换为 `<set>`；
 * - 其它路径原样返回。
 *
 * 不修改入参。web gateway 的 `config.sources` 复用同一函数。
 */
export function redactSourcePaths(
  sources: ConfigSources | RedactedConfigSources,
): RedactedConfigSources {
  const tokenMasks = new Map<string, string>();
  const out: RedactedConfigSources = {};

  for (const [path, source] of Object.entries(sources)) {
    const segments = path.split('.');
    const isServeTokens = segments[0] === 'serve' && segments[1] === 'tokens';
    let redactedPath = path;

    if (isServeTokens && segments.length >= 3) {
      const token = segments[2] ?? '';
      let mask = tokenMasks.get(token);
      if (mask === undefined) {
        mask = tokenMasks.size === 0 ? '<set>' : `<set#${tokenMasks.size + 1}>`;
        tokenMasks.set(token, mask);
      }
      segments[2] = mask;
      redactedPath = segments.join('.');
    }

    const sensitive = isServeTokens || SENSITIVE_SOURCE_LEAF.test(path);
    out[redactedPath] = sensitive ? '<set>' : source;
  }

  return out;
}

/** 构造已脱敏的配置快照（不修改入参） */
export function buildConfigSnapshot(input: BuildConfigSnapshotInput): ConfigSnapshot {
  return {
    schema_version: 1,
    config: redactConfig(input.config),
    sources: redactSourcePaths(input.sources),
    paths: { user: input.paths.user, project: input.paths.project },
  };
}
