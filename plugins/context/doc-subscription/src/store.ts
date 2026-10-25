/**
 * @vessel-agent/doc-subscription - per-session 订阅状态
 * @module @vessel-agent/doc-subscription/store
 *
 * 状态只落在 `stateDir` 下：`<stateDir>/sessions/<encodeURIComponent(session_id)>.json`。
 * 损坏的状态文件按空状态处理（不崩溃、不删除）；写入走同目录临时文件 + rename，
 * 目录 0700、文件 0600（Windows 上 mode 语义有限，但保持同一调用形状）。
 *
 * 两个游标：
 * - `notified_rev`：短通知已返回给模型的最新 rev；推进后同一 rev 不再通知。
 * - `seen_rev`：`inspect` 成功返回正文后的最新 rev；失败 / 超限不推进。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/** 一个订阅条目 */
export interface SubscriptionEntry {
  /** `sha256(canonicalPath).slice(0, 12)` */
  id: string;
  /** 规范化绝对路径 */
  path: string;
  /** 用户原始输入（相对路径 / `~` 形式，仅用于展示） */
  input: string;
  /** 最近一次观察到的状态：sha256 hex / `deleted` / `too_large:<size>:<mtime>` / `binary:<hash>` */
  rev: string;
  /** 最近一次短通知里的 rev；`''` = 尚未通知 */
  notified_rev: string;
  /** 最近一次 inspect 成功返回的 rev；`''` = 模型尚未看过正文 */
  seen_rev: string;
  /** 最近一次观察到的字节数 */
  size: number;
  /** 最近一次观察到的 mtime（毫秒） */
  mtime_ms: number;
  /** 最近一次通知时间（Unix ms；0 = 从未） */
  notified_at: number;
  /** 最近一次 inspect 成功时间（Unix ms；0 = 从未） */
  seen_at: number;
  /** 上一版 `seen_rev` 对应的全文（仅文本且 <= maxFullBytes 时保留） */
  snapshot?: string;
}

/** 一个 session 的订阅状态 */
export interface SessionSubscriptionState {
  v: 1;
  session_id: string;
  /** key = canonicalPath */
  subscriptions: Record<string, SubscriptionEntry>;
}

/** 空状态 */
export function emptyState(sessionId: string): SessionSubscriptionState {
  return { v: 1, session_id: sessionId, subscriptions: {} };
}

/** 订阅 id：canonicalPath 的 sha256 前 12 个 hex 字符 */
export function subscriptionId(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 12);
}

/** 类型守卫：值是否为对象记录 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 从记录读取有限数字（缺失 / 非法回落 fallback） */
function readNumber(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 从记录读取字符串（缺失 / 非法回落 fallback） */
function readString(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

/** 把磁盘上的 JSON 规整成状态；任何结构问题都降级为空状态 */
function normalizeState(sessionId: string, parsed: unknown): SessionSubscriptionState {
  if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.subscriptions)) {
    return emptyState(sessionId);
  }
  const subscriptions: Record<string, SubscriptionEntry> = {};
  for (const value of Object.values(parsed.subscriptions)) {
    if (!isRecord(value)) continue;
    const canonical = readString(value, 'path', '');
    if (canonical === '') continue;
    const rev = readString(value, 'rev', '');
    const entry: SubscriptionEntry = {
      id: readString(value, 'id', '') || subscriptionId(canonical),
      path: canonical,
      input: readString(value, 'input', canonical),
      rev,
      // 旧状态（只有 rev / delivered_at）按“已通知”迁移，避免升级后重复通知。
      notified_rev: readString(value, 'notified_rev', rev),
      seen_rev: readString(value, 'seen_rev', ''),
      size: readNumber(value, 'size', 0),
      mtime_ms: readNumber(value, 'mtime_ms', 0),
      notified_at: readNumber(value, 'notified_at', readNumber(value, 'delivered_at', 0)),
      seen_at: readNumber(value, 'seen_at', 0),
    };
    if (typeof value.snapshot === 'string') entry.snapshot = value.snapshot;
    // 以 canonical path 为唯一键，避免手改/旧文件里的键与 path 漂移造成重复条目。
    subscriptions[canonical] = entry;
  }
  return { v: 1, session_id: sessionId, subscriptions };
}

/** per-session JSON 状态存储 */
export class SubscriptionStore {
  private readonly stateDir: string;
  /** 每个 session 串行写，避免同进程内并发 save 交错 */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  /** 状态目录（供诊断/测试） */
  get dir(): string {
    return this.stateDir;
  }

  /** 状态文件路径 */
  filePath(sessionId: string): string {
    return path.join(this.stateDir, 'sessions', `${encodeURIComponent(sessionId)}.json`);
  }

  /** 读取状态；ENOENT / JSON 损坏 / 结构非法均返回空状态 */
  async load(sessionId: string): Promise<SessionSubscriptionState> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(sessionId), 'utf-8');
    } catch {
      return emptyState(sessionId);
    }
    try {
      return normalizeState(sessionId, JSON.parse(raw));
    } catch {
      return emptyState(sessionId);
    }
  }

  /** 原子写入；失败时清理临时文件并抛出（调用方决定是否吞掉） */
  async save(state: SessionSubscriptionState): Promise<void> {
    const key = state.session_id;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.write(state));
    this.chains.set(key, next);
    try {
      await next;
    } finally {
      if (this.chains.get(key) === next) this.chains.delete(key);
    }
  }

  /** 实际落盘：同目录临时文件 + rename */
  private async write(state: SessionSubscriptionState): Promise<void> {
    const dir = path.join(this.stateDir, 'sessions');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = this.filePath(state.session_id);
    const temp = path.join(
      dir,
      `.${encodeURIComponent(state.session_id)}.${process.pid}.${Date.now()}.tmp`,
    );
    try {
      await writeFile(temp, `${JSON.stringify(state)}\n`, { encoding: 'utf-8', mode: 0o600 });
      await rename(temp, target);
    } catch (error) {
      try {
        await unlink(temp);
      } catch {
        // 临时文件可能未创建
      }
      throw error;
    }
  }
}
