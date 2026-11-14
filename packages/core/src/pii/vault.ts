/**
 * PII 内存句柄 broker（0.52）。
 *
 * 目标：用「内存句柄 + 边界替换 + 审批解锁」取代「临时文件存原文」。
 *
 * 硬约束（用户已拍，别再讨论）：
 * 1. **纯内存，不落盘真值**：真值只在 `byValue` / `byHandle` 里，进程退出即消失；
 *    审计只留 `{session, category, count, first_seen_at}`（+ reveal 的 approval id）。
 * 2. **作用域 = 单 session + TTL**（默认 10 分钟，滑动续期）：跨 session 不共享，
 *    进程重启即失效（重启后同一个值即使算出同一个 id 也解不开 —— 靠 TTL 记录与
 *    会话未初始化两种事实区分，见 `classifyFailure`）。
 * 3. **稳定性**：同一 session 内「同值 ⇒ 同占位符」，反之「一个占位符只对一个值」。
 *    id 由 `sha256(会话随机盐 + 类别 + 值)` 取前 5 字节编码成 8 位 base32 得到：
 *    - 决定性 ⇒ 同值同 id（模型不会看到同一个邮箱两种写法，前缀也因此稳定）；
 *    - 盐随机且只在内存 ⇒ 跨 session 不同、且不可离线反推（对比「直接哈希明文」）。
 * 4. **计数上限**：每 session 最多 `maxHandlesPerSession` 个句柄，超限**降级为直接掩码**
 *    （`«pii:mask:<category>»`）而不是无限增长，且**不抛错**。
 */

import { createHash, randomBytes } from 'node:crypto';

import {
  findHandles,
  mask as maskText,
  neutralize,
  PII_NEUTRALIZED,
  PiiHandleUnresolvedError,
  piiHandleOf,
} from './rules.js';
import {
  PII_HANDLE_ALPHABET,
  PII_HANDLE_ID_LENGTH,
  type PiiCategory,
  type PiiHandleFailureReason,
  type PiiHit,
  piiMaskOf,
} from './types.js';

/** 句柄 TTL：10 分钟（滑动，命中即续期）。run 结束 / 进程重启都会让它失效。 */
export const PII_HANDLE_TTL_MS = 10 * 60 * 1000;

/**
 * 每个 session 的句柄容量上限。
 *
 * 256 的依据：真实一次 run 里需要被引用的「真值」通常是个位数量级（几个 key、
 * 几个邮箱、一两条连接串）；256 给了两个数量级的余量，同时把「拿大量假 PII 灌爆
 * 内存」的攻击面钉死在 `256 × 会话数 × 真值长度`。超出即降级为直接掩码。
 */
export const PII_MAX_HANDLES_PER_SESSION = 256;

/** 同时保留的 session 数上限（TTL 清理之外的兜底）。 */
export const PII_MAX_SESSIONS = 512;

/** 已过期句柄的墓碑上限（只记 id + 类别，用于把「过期」和「未知」分开报错）。 */
export const PII_MAX_TOMBSTONES = 1024;

/** 已通知过的失效批次哈希上限（批哈希去重集合的容量）。 */
export const PII_MAX_NOTIFIED_BATCHES = 32;

/**
 * 「面上的卡」频率上限：同一 session 每 60 秒至多一张（失效卡与容量卡共用预算）。
 *
 * 逐条失效会连续触发，没有防抖就是「逐个失败逐个发卡」的风暴；
 * 60s 又足够短，不会让「又一批新 id 失效」被永久闸住（那是静默，比重复更糟）。
 */
export const PII_NOTICE_MIN_INTERVAL_MS = 60_000;

/**
 * 句柄解不开的三种原因（渲染成三档不同的下一步，见 `rules.ts` 的错误类与
 * `runtime/error-envelope.ts`）：
 *
 * - `unknown_handle`：本 session 认识句柄机制、但这个 id 不是它发出去的
 *   （伪造 / 跨 session 混用 / 拼错）⇒ 重试没用，换数据。
 * - `expired_handle`：这个 id 以前是有效的，TTL 到了或 run 结束了 ⇒ 重新取数据。
 * - `invalidated_handle`：**broker 重启**，本进程根本没给这个 session 发过句柄，
 *   整批失效（面）而不是个别句柄 ⇒ 需要一张系统级提示卡（每 session 至多一次）。
 */
export type { PiiHandleFailureReason } from './types.js';

/** 审计条目：**不含值**，只有 session / 类别 / 计数 / 首次出现时间。 */
export interface PiiAuditEntry {
  session: string;
  category: PiiCategory;
  count: number;
  first_seen_at: number;
}

/** `protect()` 的产出。 */
export interface PiiProtectResult {
  text: string;
  /** 本次用到（新建或复用）的占位符 */
  handles: string[];
  /** 因容量上限降级为直接掩码的命中数 */
  masked: number;
  /** 本次新增或变化的审计条目（不含值），供调用方发布审计事件 */
  audit: PiiAuditEntry[];
}

/** `protectAll()` 的产出（逐条脱敏，不拼接）。 */
export interface PiiProtectBatchResult {
  texts: string[];
  handles: string[];
  masked: number;
  audit: PiiAuditEntry[];
}

/** `resolve()` 的产出。 */
export type PiiResolveResult =
  | { ok: true; value: string; category: PiiCategory }
  | { ok: false; reason: PiiHandleFailureReason };

interface Entry {
  category: PiiCategory;
  value: string;
  handle: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

interface SessionState {
  salt: string;
  /** key = `${category}\u0000${value}`：同值同类别 ⇒ 同句柄 */
  byValue: Map<string, Entry>;
  /** key = 句柄 id：一个占位符只对一个值 */
  byHandle: Map<string, Entry>;
  /** 已通知过的失效批次哈希（同批不重发；新一批允许再发） */
  notifiedBatches: Set<string>;
  /** 最近一次发「面上的卡」的时间（失效卡与容量卡共用这个预算） */
  lastNoticeAt: number | undefined;
  /** 已过期句柄墓碑：id → 类别（无值） */
  expired: Map<string, PiiCategory>;
  audit: Map<PiiCategory, { count: number; first_seen_at: number }>;
  degraded: number;
  lastActivityAt: number;
}

/** 构造函数选项（探针用假时钟 / 小容量，生产用默认值）。 */
export interface PiiVaultOptions {
  ttlMs?: number;
  maxHandlesPerSession?: number;
  maxSessions?: number;
  /** 熵启发开关（默认关；见 `rules.ts`） */
  entropy?: boolean;
  /** 假时钟注入（探针 b：TTL 过期） */
  now?: () => number;
  /** 盐工厂注入（默认 16 字节随机） */
  saltFactory?: () => string;
}

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += PII_HANDLE_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) out += PII_HANDLE_ALPHABET[(value << (5 - bits)) & 31]!;
  return out;
}

/** `sha256(盐 + 类别 + 值)` 前 5 字节 ⇒ 8 位 base32（40 bit）。 */
function deriveHandleId(salt: string, category: PiiCategory, value: string, attempt = 0): string {
  const digest = createHash('sha256')
    .update(salt)
    .update('\u0000')
    .update(category)
    .update('\u0000')
    .update(value)
    .update(attempt === 0 ? '' : `\u0000${attempt}`)
    .digest();
  return encodeBase32(digest.subarray(0, 5)).slice(0, PII_HANDLE_ID_LENGTH);
}

function valueKey(category: PiiCategory, value: string): string {
  return `${category}\u0000${value}`;
}

/**
 * 进程内 PII 句柄 broker。
 *
 * 一个实例就够了（`getPiiVault()`），因为作用域是 session + TTL；
 * 探针与测试可以直接 `new PiiVault({now})` 拿一个独立实例。
 */
export class PiiVault {
  private readonly sessions = new Map<string, SessionState>();
  private readonly ttlMs: number;
  private readonly maxHandlesPerSession: number;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly saltFactory: () => string;
  private entropyEnabled: boolean;
  private enabled = true;

  constructor(options: PiiVaultOptions = {}) {
    this.ttlMs = options.ttlMs ?? PII_HANDLE_TTL_MS;
    this.maxHandlesPerSession = options.maxHandlesPerSession ?? PII_MAX_HANDLES_PER_SESSION;
    this.maxSessions = options.maxSessions ?? PII_MAX_SESSIONS;
    this.now = options.now ?? (() => Date.now());
    this.saltFactory = options.saltFactory ?? (() => randomBytes(16).toString('hex'));
    this.entropyEnabled = options.entropy ?? false;
  }

  /** 全局开关（插件配置可以关掉整层脱敏；关掉后所有方法退化为直通）。 */
  get isEnabled(): boolean {
    return this.enabled;
  }

  configure(patch: { enabled?: boolean; entropy?: boolean }): void {
    if (patch.enabled !== undefined) this.enabled = patch.enabled;
    if (patch.entropy !== undefined) this.entropyEnabled = patch.entropy;
  }

  /**
   * 把正文里的真值换成占位符（**入站与请求构造共用这一个入口**）。
   *
   * 步骤：
   * 1. 中和入站文本里**本 session 不认**的同形占位符（防伪造句柄）；
   * 2. 规则扫描（整串分类优先，熵启发默认关）；
   * 3. 每个命中：同值复用已有句柄 / 新建句柄 / 容量超限降级为直接掩码。
   */
  protect(text: string, sessionId: string): PiiProtectResult {
    if (!this.enabled || text.length === 0) {
      return { text, handles: [], masked: 0, audit: [] };
    }
    const state = this.ensureSession(sessionId);
    const now = this.now();
    const audit = new Map<PiiCategory, PiiAuditEntry>();

    // 1) 入站伪造句柄中和（认识的不动：那是模型把真句柄回显出来）
    const sanitized = neutralize(text, (id) => {
      const entry = state.byHandle.get(id);
      if (entry === undefined) return false;
      if (entry.expiresAt <= now) return false;
      return true;
    });

    // 2) 规则扫描
    const hits = maskText(sanitized, { entropy: this.entropyEnabled }).hits;
    if (hits.length === 0) return { text: sanitized, handles: [], masked: 0, audit: [] };

    // 3) 生成 / 复用句柄（从后往前替换，下标不漂移）
    const handles: string[] = [];
    let masked = 0;
    let out = sanitized;
    for (let i = hits.length - 1; i >= 0; i -= 1) {
      const hit = hits[i]!;
      const replacement = this.handleFor(state, sessionId, hit, now, audit);
      if (replacement.masked) masked += 1;
      else handles.unshift(replacement.text);
      out = out.slice(0, hit.start) + replacement.text + out.slice(hit.end);
    }

    return {
      text: out,
      handles: [...new Set(handles)],
      masked,
      audit: [...audit.values()],
    };
  }

  /** 批量 `protect`（请求构造层对 messages 逐条调用时用）。 */
  protectAll(texts: readonly string[], sessionId: string): PiiProtectBatchResult {
    const out: string[] = [];
    const handles = new Set<string>();
    const audit = new Map<PiiCategory, PiiAuditEntry>();
    let masked = 0;
    for (const text of texts) {
      const result = this.protect(text, sessionId);
      out.push(result.text);
      for (const handle of result.handles) handles.add(handle);
      for (const entry of result.audit) audit.set(entry.category, entry);
      masked += result.masked;
    }
    return { texts: out, handles: [...handles], masked, audit: [...audit.values()] };
  }

  /**
   * 解析一个句柄 id。
   *
   * 三种失败原因见 `PiiHandleFailureReason`。**不抛错**，让调用方决定怎么渲染。
   */
  resolve(sessionId: string, handleId: string): PiiResolveResult {
    const state = this.sessions.get(sessionId);
    const now = this.now();
    if (state !== undefined) {
      const entry = state.byHandle.get(handleId);
      if (entry !== undefined && entry.expiresAt > now) {
        entry.lastSeenAt = now;
        entry.expiresAt = now + this.ttlMs;
        return { ok: true, value: entry.value, category: entry.category };
      }
      if (entry !== undefined) {
        this.retire(state, handleId, entry);
      }
    }
    return { ok: false, reason: this.classifyFailure(state, handleId) };
  }

  /**
   * 占位符替换：`«pii:…»` → 真值。
   *
   * 解不开就**抛错**（`unknown_handle` / `expired_handle` / `invalidated_handle` 三档）。
   * 工具参数边界必须用它：宁可整个调用失败，也不能把占位符原样发给外部系统。
   */
  substitute(text: string, sessionId: string): string {
    const occurrences = findHandles(text);
    if (occurrences.length === 0) return text;
    const resolved: Array<{ handle: string; start: number; end: number; value: string }> = [];
    const failures = new Map<
      PiiHandleFailureReason,
      Array<{ handle: string; category: PiiCategory | undefined }>
    >();
    for (const occurrence of occurrences) {
      const result = this.resolve(sessionId, occurrence.id);
      if (result.ok) {
        resolved.push({
          handle: occurrence.handle,
          start: occurrence.start,
          end: occurrence.end,
          value: result.value,
        });
      } else {
        const list = failures.get(result.reason) ?? [];
        // 错误白名单只允许「id + 类别 + 原因 + 下一步」：类别能从墓碑里拿到就给，
        // 拿不到（未知 / 整批失效）就不写 —— 绝不猜。
        list.push({
          handle: occurrence.handle,
          category: this.categoryOfDeadHandle(sessionId, occurrence.id),
        });
        failures.set(result.reason, list);
      }
    }
    if (failures.size > 0) {
      // 同一批里可能混着不同原因；按「最需要人介入」的顺序取第一个（整批失效 > 过期 > 未知）
      const order: PiiHandleFailureReason[] = [
        'invalidated_handle',
        'expired_handle',
        'unknown_handle',
      ];
      const reason = order.find((candidate) => failures.has(candidate))!;
      const all = [...failures.values()].flat();
      throw new PiiHandleUnresolvedError(
        all.map((entry) => entry.handle),
        reason,
        sessionId,
        all.map((entry) => entry.category),
      );
    }
    let out = '';
    let cursor = 0;
    for (const item of resolved) {
      out += text.slice(cursor, item.start) + item.value;
      cursor = item.end;
    }
    return out + text.slice(cursor);
  }

  /** 深替换：工具参数（任意 JSON 值）里的占位符 → 真值。解不开就抛错。 */
  substituteDeep<T>(value: T, sessionId: string): T {
    if (typeof value === 'string') return this.substitute(value, sessionId) as unknown as T;
    if (Array.isArray(value)) {
      return value.map((item) => this.substituteDeep(item, sessionId)) as unknown as T;
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = this.substituteDeep(item, sessionId);
      }
      return out as unknown as T;
    }
    return value;
  }

  /**
   * 一次性解锁（**必须**先经过人工审批，见 `reveal.ts`）。
   *
   * 与 `resolve` 的区别只在语义：调用方负责确认审批发生过，并落审批审计。
   * 这里不销毁句柄 —— 销毁会让同一次 run 里后续的正常引用全炸；「一次性」约束
   * 落在「一次审批 = 一次解锁」上。
   */
  reveal(sessionId: string, handleId: string): PiiResolveResult {
    return this.resolve(sessionId, handleId);
  }

  /**
   * 领取「整批失效（broker 重启）」系统提示卡的发放权。
   *
   * 与容量卡共用同一个「每 60 秒一张」的预算（见 `claimNoticeBudget`）。
   * 调用方顺序：先 `claimNoticeBudget`，发卡时再 `deadBatchNotified` / `markDeadBatchNotified`
   * 做「同一批不重发」的判定。
   */
  claimInvalidationNotice(sessionId: string): boolean {
    return this.claimNoticeBudget(sessionId);
  }

  /**
   * 领取「面上的卡」的预算：**同一 session 每 60 秒至多一张**（失效卡与容量卡共用）。
   *
   * 为什么要频率上限：逐条失效会连续触发，没有防抖就会变成「逐个失败逐个发卡」的风暴。
   * 返回 true = 这次由你发卡；false = 还在冷却窗口里，这次不发（下次请求再试）。
   */
  claimNoticeBudget(sessionId: string): boolean {
    const state = this.ensureSession(sessionId);
    const now = this.now();
    if (state.lastNoticeAt !== undefined && now - state.lastNoticeAt < PII_NOTICE_MIN_INTERVAL_MS) {
      return false;
    }
    state.lastNoticeAt = now;
    return true;
  }

  /**
   * 这一批失效引用**是否已经通知过**。
   *
   * 去重键 = 本批失效 id 的**有序集合哈希**（不是「session 级布尔」）：同批重复 ⇒ 不重发；
   * 新一批（不同 id 集合）⇒ 允许再发一张。用 session 级布尔会**漏报**：第一批发过之后
   * 又来一批新的，模型会以为所有引用都还能用 —— 静默比重发更糟。
   */
  deadBatchNotified(sessionId: string, batchHash: string): boolean {
    return this.sessions.get(sessionId)?.notifiedBatches.has(batchHash) ?? false;
  }

  /** 记下「这一批已经通知过」（只在真的追加了卡之后调用）。 */
  markDeadBatchNotified(sessionId: string, batchHash: string): void {
    const state = this.ensureSession(sessionId);
    state.notifiedBatches.add(batchHash);
    // 批次哈希集合也要有上限：否则一个长会话能把它撑大
    while (state.notifiedBatches.size > PII_MAX_NOTIFIED_BATCHES) {
      const oldest = state.notifiedBatches.values().next();
      if (oldest.done === true) break;
      state.notifiedBatches.delete(oldest.value);
    }
  }

  /**
   * 「这一批失效引用现在该不该发卡」——把两个闸门按生产顺序合成一次判定：
   *
   * 1. 同批（按 `piiDeadBatchHash`）已经通知过 ⇒ 不发（同批重复触发被吃掉）；
   * 2. 距上次发卡不足 `PII_NOTICE_MIN_INTERVAL_MS`（60s）⇒ 不发（防抖，避免风暴）；
   * 3. 其余 ⇒ 发，并立即记账（避免同一批被并发/连续触发两次）。
   *
   * 换一批新 id 且已过冷却窗口 ⇒ 允许再发一张：**静默比重发更糟**。
   */
  shouldAnnounceDeadBatch(sessionId: string, handleIds: readonly string[], tag = 'dead'): boolean {
    const key = `${tag}:${piiDeadBatchHash(handleIds)}`;
    if (this.deadBatchNotified(sessionId, key)) return false;
    if (!this.claimNoticeBudget(sessionId)) return false;
    this.markDeadBatchNotified(sessionId, key);
    return true;
  }

  /** 审计快照（不含值）。传 sessionId 只取该 session。 */
  audit(sessionId?: string): PiiAuditEntry[] {
    const sessions = sessionId === undefined ? [...this.sessions.keys()] : [sessionId];
    const out: PiiAuditEntry[] = [];
    for (const key of sessions) {
      const state = this.sessions.get(key);
      if (state === undefined) continue;
      for (const [category, entry] of state.audit) {
        out.push({
          session: key,
          category,
          count: entry.count,
          first_seen_at: entry.first_seen_at,
        });
      }
    }
    return out;
  }

  /** 某 session 当前发出的句柄 id（**不含值**；探针与调试用）。 */
  handleIds(sessionId: string): string[] {
    const state = this.sessions.get(sessionId);
    return state === undefined ? [] : [...state.byHandle.keys()];
  }

  /** 降级为直接掩码的次数（探针 f）。 */
  degradedCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.degraded ?? 0;
  }

  /** 取走「降级次数」信号（读后清零；上层据此决定要不要发容量卡）。 */
  takeDegradedCount(sessionId: string): number {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return 0;
    const value = state.degraded;
    state.degraded = 0;
    return value;
  }

  /** 死句柄的类别（墓碑里还留着；判不出来就返回 undefined，绝不猜）。 */
  categoryOfDeadHandle(sessionId: string, handleId: string): PiiCategory | undefined {
    return this.sessions.get(sessionId)?.expired.get(handleId);
  }

  /** 结束 session：清空真值与句柄（run 结束 / 会话关闭时调）。 */
  endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** 清空全部（测试 / 关停用）。 */
  reset(): void {
    this.sessions.clear();
  }

  /** 惰性清理过期 entry / 过期 tombstone / 空闲 session。 */
  sweep(): void {
    const now = this.now();
    for (const [sessionId, state] of this.sessions) {
      for (const [handleId, entry] of [...state.byHandle]) {
        if (entry.expiresAt <= now) this.retire(state, handleId, entry);
      }
      if (state.byHandle.size === 0 && now - state.lastActivityAt > this.ttlMs) {
        this.sessions.delete(sessionId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private ensureSession(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      if (this.sessions.size >= this.maxSessions) this.evictOldestSession();
      state = {
        salt: this.saltFactory(),
        byValue: new Map(),
        byHandle: new Map(),
        expired: new Map(),
        notifiedBatches: new Set(),
        lastNoticeAt: undefined,
        audit: new Map(),
        degraded: 0,
        lastActivityAt: this.now(),
      };
      this.sessions.set(sessionId, state);
    }
    state.lastActivityAt = this.now();
    this.sweep();
    return state;
  }

  private evictOldestSession(): void {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, state] of this.sessions) {
      if (state.lastActivityAt < oldestAt) {
        oldestAt = state.lastActivityAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.sessions.delete(oldestKey);
  }

  private handleFor(
    state: SessionState,
    sessionId: string,
    hit: PiiHit,
    now: number,
    audit: Map<PiiCategory, PiiAuditEntry>,
  ): { text: string; masked: boolean } {
    const key = valueKey(hit.category, hit.text);
    const existing = state.byValue.get(key);
    if (existing !== undefined && existing.expiresAt > now) {
      existing.lastSeenAt = now;
      existing.expiresAt = now + this.ttlMs;
      return { text: existing.handle, masked: false };
    }

    // 容量上限：降级为直接掩码，**不抛错**（否则一条脏数据就能把 run 打死）
    if (state.byValue.size >= this.maxHandlesPerSession) {
      state.degraded += 1;
      return { text: piiMaskOf(hit.category), masked: true };
    }

    const handleId = this.allocateHandleId(state, hit.category, hit.text);
    if (handleId === undefined) {
      state.degraded += 1;
      return { text: piiMaskOf(hit.category), masked: true };
    }
    const handle = piiHandleOf(handleId);
    const entry: Entry = {
      category: hit.category,
      value: hit.text,
      handle,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.ttlMs,
    };
    state.byValue.set(key, entry);
    state.byHandle.set(handleId, entry);
    state.expired.delete(handleId);

    const current = state.audit.get(hit.category);
    if (current === undefined) {
      state.audit.set(hit.category, { count: 1, first_seen_at: now });
    } else {
      current.count += 1;
    }
    const auditEntry = state.audit.get(hit.category)!;
    audit.set(hit.category, {
      session: sessionId,
      category: hit.category,
      count: auditEntry.count,
      first_seen_at: auditEntry.first_seen_at,
    });
    return { text: handle, masked: false };
  }

  /** 分配 id；碰撞（不同值算出同一 id）时换 attempt 重算，仍撞则放弃 ⇒ 调用方降级掩码。 */
  private allocateHandleId(
    state: SessionState,
    category: PiiCategory,
    value: string,
  ): string | undefined {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = deriveHandleId(state.salt, category, value, attempt);
      const holder = state.byHandle.get(id);
      if (holder === undefined) return id;
      if (holder.category === category && holder.value === value) return id;
    }
    return undefined;
  }

  /** 把 entry 从两个索引里摘掉，留一个无值的墓碑（区分「过期」与「未知」）。 */
  private retire(state: SessionState, handleId: string, entry: Entry): void {
    state.byHandle.delete(handleId);
    state.byValue.delete(valueKey(entry.category, entry.value));
    state.expired.set(handleId, entry.category);
    while (state.expired.size > PII_MAX_TOMBSTONES) {
      const oldest = state.expired.keys().next();
      if (oldest.done === true) break;
      state.expired.delete(oldest.value);
    }
  }

  private classifyFailure(
    state: SessionState | undefined,
    handleId: string,
  ): PiiHandleFailureReason {
    if (state === undefined) {
      // 本进程从没给这个 session 发过任何句柄 ⇒ 大概率是 broker 重启（持久化上下文里
      // 的旧占位符）。与「伪造的句柄」区分开：这一档要发系统级提示卡。
      return 'invalidated_handle';
    }
    if (state.expired.has(handleId)) return 'expired_handle';
    if (state.byHandle.size === 0 && state.expired.size === 0) {
      // session 存在但一条都没发过（例如只有入站扫描、全被降级掩码）⇒ 同样是整批失效
      return 'invalidated_handle';
    }
    return 'unknown_handle';
  }
}

let singleton: PiiVault | undefined;

/**
 * 失效「批次」的稳定哈希：把本批 id 排序后 sha1，取前 12 个 hex。
 *
 * 去重键必须是**这一批 id 的集合**（而不是 session 级布尔）：同一批重复触发 ⇒ 不重发，
 * 但换了一批新 id ⇒ 必须再发一张，否则后来失效的引用会被静默。
 */
export function piiDeadBatchHash(handleIds: readonly string[]): string {
  const sorted = [...handleIds].sort();
  return createHash('sha1').update(sorted.join(',')).digest('hex').slice(0, 12);
}

/** 进程级单例（三处边界共用，保证「模型只看到一种形态」）。 */
export function getPiiVault(): PiiVault {
  if (singleton === undefined) singleton = new PiiVault();
  return singleton;
}

/** 探针 / 测试用：替换单例（传 `undefined` 复位）。 */
export function setPiiVault(vault: PiiVault | undefined): void {
  singleton = vault;
}

export { PII_NEUTRALIZED };
