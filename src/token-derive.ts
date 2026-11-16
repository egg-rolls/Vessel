/**
 * 单一根密钥 + 派生 token：**生效优先级**（0.56）。
 *
 * 一句话：**显式配置永远赢；没配置就现算；永远不会「未配置就挂」。**
 *
 * ```
 * 平台 token : gateway.token > gateway.token_env > 派生(vessel:platform)
 * node token : node.token > node.token_env > VESSEL_GATEWAY_TOKEN > transport.token
 *              > VESSEL_NODE_TOKEN（gateway spawn 时注入）> 派生(vessel:node:<id>)
 * hub token  : hub.token_env > VESSEL_HUB_TOKEN > 派生(vessel:hub)
 * 反代密钥   : gateway.proxy_secret_env（显式，**不做兜底**）
 *              —— `token show --purpose proxy` 只把派生值当「候选值」显示，
 *                 绝不自动启用：反代那边不知道这个值，自动启用会直接把人锁在门外。
 * ```
 *
 * 派生用的是 `<dataDir>/root-secret`（HKDF，见 `@vessel-agent/config` 的
 * `root-secret` 模块）：不落盘、不缓存，用的时候现算。
 *
 * module 级约定：**所有返回值都不含日志/事件/错误文案里的 token 值**；
 * `detail` 只写来源（键名 / 环境变量名 / 文件路径）。
 *
 * @module vessel/token-derive
 */

import {
  derivePurposeToken,
  ensureRootSecret,
  parseRootSecretMaterial,
  type RootSecretErrorCode,
  readRootSecret,
  rootSecretPath,
  rotateRootSecret as rotateRootSecretFile,
  type TokenPurpose,
  tokenFingerprint,
} from '../packages/config/src/index';
import type { VesselConfig } from '../packages/config/src/index';
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { resolveDataDir } from './data-paths';
import { resolveGatewayToken } from './transport-factory';

/** node 身份文件名（`<dataDir>/node.json`）；与 `src/node-identity.ts` 同源约定。 */
const NODE_IDENTITY_FILE_NAME = 'node.json';

/** gateway spawn node 时注入的派生 token 环境变量名。 */
export const NODE_TOKEN_ENV = 'VESSEL_NODE_TOKEN';

/** hub 派生 token 的环境变量名（显式 `hub.token_env` 仍优先）。 */
export const HUB_TOKEN_ENV = 'VESSEL_HUB_TOKEN';

type EnvMap = Record<string, string | undefined>;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 解析上下文：配置 + 该用途的 dataDir（根密钥位置）+ 环境变量。 */
export interface TokenContext {
  config: VesselConfig;
  /** 根密钥所在的数据根（平台 = gateway dataDir；node = 该 node 的 dataDir）。 */
  dataDir: string;
  env?: EnvMap;
  /** 允许自动生成根密钥（默认 true = 自愈）；`false` 用于只读探测 / doctor。 */
  create?: boolean;
  /** 平台判定（权限检查用；缺省 `process.platform`，可注入以便在任意平台验证）。 */
  platform?: string;
}

/** 根密钥状态（**不含密钥值**；`fingerprint` 只是 sha256 前 8 位）。 */
export interface RootSecretState {
  secret: Buffer;
  path: string;
  source: 'env' | 'file' | 'generated';
  /** `source: 'env'` 时是那个环境变量名。 */
  envName?: string;
  /** 本次是否新建了根密钥文件（首次启动）。 */
  created: boolean;
  /** 根密钥指纹（sha256 前 8 位十六进制），用于「轮换前后确实是新的」。 */
  fingerprint: string;
}

/** 根密钥失败码：文件层错误 + token 层额外的一种（env 指向无效）。 */
export type RootSecretFailureCode = RootSecretErrorCode | 'root_secret_env_invalid';

export type RootSecretLoad =
  | { ok: true; state: RootSecretState }
  | { ok: false; code: RootSecretFailureCode; message: string };

/**
 * 读取（必要时生成）根密钥。
 *
 * - `security.root_secret_env` 指向的变量非空 → 用它（容器 / 只注入密钥的部署）；
 * - 否则读 `<dataDir>/root-secret`；不存在则**自动生成**（0600，原子写）；
 * - 文件权限宽于 0600 → 直接失败（宁可不启动，也不用可能已泄露的根密钥）。
 */
export function loadRootSecret(ctx: TokenContext): RootSecretLoad {
  const env = ctx.env ?? process.env;
  const path = rootSecretPath(ctx.dataDir);
  const envName = nonEmpty(ctx.config.security?.rootSecretEnv);

  if (envName !== undefined) {
    const material = parseRootSecretMaterial(env[envName]);
    if (material === undefined) {
      return {
        ok: false,
        code: 'root_secret_env_invalid',
        message:
          `security.root_secret_env points at ${envName}, but it is unset or shorter than 32 bytes. ` +
          'Set it (for example: export ' +
          `${envName}=$(openssl rand -base64 32)) ` +
          'or remove security.root_secret_env to use the auto-generated ' +
          `${path}.`,
      };
    }
    return {
      ok: true,
      state: {
        secret: material,
        path,
        source: 'env',
        envName,
        created: false,
        fingerprint: tokenFingerprint(material.toString('base64')),
      },
    };
  }

  if (ctx.create === false) {
    // 只读模式：不生成，只报告现状（doctor / `token list` 用它避免「跑个查询就写盘」）。
    const existing = ensureRootSecretNoCreate(path, ctx.platform);
    if (!existing.ok) return existing;
    return existing;
  }

  const read = ensureRootSecret(path, ctx.platform);
  if (!read.ok) return { ok: false, code: read.error.code, message: read.error.message };
  return {
    ok: true,
    state: {
      secret: read.value.secret,
      path,
      source: read.value.created ? 'generated' : 'file',
      created: read.value.created,
      fingerprint: tokenFingerprint(read.value.secret.toString('base64')),
    },
  };
}

/** 只读路径：文件必须已存在且权限正确；不生成。 */
function ensureRootSecretNoCreate(path: string, platform?: string): RootSecretLoad {
  const existing = readRootSecret(path, platform);
  if (!existing.ok) return { ok: false, code: existing.error.code, message: existing.error.message };
  return {
    ok: true,
    state: {
      secret: existing.value.secret,
      path,
      source: 'file',
      created: false,
      fingerprint: tokenFingerprint(existing.value.secret.toString('base64')),
    },
  };
}

/** 派生 token 的生效来源。 */
export type EffectiveTokenSource = 'explicit' | 'injected' | 'derived' | 'none';

/** 一个用途的生效 token（`token` 与 `source: 'none'` 互斥）。 */
export interface EffectiveToken {
  token?: string;
  source: EffectiveTokenSource;
  /** 来源说明（键名 / 环境变量名 / 文件路径）；**不含值**。 */
  detail?: string;
}

export type TokenResolution =
  | { ok: true; value: EffectiveToken }
  | { ok: false; code: RootSecretFailureCode; message: string };

function derivedToken(
  ctx: TokenContext,
  purpose: TokenPurpose,
  detailSuffix: string,
): TokenResolution {
  const loaded = loadRootSecret(ctx);
  if (!loaded.ok) return loaded;
  const origin =
    loaded.state.source === 'env'
      ? `env ${loaded.state.envName ?? ''}`.trim()
      : loaded.state.path;
  return {
    ok: true,
    value: {
      token: derivePurposeToken(loaded.state.secret, purpose),
      source: 'derived',
      detail: `${origin} (HKDF ${detailSuffix})`,
    },
  };
}

/**
 * 平台 token：`gateway.token` > `gateway.token_env` > 派生。
 *
 * 这是「一次升级把本地 WebUI 锁死」那条事故的直接修复点：**没有任何显式配置时
 * 也不会返回 undefined**，调用方不会再走到「必须配置 token」的 fail-closed 分支。
 */
export function effectivePlatformToken(ctx: TokenContext): TokenResolution {
  const env = ctx.env ?? process.env;
  const explicit = nonEmpty(ctx.config.gateway?.token);
  if (explicit !== undefined) {
    return { ok: true, value: { token: explicit, source: 'explicit', detail: 'gateway.token' } };
  }
  const envName = nonEmpty(ctx.config.gateway?.tokenEnv);
  const fromEnv = envName !== undefined ? nonEmpty(env[envName]) : undefined;
  if (fromEnv !== undefined) {
    return {
      ok: true,
      value: { token: fromEnv, source: 'explicit', detail: `gateway.token_env (${envName})` },
    };
  }
  return derivedToken(ctx, { kind: 'platform' }, 'vessel:platform');
}

/**
 * node token：显式配置 > `VESSEL_NODE_TOKEN`（gateway 注入）> 派生 `vessel:node:<id>`。
 *
 * `config` 必须是**该 node 自己的配置**（不是平台配置）；`dataDir` 是该 node 的
 * data root —— 这样「gateway 代算」与「node 自己现算」得到同一个值，
 * 独立启动的 node 不需要任何人给它 token。
 */
export function effectiveNodeToken(
  input: TokenContext & { nodeId: string },
): TokenResolution {
  const env = input.env ?? process.env;
  const explicit = resolveGatewayToken(input.config, env);
  if (explicit !== undefined) {
    const detail =
      nonEmpty(input.config.serve?.token) !== undefined
        ? 'node.token (serve.token alias)'
        : 'node.token_env / VESSEL_GATEWAY_TOKEN / transport.token';
    return { ok: true, value: { token: explicit, source: 'explicit', detail } };
  }
  const injected = nonEmpty(env[NODE_TOKEN_ENV]);
  if (injected !== undefined) {
    return {
      ok: true,
      value: { token: injected, source: 'injected', detail: `env ${NODE_TOKEN_ENV}` },
    };
  }
  return derivedToken(input, { kind: 'node', id: input.nodeId }, `vessel:node:${input.nodeId}`);
}

/**
 * hub token：`hub.token_env` > `VESSEL_HUB_TOKEN` > 派生 `vessel:hub`。
 *
 * 只用在 hub 进程与 `token` 子命令里；gateway 不替 hub 决定凭据。
 */
export function effectiveHubToken(ctx: TokenContext & { hubDataDir?: string }): TokenResolution {
  const env = ctx.env ?? process.env;
  const envName = nonEmpty(ctx.config.hub?.tokenEnv);
  const explicit = envName !== undefined ? nonEmpty(env[envName]) : undefined;
  if (explicit !== undefined) {
    return {
      ok: true,
      value: { token: explicit, source: 'explicit', detail: `hub.token_env (${envName})` },
    };
  }
  const injected = nonEmpty(env[HUB_TOKEN_ENV]);
  if (injected !== undefined) {
    return {
      ok: true,
      value: { token: injected, source: 'injected', detail: `env ${HUB_TOKEN_ENV}` },
    };
  }
  return derivedToken(ctx, { kind: 'hub' }, 'vessel:hub');
}

/**
 * 反代共享密钥（`proxy:<instance>`）。
 *
 * **故意不做运行时兜底**：配了 `gateway.proxy_secret_env` 才会要求反代注入头；
 * 未配置时这里返回 `none`（运行时行为 = 旧的「回环即可信」）。
 * `includeCandidate: true` 是给 `vessel token show --purpose proxy` 用的：
 * 用户想要一个派生值去配反代时能看到它，但**不会**因此改变生效状态。
 */
export function effectiveProxySecret(
  ctx: TokenContext & { instanceId: string; includeCandidate?: boolean },
): TokenResolution {
  const env = ctx.env ?? process.env;
  const envName = nonEmpty(ctx.config.gateway?.proxySecretEnv);
  const explicit = envName !== undefined ? nonEmpty(env[envName]) : undefined;
  if (explicit !== undefined) {
    return {
      ok: true,
      value: {
        token: explicit,
        source: 'explicit',
        detail: `gateway.proxy_secret_env (${envName})`,
      },
    };
  }
  const nodeEnvName = nonEmpty(ctx.config.serve?.proxySecretEnv);
  const nodeSecret = nodeEnvName !== undefined ? nonEmpty(env[nodeEnvName]) : undefined;
  if (nodeSecret !== undefined) {
    return {
      ok: true,
      value: {
        token: nodeSecret,
        source: 'explicit',
        detail: `node.proxy_secret_env (${nodeEnvName})`,
      },
    };
  }
  if (ctx.includeCandidate !== true) return { ok: true, value: { source: 'none' } };
  return derivedToken(
    ctx,
    { kind: 'proxy', id: ctx.instanceId },
    `vessel:proxy:${ctx.instanceId}`,
  );
}

/** `vessel token rotate` 的结果（不含任何 token 值）。 */
export interface RotateResult {
  path: string;
  fingerprint: string;
  /** 显式配置的 token 不受影响；true 时提示用户「在跑的 node 需要重启」。 */
  restartHint: string;
}

/**
 * 轮换根密钥：新 root ⇒ **所有派生 token 一起换**（旧值一律 401）。
 *
 * 不做「保留旧 root 一段时间」的双活：那会让「rotate」在用户眼里变成「没轮换」。
 * 显式配置的 token 不经过派生，因此完全不受影响。
 */
export function rotateRootSecret(
  ctx: TokenContext,
): { ok: true; value: RotateResult } | { ok: false; code: RootSecretFailureCode; message: string } {
  const env = ctx.env ?? process.env;
  const envName = nonEmpty(ctx.config.security?.rootSecretEnv);
  if (envName !== undefined) {
    return {
      ok: false,
      code: 'root_secret_env_invalid',
      message:
        `root secret comes from the environment variable ${envName} ` +
        '(security.root_secret_env), so it cannot be rotated here. ' +
        `Rotate it in the deployment secret store (for example: export ${envName}=` +
        '$(openssl rand -base64 32)) and restart every node.',
    };
  }
  void env;
  const path = rootSecretPath(ctx.dataDir);
  const rotated = rotateRootSecretFile(path, ctx.platform);
  if (!rotated.ok) return { ok: false, code: rotated.error.code, message: rotated.error.message };
  return {
    ok: true,
    value: {
      path,
      fingerprint: tokenFingerprint(rotated.value.secret.toString('base64')),
      restartHint:
        'All derived tokens changed. Running nodes hold the previous values in memory: ' +
        'restart them (`vessel gateway restart`) so the platform hands out the new ones.',
    },
  };
}

/** `vessel token list` 的一行（**永不含 token 值**）。 */
export interface TokenListRow {
  label: string;
  source: EffectiveTokenSource;
  /** 指纹前 8 位；`source: 'none'` 时为空。 */
  fingerprint?: string;
  detail?: string;
}

/** 列出已知用途的 token 指纹（`token list` 用）。 */
export function listTokens(input: {
  config: VesselConfig;
  dataDir: string;
  env?: EnvMap;
  nodeIds: string[];
  instanceId: string;
  hubConfigured?: boolean;
}): { ok: true; rows: TokenListRow[]; root: Omit<RootSecretState, 'secret'> } | { ok: false; code: string; message: string } {
  const ctx: TokenContext = {
    config: input.config,
    dataDir: input.dataDir,
    ...(input.env !== undefined ? { env: input.env } : {}),
  };
  const loaded = loadRootSecret(ctx);
  if (!loaded.ok) return loaded;
  const { secret: _secret, ...rootInfo } = loaded.state;

  const rows: TokenListRow[] = [];
  const push = (label: string, resolution: TokenResolution): void => {
    if (!resolution.ok) return;
    const value = resolution.value;
    rows.push({
      label,
      source: value.source,
      ...(value.token !== undefined ? { fingerprint: tokenFingerprint(value.token) } : {}),
      ...(value.detail !== undefined ? { detail: value.detail } : {}),
    });
  };

  push('platform', effectivePlatformToken(ctx));
  push('hub', effectiveHubToken(ctx));
  for (const nodeId of input.nodeIds) {
    push(`node:${nodeId}`, effectiveNodeToken({ ...ctx, nodeId }));
  }
  push(`proxy:${input.instanceId}`, effectiveProxySecret({ ...ctx, instanceId: input.instanceId }));
  return { ok: true, rows, root: rootInfo };
}

/** 全局数据根（平台视角）：`config.dataDir` / `VESSEL_DATA_DIR` / 默认值。 */
export function resolveRootSecretDataDir(
  config: VesselConfig,
  env: EnvMap = process.env,
): string {
  return resolveDataDir(config, env);
}

/**
 * 只读读取 `<dataDir>/node.json` 的 `node_id`（不创建、不改写）。
 *
 * 用途：CLI / doctor 这类「只想知道本机 node 身份」的调用方要拿派生 token，
 * 但它们**不应该**因为一次查询就把身份文件写出来（那是 `node start` 的事）。
 */
export function readKnownNodeId(dataDir: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(nodePath.join(dataDir, NODE_IDENTITY_FILE_NAME), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const id = (parsed as { node_id?: unknown }).node_id;
      return typeof id === 'string' && id !== '' ? id : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * CLI 友好的 node token 解析：显式配置 / `VESSEL_NODE_TOKEN` 优先；
 * 都没有且本机身份已知时用派生值；身份未知时返回 `source: 'none'`（不回退错误）。
 *
 * 「身份未知」不是错误：调用方（status / reload / doctor）继续走回环匿名即可。
 */
export function effectiveNodeTokenAuto(input: TokenContext & { nodeId?: string }): TokenResolution {
  const nodeId = input.nodeId ?? readKnownNodeId(input.dataDir);
  if (nodeId === undefined) {
    const env = input.env ?? process.env;
    const explicit = resolveGatewayToken(input.config, env);
    if (explicit !== undefined) {
      return { ok: true, value: { token: explicit, source: 'explicit', detail: 'node.token*' } };
    }
    const injected = nonEmpty(env[NODE_TOKEN_ENV]);
    if (injected !== undefined) {
      return {
        ok: true,
        value: { token: injected, source: 'injected', detail: `env ${NODE_TOKEN_ENV}` },
      };
    }
    return { ok: true, value: { source: 'none' } };
  }
  return effectiveNodeToken({ ...input, nodeId });
}
