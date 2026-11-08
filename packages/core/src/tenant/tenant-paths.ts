/**
 * tenant 目录布局（0.49 T5：只保留根布局）
 *
 *   <data_dir>/
 *     sessions/<session_id>.json
 *     sessions/<session_id>/index.json      (0.18 会话元数据)
 *     sessions/<session_id>/events.ndjson   (0.18 会话事件日志，唯一真相源)
 *     runs/<run_id>.json
 *     events/<run_id>.jsonl
 *     tenant.json
 *
 * 旧树（`<data_dir>/tenants/<tenant_id>/**`）随 T2 迁移层在 0.49 T5 删除；
 * 本模块不再提供旧树解析。
 *
 * 锁文件的读写归 asm（E15）；core 只提供路径。
 *
 * @module @vessel-agent/core/tenant
 */

import { join, resolve } from 'node:path';
import { DEFAULT_TENANT_ID } from '../types/index.js';
import { assertTenantId } from './resolve-tenant.js';

/** tenant 路径集合 */
export interface TenantPaths {
  /** `<data_dir>` */
  root: string;
  sessions_dir: string;
  runs_dir: string;
  events_dir: string;
  tenant_file: string;
  lock_file: string;
}

/**
 * 单公司（单 id）根布局（0.49 T2 C1）：`<data_dir>/**`。
 *
 * `tenantId` 仍由调用方传入并校验（R1：禁止硬编码 `'default'` 替代调用方的 sid）。
 * 根布局路径本身不含 tenant 段；历史文件名段（如 `agents/<sid>.json`）由各自的
 * 路径推导函数原样保留。
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
