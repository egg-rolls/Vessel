/**
 * tenant 解析（0.5 E15 / DECISION-010 §2.5、A-4 §11.4）
 *
 * 优先级（冻结）：
 *   explicit > cli > VESSEL_TENANT > config.tenant.default > "default"
 *
 * core 的 `resolveTenantId` 是纯函数；这里读取 env/config 并把它包装成
 * 不抛错的 result 形状，非法值报错而不是静默回退。
 *
 * @module vessel/tenant-resolution
 */

import type { VesselConfig } from '../packages/config/src/index';
import { resolveTenantId as resolveCoreTenantId, TenantIdError } from '../packages/core/src/index';

/** tenant id 来源 */
export type TenantIdSource = 'explicit' | 'cli' | 'env' | 'config' | 'default';

/** 解析输入；未提供的来源按优先级跳过 */
export interface ResolveTenantIdOptions {
  /** RuntimeOptions / bootstrap 显式传入（最高） */
  explicit?: string;
  /** CLI `--tenant`；null / undefined 视为未提供 */
  cli?: string | null;
  /** 环境变量来源；缺省 process.env */
  env?: Record<string, string | undefined>;
  /** 显式 env tenant 值；缺省读取 `env.VESSEL_TENANT`（支持自定义前缀） */
  envTenantId?: string;
  /** 已合并 user/project 的配置（读取 tenant.default） */
  config?: VesselConfig;
}

/** 解析结果；tenant id 非法时显式失败 */
export type TenantResolution =
  | { ok: true; tenantId: string; source: TenantIdSource }
  | { ok: false; code: 'invalid_tenant'; error: string };

/**
 * 按冻结优先级解析 tenant id。
 * 空白字符串视为未提供；VESSEL_TENANT 只在解析期使用，不写入 config。
 */
export function resolveTenantId(input: ResolveTenantIdOptions = {}): TenantResolution {
  const env = input.env ?? process.env;

  try {
    const result = resolveCoreTenantId({
      explicitTenantId: input.explicit,
      cliTenantId: input.cli ?? undefined,
      envTenantId: input.envTenantId ?? env.VESSEL_TENANT,
      configDefaultTenantId: input.config?.tenant?.default,
    });
    return {
      ok: true,
      tenantId: result.tenant_id,
      source: result.source as TenantIdSource,
    };
  } catch (error) {
    if (error instanceof TenantIdError) {
      return { ok: false, code: 'invalid_tenant', error: error.message };
    }
    throw error;
  }
}
