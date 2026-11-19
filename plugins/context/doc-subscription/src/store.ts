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
 *
 * line-level 阅读订阅（蜂群协作增强）additive：
 * - `origin`：创建/升级来源（升级梯 manual > edit > read）；旧条目缺省 'manual'（永不自过期）。
 * - `reads`：read 引用记录，`reads.length` 即引用计数；清除按规范化请求值 (offset, limit)
 *   匹配删一条（相同请求的多次 read 记录可互换，删任一条语义等价）。
 * - `cleared_consumed`：单调增长的已消费清除 id ledger（段重置/pop 后同 id 再现不重复释放）。
 * 过期只由清除驱动：origin='read' 且 reads 归零才过期；压缩/pop 导致输出离开窗口不触发过期。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * 一条 read 引用（line-level 订阅）。不存 tool_call_id（AfterTool 拿不到）：
 * 每次 read 订阅追加一条，清除释放按规范化请求值匹配删一条。
 */
export interface ReadRef {
  /** 规范化请求值：offset ?? 1（1-based；非法值的 read 整个不订阅） */
  offset: number;
  /** 规范化请求值：limit ?? DEFAULT_READ_LIMIT */
  limit: number;
  /** 订阅时 clamp 后的 1-based 闭区间起始行（请求范围 ∩ 文件实际行数） */
  start?: number;
  /** 订阅时 clamp 后的 1-based 闭区间结束行 */
  end?: number;
  /** 订阅时该范围内容（仅字节数 ≤ maxFullBytes 才存；缺省 ⇒ 观察时整文件兜底） */
  text?: string;
}

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
  /** 创建/升级来源；旧条目缺省 'manual'（安全：永不自过期）。升级梯 manual > edit > read */
  origin: 'manual' | 'read' | 'edit';
  /** read 引用记录（缺省 []）；origin='read' 且归零时条目过期 */
  reads: ReadRef[];
}

/** 一个 session 的订阅状态 */
export interface SessionSubscriptionState {
  v: 1;
  session_id: string;
  /** key = canonicalPath */
  subscriptions: Record<string, SubscriptionEntry>;
  /** 单调增长的已消费清除 id ledger（缺省 []）；边缘触发释放，同 id 再现不重复释放 */
  cleared_consumed: string[];
}

/** 空状态 */
export function emptyState(sessionId: string): SessionSubscriptionState {
  return { v: 1, session_id: sessionId, subscriptions: {}, cleared_consumed: [] };
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

/** reads 防御解析：只保留规范化请求值合法的 ref；start/end/text 缺失或非法即省略 */
function normalizeReads(value: unknown): ReadRef[] {
  if (!Array.isArray(value)) return [];
  const refs: ReadRef[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const offset = item.offset;
    const limit = item.limit;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 1) continue;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) continue;
    const ref: ReadRef = { offset, limit };
    const start = item.start;
    const end = item.end;
    if (
      typeof start === 'number' &&
      Number.isInteger(start) &&
      start >= 1 &&
      typeof end === 'number' &&
      Number.isInteger(end) &&
      end >= start
    ) {
      ref.start = start;
      ref.end = end;
    }
    if (typeof item.text === 'string') ref.text = item.text;
    refs.push(ref);
  }
  return refs;
}

/** cleared_consumed 防御解析：只留非空字符串并去重（ledger 单调增长，去重不改语义） */
function normalizeConsumedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)];
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
      // 旧条目缺省 'manual'：永不自过期（安全方向）；非法值同样回落。
      origin: value.origin === 'read' || value.origin === 'edit' ? value.origin : 'manual',
      reads: normalizeReads(value.reads),
    };
    if (typeof value.snapshot === 'string') entry.snapshot = value.snapshot;
    // 以 canonical path 为唯一键，避免手改/旧文件里的键与 path 漂移造成重复条目。
    subscriptions[canonical] = entry;
  }
  return {
    v: 1,
    session_id: sessionId,
    subscriptions,
    cleared_consumed: normalizeConsumedIds(parsed.cleared_consumed),
  };
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
