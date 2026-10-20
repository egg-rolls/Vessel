/**
 * tenant 解析（0.5 F4 / DECISION-010 §2.5）
 *
 * 优先级（冻结）：
 *   explicit > cli > env > config > default
 *
 * core 不读 env/argv/YAML；调用方（asm）把各来源取出后传入。
 *
 * @module @vessel-agent/core/tenant
 */

import { resolve, sep } from 'node:path';
import {
  DEFAULT_TENANT_ID,
  TENANT_ID_PATTERN,
  type TenantContext,
  TenantIdError,
  type TenantSource,
} from '../types/index.js';

/** 解析输入（按优先级从高到低） */
export interface ResolveTenantIdInput {
  /** 显式 API 参数（最高） */
  explicitTenantId?: string;
  /** CLI `--tenant` */
  cliTenantId?: string;
  /** env `VESSEL_TENANT` */
  envTenantId?: string;
  /** `~/.vessel/config.yaml` 的 `tenant.default` */
  configDefaultTenantId?: string;
}

/** 校验 tenant id；非法值抛 TenantIdError（不静默回退） */
export function assertTenantId(value: string): string {
  if (typeof value !== 'string' || !TENANT_ID_PATTERN.test(value)) {
    throw new TenantIdError(typeof value === 'string' ? value : String(value));
  }
  return value;
}

/** 空白视为未配置 */
function normalize(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 按优先级解析 tenant id，并返回来源 */
export function resolveTenantId(input: ResolveTenantIdInput = {}): {
  tenant_id: string;
  source: TenantSource;
} {
  const candidates: Array<[TenantSource, string | undefined]> = [
    ['explicit', input.explicitTenantId],
    ['cli', input.cliTenantId],
    ['env', input.envTenantId],
    ['config', input.configDefaultTenantId],
  ];

  for (const [source, raw] of candidates) {
    const value = normalize(raw);
    if (value !== undefined) {
      return { tenant_id: assertTenantId(value), source };
    }
  }

  return { tenant_id: DEFAULT_TENANT_ID, source: 'default' };
}

/** resolveTenant 输入 */
export interface ResolveTenantInput<Config = unknown> extends ResolveTenantIdInput {
  /** 全局数据根（`data_dir`），tenant 目录由其派生 */
  baseDataDir: string;
  /** 已合并 tenant overlay 的配置 */
  config: Config;
}

/** 派生并校验 tenant 根目录 */
export function tenantRootPath(baseDataDir: string, tenantId: string): string {
  if (typeof baseDataDir !== 'string' || baseDataDir.trim() === '') {
    throw new Error('invalid_data_dir: baseDataDir must be a non-empty string');
  }
  assertTenantId(tenantId);
  const base = resolve(baseDataDir);
  const root = resolve(base, 'tenants', tenantId);
  if (root !== base && !root.startsWith(`${base}${sep}`)) {
    throw new TenantIdError(tenantId, 'resolved path escapes base data dir');
  }
  return root;
}

/**
 * 解析 tenant 上下文。`data_dir` 是 tenant 根目录（冻结语义）。
 */
export function resolveTenant<Config>(input: ResolveTenantInput<Config>): TenantContext<Config> {
  const { tenant_id } = resolveTenantId(input);
  return {
    tenant_id,
    data_dir: tenantRootPath(input.baseDataDir, tenant_id),
    config: input.config,
  };
}
