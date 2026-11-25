/**
 * `config explain` 的纯逻辑（q-ax-config：AX 自服务·配置溯源）。
 * @module @vessel-agent/config
 *
 * 输入是 `loadConfig({ captureLayers: true })` 的结果，输出某个键（或键前缀下
 * 所有叶子键）的逐层值 + 谁赢 + 来源路径。值一律经 `redactConfig` 脱敏。
 *
 * 层序与 loader 一致：default → user → project → env → cli。
 * `env_file` 不是独立配置层（它只注入环境变量），当 env 层的某个变量确实来自
 * env 文件时，把该行标注为 `env_file(<path>)`，让「值从哪个文件来」一轮可见。
 *
 * 本模块不做 IO、不读 process.env（env 由调用方传入），CLI / 未来 RPC 共用。
 */

import type { EnvFileLoadInfo } from './env-file.js';
import { type ConfigLoadResult, preserveConfigMapKeys } from './loader.js';
import { redactConfig } from './secrets.js';
import type { ConfigSource, VesselConfig } from './types.js';

type EnvMap = Record<string, string | undefined>;

/** 展示层名：env_file 是 env 层的来源细分，不是第六个合并层。 */
export type ExplainLayerName = 'default' | 'user' | 'project' | 'env_file' | 'env' | 'cli';

export interface ConfigLayerValue {
  layer: ExplainLayerName;
  /** 人类可读来源：built-in / 文件路径 / 环境变量名（env_file 附文件路径） */
  origin: string;
  /** 已脱敏的层内值 */
  value: unknown;
  winner: boolean;
}

export interface ConfigKeyExplanation {
  /** 规范化后的 camelCase 点路径 */
  key: string;
  /** 已脱敏的最终生效值 */
  effective: unknown;
  /** loader 记录的来源（sources）；env_file 归入 env */
  winner: ConfigSource | 'unknown';
  layers: ConfigLayerValue[];
  notes: string[];
}

export type ExplainConfigResult =
  | {
      ok: true;
      requestedKey: string;
      keys: ConfigKeyExplanation[];
      configErrors: Array<{ path: string; message: string }>;
      configWarnings: Array<{ path: string; message: string }>;
    }
  | { ok: false; message: string; suggestions: string[] };

export interface ExplainConfigOptions {
  /** 环境变量来源（缺省 process.env）；用于标注 env 行的变量名与 env_file 归属 */
  env?: EnvMap;
  /** 与 loadConfig 相同的 env 前缀（缺省 VESSEL_） */
  envPrefix?: string;
}

/**
 * 叶子键 → 候选环境变量名（不含前缀；与 loadConfigFromEnv 的读取一一对应）。
 * 只覆盖 loader 真正从 env 读的键；其余键的 env 来源只可能来自 `_env` 引用。
 */
const ENV_VARS_BY_LEAF: Readonly<Record<string, readonly string[]>> = {
  apiKey: ['API_KEY', 'PROVIDER_API_KEY'],
  'provider.name': ['PROVIDER'],
  'provider.model': ['MODEL'],
  'provider.baseUrl': ['BASE_URL'],
  'provider.apiKey': ['PROVIDER_API_KEY', 'API_KEY'],
  'provider.temperature': ['TEMPERATURE'],
  'provider.maxTokens': ['MAX_TOKENS'],
  'feishu.appId': ['FEISHU_APP_ID'],
  'feishu.appSecret': ['FEISHU_APP_SECRET'],
  'session.backend': ['SESSION_BACKEND'],
  plugins: ['PLUGINS'],
  dataDir: ['DATA_DIR'],
  'connect.token': ['CONNECT_TOKEN', 'GATEWAY_TOKEN'],
  'connect.caFile': ['CONNECT_CA'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 用户输入键 → camelCase 点路径（map 键按 loader 同一规则保留原样）。 */
export function normalizeExplainKey(key: string): string {
  const segments = key.split('.').filter((segment) => segment !== '');
  const out: string[] = [];
  for (const segment of segments) {
    const camel = preserveConfigMapKeys(out, segment)
      ? segment
      : segment.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
    out.push(camel);
  }
  return out.join('.');
}

/**  flatten 叶子（空对象也算叶子，便于解释 `node.tokens: {}` 这类键）。 */
function flattenLeaves(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0 && prefix !== '') {
      out.set(prefix, value);
      return;
    }
    for (const [key, child] of entries) {
      flattenLeaves(child, prefix === '' ? key : `${prefix}.${key}`, out);
    }
    return;
  }
  if (prefix !== '') out.set(prefix, value);
}

/** 按点路径取值；路径不存在返回 undefined。 */
function valueAtPath(root: unknown, key: string): unknown {
  let current: unknown = root;
  for (const segment of key.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** env 行的来源细分：变量确实由 env 文件注入 → env_file(<path>)。 */
function envOrigin(
  leaf: string,
  env: EnvMap,
  envPrefix: string,
  envFiles: EnvFileLoadInfo[] | undefined,
): { layer: 'env' | 'env_file'; origin: string } {
  const candidates = ENV_VARS_BY_LEAF[leaf] ?? [];
  for (const suffix of candidates) {
    const name = `${envPrefix}${suffix}`;
    const value = env[name];
    if (value === undefined || value === '') continue;
    const fromFile = (envFiles ?? []).find((file) => file.loaded.includes(name));
    if (fromFile !== undefined) {
      return { layer: 'env_file', origin: `${fromFile.path} (${name})` };
    }
    return { layer: 'env', origin: name };
  }
  if (candidates.length > 0) {
    return {
      layer: 'env',
      origin: candidates.map((suffix) => `${envPrefix}${suffix}`).join(' / '),
    };
  }
  return { layer: 'env', origin: '_env reference' };
}

/** 未知键的候选建议：同首段叶子优先，其次公共前缀最长的叶子。 */
function suggestKeys(requested: string, leaves: string[]): string[] {
  const first = requested.split('.')[0] ?? '';
  const sameRoot = leaves.filter((leaf) => leaf.split('.')[0] === first);
  const pool = sameRoot.length > 0 ? sameRoot : leaves;
  const scored = pool
    .map((leaf) => {
      let common = 0;
      while (
        common < requested.length &&
        common < leaf.length &&
        requested[common] === leaf[common]
      ) {
        common += 1;
      }
      return { leaf, common };
    })
    .sort((a, b) => b.common - a.common || a.leaf.localeCompare(b.leaf));
  return scored.slice(0, 8).map((entry) => entry.leaf);
}

/**
 * 解释一个键（精确叶子）或键前缀（其下所有叶子）。
 * `loaded` 必须来自 `loadConfig({ captureLayers: true })`。
 */
export function explainConfigKey(
  requestedKey: string,
  loaded: ConfigLoadResult,
  options: ExplainConfigOptions = {},
): ExplainConfigResult {
  const env = options.env ?? process.env;
  const envPrefix = options.envPrefix ?? 'VESSEL_';
  const configErrors = loaded.validation.errors.map(({ path, message }) => ({ path, message }));
  const configWarnings = loaded.validation.warnings.map(({ path, message }) => ({ path, message }));

  if (requestedKey.trim() === '') {
    return {
      ok: false,
      message: 'Missing config key (e.g. data_dir / provider.model)',
      suggestions: [],
    };
  }
  if (loaded.layers === undefined) {
    return {
      ok: false,
      message: 'config explain requires loadConfig({ captureLayers: true })',
      suggestions: [],
    };
  }

  const key = normalizeExplainKey(requestedKey.trim());
  const safeConfig = redactConfig(loaded.config);
  const leaves = new Map<string, unknown>();
  flattenLeaves(safeConfig, '', leaves);

  const matched = [...leaves.keys()].filter((leaf) => leaf === key || leaf.startsWith(`${key}.`));
  if (matched.length === 0) {
    return {
      ok: false,
      message: `Unknown config key: ${requestedKey} (normalized: ${key})`,
      suggestions: suggestKeys(key, [...leaves.keys()]),
    };
  }

  const layers = loaded.layers;
  const safeLayers: Record<'default' | 'user' | 'project' | 'env' | 'cli', unknown> = {
    default: redactConfig(layers.default as VesselConfig),
    user: redactConfig(layers.user as VesselConfig),
    project: redactConfig(layers.project as VesselConfig),
    env: redactConfig(layers.env as VesselConfig),
    cli: redactConfig(layers.cli as VesselConfig),
  };

  const keys: ConfigKeyExplanation[] = matched.sort().map((leaf) => {
    const notes: string[] = [];
    const winner: ConfigSource | 'unknown' = loaded.sources[leaf] ?? 'unknown';
    const entries: ConfigLayerValue[] = [];

    const push = (layer: ExplainLayerName, origin: string, value: unknown): void => {
      entries.push({ layer, origin, value, winner: false });
    };

    const defaultValue = valueAtPath(safeLayers.default, leaf);
    if (defaultValue !== undefined) push('default', 'built-in', defaultValue);
    const userValue = valueAtPath(safeLayers.user, leaf);
    if (userValue !== undefined) push('user', loaded.paths.user, userValue);
    const projectValue = valueAtPath(safeLayers.project, leaf);
    if (projectValue !== undefined) push('project', loaded.paths.project, projectValue);
    const envValue = valueAtPath(safeLayers.env, leaf);
    if (envValue !== undefined) {
      const origin = envOrigin(leaf, env, envPrefix, loaded.envFiles);
      push(origin.layer, origin.origin, envValue);
    }
    const cliValue = valueAtPath(safeLayers.cli, leaf);
    if (cliValue !== undefined) push('cli', 'CLI flag', cliValue);

    // 谁赢：以 loader 的 sources 为准。两类特殊态需要说清而不是硬标：
    // 1) winner=env 但 env 层没有该键 ⇒ 值来自 user/project 层的 `_env` 引用解析；
    // 2) winner=default 但 default 层没有该键 ⇒ loader 后处理补的默认（如 provider.model）。
    let winnerEntry: ConfigLayerValue | undefined;
    if (winner === 'env' && envValue === undefined) {
      winnerEntry = entries
        .filter((entry) => entry.layer !== 'env' && entry.layer !== 'env_file')
        .pop();
      notes.push(
        'winner=env: value resolved from a "_env" reference in the user/project layer (the environment variable supplies the value)',
      );
    } else {
      winnerEntry = entries.find(
        (entry) => entry.layer === winner || (winner === 'env' && entry.layer === 'env_file'),
      );
    }
    if (winnerEntry !== undefined) {
      winnerEntry.winner = true;
    } else if (winner === 'default') {
      notes.push('effective value filled by loader post-processing (provider-aware default model)');
    } else if (winner === 'unknown') {
      notes.push('no source recorded for this key (map entry or loader post-processing)');
    }

    return {
      key: leaf,
      effective: leaves.get(leaf),
      winner,
      layers: entries,
      notes,
    };
  });

  return { ok: true, requestedKey: key, keys, configErrors, configWarnings };
}
