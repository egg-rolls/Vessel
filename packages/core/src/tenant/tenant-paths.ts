/**
 * tenant 目录布局（0.5 F1 / DECISION-010 §2.1 冻结）
 *
 * <data_dir>/tenants/<tenant_id>/
 *   .lock
 *   sessions/<session_id>.json
 *   sessions/<session_id>/index.json      (0.18 会话元数据)
 *   sessions/<session_id>/events.ndjson   (0.18 会话事件日志，唯一真相源)
 *   runs/<run_id>.json
 *   events/<run_id>.jsonl
 *   tenant.json
 *
 * 锁文件的读写归 asm（E15）；core 只提供路径。
 *
 * @module @vessel-agent/core/tenant
 */

import { join } from 'node:path';
import { DEFAULT_TENANT_ID } from '../types/index.js';
import { tenantRootPath } from './resolve-tenant.js';

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
