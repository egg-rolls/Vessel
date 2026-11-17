/**
 * 投影快照的**文件实现**（`sessions/<id>.projection.json`，原子写）。
 *
 * 为什么与事件日志同目录：它描述的就是这一条会话的事件折叠到哪（删会话时一起删）。
 * 为什么单独一个文件而不是塞进会话壳：壳是「给人看的投影 + 元数据」，一次 run 里被读写
 * 多次（`saveSessionState`），而快照要装的是**整份折出来的消息**（真实会话 1.3 MB）——
 * 塞进壳会让每一次壳写都多一份体积。分开存，两边互不牵连。
 *
 * 失败语义（与端口契约一致）：读坏 / 读不到 / 版本不认 ⇒ `undefined`；写失败 ⇒ 只记日志。
 * **绝不抛**：调用点在 `loadStoredHistory` 与 run 收尾路径上。
 *
 * @module @vessel-agent/core/session
 */

import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../types/logging.js';
import {
  PROJECTION_CACHE_VERSION,
  type ProjectionCachePort,
  type ProjectionCacheSnapshot,
} from '../types/projection-cache.js';
import type { Message } from '../types/provider.js';
import { atomicWrite } from './atomic-write.js';
import {
  createProjectionCursor,
  PROJECTION_CURSOR_MAX_TOOL_CALLS,
  type ProjectionCursor,
} from './project-messages.js';

/** 文件名后缀：`<sessionId>.projection.json`（与会话壳 `<sessionId>.json` 并列）。 */
export const PROJECTION_CACHE_SUFFIX = '.projection.json';

/**
 * 单份快照的硬上限（字节）。
 *
 * 超过就不写：这份缓存的价值是「省一次整份读」，而一份 3 MB 的快照在**每次 run 收尾**
 * 都要序列化一遍 —— 输入输出两边都变贵时它就该退回「整份读」。缺省 24 MB 覆盖本机最大
 * 的真实会话（1.3 MB 消息），只是兜底防呆。
 */
export const PROJECTION_CACHE_MAX_BYTES = 24 * 1024 * 1024;

/** 一条快照的文件读写实现（best-effort）。 */
export class FileProjectionCache implements ProjectionCachePort {
  private readonly dir: string;
  private readonly logger?: Logger;
  private readonly maxBytes: number;

  constructor(options: { dir: string; logger?: Logger; maxBytes?: number }) {
    this.dir = options.dir;
    this.logger = options.logger;
    this.maxBytes = options.maxBytes ?? PROJECTION_CACHE_MAX_BYTES;
  }

  private pathOf(sessionId: string): string {
    // 会话 id 来自控制面（uuid / 显式 id），不在这里做转义：写入 / 读取 / 删除同一个函数，
    // 越界由 `evaluatePath` 那一侧管（本类只被装配层用目录常量构造）。
    return join(this.dir, `${sessionId}${PROJECTION_CACHE_SUFFIX}`);
  }

  async load(sessionId: string): Promise<ProjectionCacheSnapshot | undefined> {
    let text: string;
    try {
      text = await readFile(this.pathOf(sessionId), 'utf8');
    } catch {
      // 不存在是常态（第一次跑 / 刚删过），不是错误。
      return undefined;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.logger?.debug('session projection cache unreadable', { session_id: sessionId });
      return undefined;
    }
    const snapshot = readSnapshot(raw, sessionId);
    if (snapshot === undefined) {
      this.logger?.debug('session projection cache ignored', { session_id: sessionId });
    }
    return snapshot;
  }

  async save(sessionId: string, payload: string): Promise<void> {
    if (payload.length > this.maxBytes) {
      this.logger?.debug('session projection cache too large', {
        session_id: sessionId,
        bytes: payload.length,
      });
      return;
    }
    try {
      // durable: false —— 这是缓存：写丢了只会让下次多读一份日志，没有「事实」要保鲜；
      // 为它付一次 fsync 反而把它变回热路径上的固定成本。
      await atomicWrite(this.pathOf(sessionId), payload, { ensureDir: true, durable: false });
    } catch (error) {
      this.logger?.warn('session projection cache write failed', {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async clear(sessionId: string): Promise<void> {
    try {
      await unlink(this.pathOf(sessionId));
    } catch {
      // 不存在 / 被占用：删会话的主流程不因为这份缓存失败。
    }
  }
}

/** 逐字段宽松校验：认不出 / 版本不认 / 归属不符 ⇒ `undefined`（绝不编一个快照）。 */
function readSnapshot(raw: unknown, sessionId: string): ProjectionCacheSnapshot | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.v !== PROJECTION_CACHE_VERSION) return undefined;
  if (record.session_id !== sessionId) return undefined;
  const seq = record.seq;
  const count = record.count;
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq <= 0) return undefined;
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return undefined;
  if (!Array.isArray(record.messages)) return undefined;
  const messages = record.messages as Message[];
  if (messages.length === 0) return undefined;
  // 每条消息只做**形状**校验（角色的值域 + content 是字符串）：过不了就整份不认。
  // 逐条丢弃会静默改变投影（少一条历史），比退回整份读更糟。
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) return undefined;
    const role = message.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
      return undefined;
    }
    if (typeof message.content !== 'string') return undefined;
  }
  const lastAssistant = record.last_assistant;
  const lastIndex =
    typeof lastAssistant === 'number' && Number.isInteger(lastAssistant) ? lastAssistant : -1;
  const lastRequestTokens = record.last_request_tokens;
  const toolStarts = record.tool_starts;
  const pairs: Array<[string, { name: string; arguments: string }]> = [];
  if (Array.isArray(toolStarts)) {
    for (const entry of toolStarts) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, value] = entry as [unknown, unknown];
      if (typeof id !== 'string' || id.length === 0) continue;
      if (typeof value !== 'object' || value === null) continue;
      const name = (value as { name?: unknown }).name;
      const args = (value as { arguments?: unknown }).arguments;
      if (typeof name !== 'string' || typeof args !== 'string') continue;
      pairs.push([id, { name, arguments: args }]);
    }
  }
  return {
    v: PROJECTION_CACHE_VERSION,
    session_id: sessionId,
    seq,
    count,
    last_assistant: lastIndex >= 0 && lastIndex < messages.length ? lastIndex : -1,
    ...(typeof lastRequestTokens === 'number' && Number.isFinite(lastRequestTokens)
      ? { last_request_tokens: lastRequestTokens }
      : {}),
    rewound_seen: record.rewound_seen === true,
    messages,
    ...readMessageSeqs(record.message_seqs),
    tool_starts: pairs,
  };
}

/**
 * 校验 `message_seqs`（additive，0.56）。
 *
 * 只接受「与消息条数相同的数组，元素是非负整数或 null」。长度不符 / 形状不对 ⇒ **整份不认**
 * （不是逐条丢：一份错位的映射会让「按区间读回」读出别人的历史）。缺省 = 旧快照 ⇒ 不写字段。
 */
function readMessageSeqs(raw: unknown): { message_seqs?: Array<number | null> } {
  if (!Array.isArray(raw)) return {};
  const seqs: Array<number | null> = [];
  for (const entry of raw) {
    if (entry === null) {
      seqs.push(null);
      continue;
    }
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry <= 0) return {};
    seqs.push(entry);
  }
  return { message_seqs: seqs };
}

/**
 * 把一条投影游标序列化成快照 JSON（**同步**完成，便于调用方立刻放手）。
 *
 * 返回 `undefined` = 「这份游标不值得存」：没有 seq / 没有消息 / 实参表超上界。
 * 三种都只意味着下次整份读，不影响正确性。
 *
 * `last_assistant` 存**下标**而不是对象：`run.completed.output` 要就地改写「最后一条
 * assistant 正文」，重启后必须指回同一个对象，否则终态输出会写到一条孤儿消息上。
 */
export function serializeProjectionCursor(
  sessionId: string,
  cursor: ProjectionCursor,
): string | undefined {
  if (cursor.seq === undefined || cursor.seq <= 0) return undefined;
  if (cursor.messages.length === 0) return undefined;
  if (cursor.toolStarts.size > PROJECTION_CURSOR_MAX_TOOL_CALLS) return undefined;
  const lastAssistantIndex =
    cursor.lastAssistant === undefined ? -1 : cursor.messages.indexOf(cursor.lastAssistant);
  const snapshot: ProjectionCacheSnapshot = {
    v: PROJECTION_CACHE_VERSION,
    session_id: sessionId,
    seq: cursor.seq,
    count: cursor.count,
    last_assistant: lastAssistantIndex,
    ...(cursor.lastRequestTokens !== undefined
      ? { last_request_tokens: cursor.lastRequestTokens }
      : {}),
    rewound_seen: cursor.rewoundSeen,
    messages: cursor.messages,
    // seq 记录与消息**逐位对齐**（`extendProjection` 维护等长不变量）；只存数字，
    // 不动消息形状 —— 快照的体积增量与消息条数同阶，换掉重启后的一次整份读。
    message_seqs: cursor.messageSeqs.map((seq) => (typeof seq === 'number' ? seq : null)),
    tool_starts: [...cursor.toolStarts.entries()],
  };
  try {
    return JSON.stringify(snapshot);
  } catch {
    // 消息里有环 / 非 JSON 值（正常路径不可能）：当作「不值得存」。
    return undefined;
  }
}

/** 把一份已校验的快照还原成游标（原文口径：`applyClearedReplacements: false`）。 */
export function cursorFromProjectionSnapshot(snapshot: ProjectionCacheSnapshot): ProjectionCursor {
  const cursor = createProjectionCursor({ applyClearedReplacements: false });
  for (const message of snapshot.messages) cursor.messages.push(message);
  // seq 记录：与消息等长（缺失 / 长度不符 ⇒ 全部 `undefined`，让压缩索引如实记
  // `unmapped_messages`，而不是猜一个号；错位的区间比缺 seq 糟得多）。
  const storedSeqs = snapshot.message_seqs;
  const sameLength = Array.isArray(storedSeqs) && storedSeqs.length === snapshot.messages.length;
  for (let index = 0; index < snapshot.messages.length; index += 1) {
    const seq = sameLength ? storedSeqs[index] : null;
    cursor.messageSeqs.push(typeof seq === 'number' && seq > 0 ? seq : undefined);
  }
  cursor.seq = snapshot.seq;
  cursor.count = snapshot.count;
  if (snapshot.last_request_tokens !== undefined) {
    cursor.lastRequestTokens = snapshot.last_request_tokens;
  }
  cursor.rewoundSeen = snapshot.rewound_seen;
  for (const [id, value] of snapshot.tool_starts) cursor.toolStarts.set(id, value);
  const index = snapshot.last_assistant;
  cursor.lastAssistant =
    index >= 0 && index < cursor.messages.length ? cursor.messages[index] : undefined;
  return cursor;
}
