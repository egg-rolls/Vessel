/**
 * tenant 目录布局（0.5 F1 / DECISION-010 §2.1 冻结；0.49 T2 C1 增加单公司根布局）
 *
 * 旧树（`resolveTenantPaths`，非单 id / 迁移 / 回滚）：
 *   <data_dir>/tenants/<tenant_id>/
 *     .lock
 *     sessions/<session_id>.json
 *     sessions/<session_id>/index.json      (0.18 会话元数据)
 *     sessions/<session_id>/events.ndjson   (0.18 会话事件日志，唯一真相源)
 *     runs/<run_id>.json
 *     events/<run_id>.jsonl
 *     tenant.json
 *
 * 单公司根布局（`resolveSingleTenantPaths`，T2 迁移后）：
 *   <data_dir>/sessions|runs|events|tenant.json|.lock（不再拼接 `tenants/<id>`）
 *
 * 锁文件的读写归 asm（E15）；core 只提供路径。
 *
 * @module @vessel-agent/core/tenant
 */

import { join, resolve } from 'node:path';
import { DEFAULT_TENANT_ID } from '../types/index.js';
import { assertTenantId, tenantRootPath } from './resolve-tenant.js';

/** tenant 路径集合（E2 冻结形状） */
export interface TenantPaths {
  tenant_id: string;
  /** `<data_dir>/tenants/<tenant_id>` */
  root: string;
  sessions_dir: string;
  runs_dir: string;
  events_dir: string;
  tenant_file: string;
  lock_file: string;
}

/** 按 tenant 派生冻结目录布局 */
export function resolveTenantPaths(
  baseDataDir: string,
  tenantId: string = DEFAULT_TENANT_ID,
): TenantPaths {
  const root = tenantRootPath(baseDataDir, tenantId);
  return {
    tenant_id: tenantId,
    root,
    sessions_dir: join(root, 'sessions'),
    runs_dir: join(root, 'runs'),
    events_dir: join(root, 'events'),
    tenant_file: join(root, 'tenant.json'),
    lock_file: join(root, '.lock'),
  };
}

/**
 * 单公司（单 id）根布局（0.49 T2 C1）：`<data_dir>/**`。
 *
 * 与 `resolveTenantPaths` 的旧树语义（`<data_dir>/tenants/<id>`）并存；只有确定
 * 单 id 的调用方可以使用本函数。`tenant_id` 由调用方传入，缺省 `default`。
 */
export function resolveSingleTenantPaths(
  baseDataDir: string,
  tenantId: string = DEFAULT_TENANT_ID,
): TenantPaths {
  if (typeof baseDataDir !== 'string' || baseDataDir.trim() === '') {
    throw new Error('invalid_data_dir: baseDataDir must be a non-empty string');
  }
  assertTenantId(tenantId);
  const root = resolve(baseDataDir);
  return {
    tenant_id: tenantId,
    root,
    sessions_dir: join(root, 'sessions'),
    runs_dir: join(root, 'runs'),
    events_dir: join(root, 'events'),
    tenant_file: join(root, 'tenant.json'),
    lock_file: join(root, '.lock'),
  };
}

/**
 * 按单 id 判定选择布局（0.49 T2 C1）：单 id → 根布局；其它 id → 旧树。
 *
 * 非单 id 永远解析到 `<data_dir>/tenants/<id>`，不得读到根布局的
 * `tenant.json` / sessions。
 */
export function pathsForTenant(
  baseDataDir: string,
  tenantId: string,
  singleTenantId: string,
): TenantPaths {
  assertTenantId(tenantId);
  assertTenantId(singleTenantId);
  if (tenantId === singleTenantId) {
    return resolveSingleTenantPaths(baseDataDir, tenantId);
  }
  return resolveTenantPaths(baseDataDir, tenantId);
}

/** 会话目录名（编码后，避免路径分隔符与遍历） */
export function encodeSessionDirName(sessionId: string): string {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('invalid_session_id: session_id must be a non-empty string');
  }
  return encodeURIComponent(sessionId);
}

/**
 * 会话目录（0.18，additive）：`<sessions_dir>/<encodeURIComponent(session_id)>/`。
 *
 * 与旧版 `<sessions_dir>/<session_id>.json` 并存；目录只放 `index.json` 与
 * `events.ndjson`，不改变已有 `TenantPaths` 字段语义。
 */
export function sessionDirPath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, encodeSessionDirName(sessionId));
}

/** 会话事件日志文件：`<sessions_dir>/<session_id>/events.ndjson` */
export function sessionEventsFilePath(sessionsDir: string, sessionId: string): string {
  return join(sessionDirPath(sessionsDir, sessionId), 'events.ndjson');
}

/** 会话元数据文件：`<sessions_dir>/<session_id>/index.json` */
export function sessionIndexFilePath(sessionsDir: string, sessionId: string): string {
  return join(sessionDirPath(sessionsDir, sessionId), 'index.json');
}
