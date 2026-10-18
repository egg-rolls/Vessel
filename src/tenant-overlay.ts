/**
 * tenant 配置 overlay 合并（0.5 E14 / A-3 §10.6、A-4 §11.4）
 *
 * 冻结规则：
 * - 对象深合并、标量 tenant 优先、数组整体替换；plugins 按 name 合并；
 * - mcpServers 按 server 名并集并深合并；
 * - null 拒绝且不进入合并；
 * - 白名单：provider/agent/context/limits/termination/session/plugins/workflow/
 *   evals/feishu/tools/mcpServers/delegate/team/host/scheduler/transport/quota；
 *   禁止 dataDir/trace/serve/tenant/update；未知块 → error；
 * - 显式密钥 → error（只允许 `_env`）；tools/quota 由 tenant 设置层消费，不进入 VesselConfig。
 *
 * 调用方负责先做 `_env` 解析；返回的 config 不修改入参。
 *
 * @module vessel/tenant-overlay
 */

import {
  type ConfigValidationError,
  deepMerge,
  findExplicitSecretPaths,
  TENANT_OVERLAY_ALLOWED_KEYS,
  TENANT_OVERLAY_FORBIDDEN_KEYS,
  type VesselConfig,
} from '../packages/config/src/index';

/** mergeTenantOverlay 选项 */
export interface MergeTenantOverlayOptions {
  tenantId: string;
}

/** 合并结果 */
export interface MergeTenantOverlayResult {
  config: VesselConfig;
  /** overlay 命中的叶子键（camelCase 点路径） */
  overlayKeys: string[];
  errors: ConfigValidationError[];
}

/** tenant 设置层字段，不进入 VesselConfig */
const SETTINGS_ONLY_KEYS = new Set(['tools', 'quota']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinPath(prefix: string, key: string): string {
  return prefix === '' ? key : `${prefix}.${key}`;
}

/** 找出 overlay 内所有 null 的路径 */
function findNullPaths(value: unknown, path: string[]): string[] {
  if (value === null) return [path.join('.')];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findNullPaths(item, [...path, String(index)]));
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => findNullPaths(child, [...path, key]));
}

/** 去掉 null（已报错，不进入合并） */
function stripNulls(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) {
    return value.map(stripNulls).filter((item) => item !== undefined);
  }
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const stripped = stripNulls(child);
    if (stripped !== undefined) result[key] = stripped;
  }
  return result;
}

/** plugins：按 name 合并；全局顺序保留，tenant-only 条目按 overlay 顺序追加 */
function mergePlugins(base: unknown, overlay: unknown): unknown {
  if (!Array.isArray(overlay)) return structuredClone(overlay);

  const result: unknown[] = Array.isArray(base) ? base.map((item) => structuredClone(item)) : [];
  for (const entry of overlay) {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      result.push(structuredClone(entry));
      continue;
    }
    const index = result.findIndex(
      (candidate) => isRecord(candidate) && candidate.name === entry.name,
    );
    if (index >= 0) {
      const current = result[index];
      result[index] = isRecord(current) ? deepMerge(current, entry) : structuredClone(entry);
    } else {
      result.push(structuredClone(entry));
    }
  }
  return result;
}

/** 递归合并；记录 overlay 叶子键 */
function mergeNode(
  target: Record<string, unknown>,
  overlay: Record<string, unknown>,
  path: string[],
  overlayKeys: string[],
): void {
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;

    // 顶层白名单已由调用方过滤；这里只处理对象/数组/标量。
    if (Array.isArray(value)) {
      const merged = key === 'plugins' ? mergePlugins(target[key], value) : structuredClone(value);
      target[key] = merged;
      overlayKeys.push([...path, key].join('.'));
      continue;
    }

    if (isRecord(value)) {
      const current = target[key];
      if (isRecord(current)) {
        mergeNode(current, value, [...path, key], overlayKeys);
      } else {
        const created: Record<string, unknown> = {};
        target[key] = created;
        mergeNode(created, value, [...path, key], overlayKeys);
      }
      continue;
    }

    target[key] = value;
    overlayKeys.push([...path, key].join('.'));
  }
}

/**
 * 合并 tenant overlay。
 *
 * `base` 应是已合并 user/project 的配置；tenant overlay 只覆盖这两层。
 */
export function mergeTenantOverlay(
  base: VesselConfig,
  overlay: Partial<VesselConfig>,
  options: MergeTenantOverlayOptions,
): MergeTenantOverlayResult {
  const prefix = `tenant.tenants.${options.tenantId}.config`;
  const errors: ConfigValidationError[] = [];
  const overlayKeys: string[] = [];
  const config = structuredClone(base);

  if (!isRecord(overlay)) {
    return {
      config,
      overlayKeys,
      errors: [{ path: prefix, message: 'tenant config overlay must be an object' }],
    };
  }

  // 1. null 拒绝
  for (const nullPath of findNullPaths(overlay, [])) {
    errors.push({
      path: joinPath(prefix, nullPath),
      message: 'null is not allowed in a tenant config overlay',
    });
  }

  // 2. 显式密钥拒绝（只允许 _env）
  for (const secretPath of findExplicitSecretPaths(overlay, prefix)) {
    errors.push({
      path: secretPath,
      message: 'Tenant overlay may contain secrets only via the _env form',
    });
  }

  // 3. 白名单过滤
  const sanitized: Record<string, unknown> = {};
  const stripped = stripNulls(overlay);
  if (isRecord(stripped)) {
    for (const [key, value] of Object.entries(stripped)) {
      if (SETTINGS_ONLY_KEYS.has(key)) continue; // tools/quota 由 tenant 设置层消费
      if (TENANT_OVERLAY_ALLOWED_KEYS.includes(key)) {
        sanitized[key] = value;
        continue;
      }
      errors.push({
        path: joinPath(prefix, key),
        message: TENANT_OVERLAY_FORBIDDEN_KEYS.includes(key)
          ? `"${key}" is not allowed in a tenant config overlay`
          : `Unknown tenant overlay key "${key}"`,
      });
    }
  }

  // 4. 深合并并记录命中键
  mergeNode(config as unknown as Record<string, unknown>, sanitized, [], overlayKeys);

  return { config, overlayKeys, errors };
}
