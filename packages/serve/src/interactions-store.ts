/**
 * 交互请求持久化（DECISION-024 Addendum A §2）。
 *
 * `<interactionsDir>/interactions-<tenant>.json`，0600 原子写。只保存权限请求：
 * pending（进程存活期间）与已应答/孤儿记录（幂等与准确的 `run_ended`）。
 * 文件损坏 / 不可读不阻断 gateway 启动：记录 stderr 后按空集处理。
 *
 * @module @vessel-agent/serve/interactions-store
 */

import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '@vessel-agent/core';

/** 持久化状态；`orphaned` = run 已终止/进程重启后找不到 run。 */
export type StoredInteractionStatus = 'pending' | 'answered' | 'orphaned';

/** 已应答结果（幂等重放）。 */
export interface StoredInteractionAnswer {
  decision: 'allow' | 'deny';
  scope: 'once' | 'session' | 'always';
  answered_at: number;
}

/** 单条持久化交互记录。 */
export interface StoredInteraction {
  requestId: string;
  run_id: string;
  tenant_id: string;
  session_id?: string;
  /** 成员 bridge 请求的父会话（additive；旧文件缺失时继续可读）。 */
  parent_session_id?: string;
  tool_call_id?: string;
  tool: string;
  input: unknown;
  created_at: number;
  status: StoredInteractionStatus;
  answer?: StoredInteractionAnswer;
}

const FILE_PREFIX = 'interactions-';
const FILE_SUFFIX = '.json';
const TENANT_FILE_PATTERN = /^[A-Za-z0-9._-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): StoredInteraction | null {
  if (!isRecord(value)) return null;
  const {
    requestId,
    run_id,
    tenant_id,
    session_id,
    parent_session_id,
    tool_call_id,
    tool,
    input,
    created_at,
    status,
    answer,
  } = value;
  if (
    typeof requestId !== 'string' ||
    requestId.length === 0 ||
    typeof run_id !== 'string' ||
    typeof tenant_id !== 'string' ||
    typeof tool !== 'string' ||
    typeof created_at !== 'number' ||
    !Number.isFinite(created_at)
  ) {
    return null;
  }
  if (status !== 'pending' && status !== 'answered' && status !== 'orphaned') return null;
  const parsedAnswer: StoredInteractionAnswer | undefined =
    isRecord(answer) &&
    (answer.decision === 'allow' || answer.decision === 'deny') &&
    (answer.scope === 'once' || answer.scope === 'session' || answer.scope === 'always') &&
    typeof answer.answered_at === 'number'
      ? {
          decision: answer.decision as StoredInteractionAnswer['decision'],
          scope: answer.scope as StoredInteractionAnswer['scope'],
          answered_at: answer.answered_at,
        }
      : undefined;
  return {
    requestId,
    run_id,
    tenant_id,
    ...(typeof session_id === 'string' && session_id.length > 0 ? { session_id } : {}),
    ...(typeof parent_session_id === 'string' && parent_session_id.length > 0
      ? { parent_session_id }
      : {}),
    ...(typeof tool_call_id === 'string' && tool_call_id.length > 0 ? { tool_call_id } : {}),
    tool,
    input,
    created_at,
    status,
    ...(parsedAnswer !== undefined ? { answer: parsedAnswer } : {}),
  };
}

/** 交互记录文件存储（按 tenant 分文件）。 */
export class InteractionsStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** tenant 名直接进文件名；只接受安全字符，其他 tenant 不落盘。 */
  pathFor(tenantId: string): string | null {
    if (!TENANT_FILE_PATTERN.test(tenantId)) return null;
    return join(this.dir, `${FILE_PREFIX}${tenantId}${FILE_SUFFIX}`);
  }

  /**
   * 启动时同步加载全部 tenant 文件。
   * 启动阶段还没有 run 存活，调用方负责把 `pending` 转成 `orphaned`。
   */
  loadAllSync(): StoredInteraction[] {
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch (error) {
      reportLoadError(this.dir, error);
      return [];
    }
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (error) {
      reportLoadError(this.dir, error);
      return [];
    }
    const records: StoredInteraction[] = [];
    for (const name of names) {
      if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) continue;
      const path = join(this.dir, name);
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        const list = isRecord(raw) && Array.isArray(raw.interactions) ? raw.interactions : raw;
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          const record = parseRecord(item);
          if (record !== null) records.push(record);
        }
      } catch (error) {
        reportLoadError(path, error);
      }
    }
    return records;
  }

  /** 原子重写某个 tenant 的记录；失败只报 stderr，不影响 RPC。 */
  async save(tenantId: string, records: readonly StoredInteraction[]): Promise<void> {
    const path = this.pathFor(tenantId);
    if (path === null) {
      console.error(`[vessel] interactions: skip persistence for unsafe tenant "${tenantId}"`);
      return;
    }
    const payload = `${JSON.stringify({ version: 1, interactions: records }, null, 2)}\n`;
    try {
      await atomicWrite(path, payload, { ensureDir: true, mode: 0o600 });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[vessel] interactions: failed to persist ${path}: ${detail}`);
    }
  }
}

function reportLoadError(path: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[vessel] interactions: failed to load ${path}: ${detail}`);
}
