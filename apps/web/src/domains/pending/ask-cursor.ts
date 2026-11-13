/**
 * ask 卡片的**浏览位**（「上次停在第几题」）的形状与解析规则 —— 纯函数，零 import。
 *
 * 为什么需要它：草稿（`ask-drafts.ts`）早就能跨刷新保住「你打的字」，但 Composer 的
 * 逐题卡是**一次只渲染一题**（`questionIndex` 是本地 state），刷新后永远回到第 1 题 ——
 * 用户打了一半的第 3 题还在存储里，人却站在第 1 题前面。这是纯 UX 缺口。
 *
 * 记**题号**（`q1` / 题自带的 id），不记下标：题序属于服务端，题号才是身份；
 * 题号在题目列表里找不到时回落到「第 1 题」，绝不因为一条陈旧记录把人钉在错的位置。
 *
 * 与草稿同样的隐私取舍：只记「停在哪一题」，不含任何答案文本、不含 header。
 */
import { isRecord } from './ask-drafts';

export const ASK_CURSOR_STORAGE_VERSION = 1;
/** 同时保留多少条浏览位（一屏最多几十条 ask，超出按最旧淘汰）。 */
export const MAX_ASK_CURSORS = 200;
/** 浏览位的保质期：一周。陈旧的「上次停在第 3 题」既不准确也没有价值。 */
export const ASK_CURSOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface AskCursorEntry {
  /** 题号（`q1` 或题目自带 id），不是下标。 */
  questionId: string;
  /** 写入时间，用于保质期与淘汰。 */
  savedAt: number;
}

/** requestId → 浏览位。 */
export type AskCursors = Readonly<Record<string, AskCursorEntry>>;

export const EMPTY_ASK_CURSORS: AskCursors = Object.freeze({});

/** 取某条请求的浏览位题号；没有就 undefined（调用方回落到第 1 题）。 */
export function askCursorOf(cursors: AskCursors, requestId: string): string | undefined {
  const entry = cursors[requestId];
  return entry === undefined ? undefined : entry.questionId;
}

/** 记一次浏览位（返回新对象；超出上限时淘汰最旧的一条）。 */
export function rememberAskCursor(
  cursors: AskCursors,
  requestId: string,
  questionId: string,
  now: number,
): AskCursors {
  if (requestId === '' || questionId === '') return cursors;
  const next: Record<string, AskCursorEntry> = {
    ...cursors,
    [requestId]: { questionId, savedAt: now },
  };
  const ids = Object.keys(next);
  if (ids.length <= MAX_ASK_CURSORS) return next;
  const oldest = ids.reduce((left, right) =>
    (next[left]?.savedAt ?? 0) <= (next[right]?.savedAt ?? 0) ? left : right,
  );
  delete next[oldest];
  return next;
}

/** 丢掉指定请求的浏览位（提交成功 / 请求消失）。 */
export function dropAskCursors(cursors: AskCursors, requestIds: Iterable<string>): AskCursors {
  let changed = false;
  const next: Record<string, AskCursorEntry> = { ...cursors };
  for (const requestId of requestIds) {
    if (requestId in next) {
      delete next[requestId];
      changed = true;
    }
  }
  return changed ? next : cursors;
}

/** 只保留仍在 pending 里、且没过保质期的浏览位。 */
export function pruneAskCursors(
  cursors: AskCursors,
  liveRequestIds: Iterable<string>,
  now: number,
): AskCursors {
  const live = new Set(liveRequestIds);
  const next: Record<string, AskCursorEntry> = {};
  let changed = false;
  for (const [requestId, entry] of Object.entries(cursors)) {
    const fresh = now - entry.savedAt <= ASK_CURSOR_MAX_AGE_MS;
    if (live.has(requestId) && fresh) next[requestId] = entry;
    else changed = true;
  }
  return changed ? next : cursors;
}

/**
 * 把「上次的题号」换算成这一屏的下标。
 *
 * 三条退路都必须在：题号没记过 / 题号已不在题目列表里（服务端换了题）/ 下标越界
 * ⇒ 一律回落到 `fallback`（默认第 1 题）。宁可少记一次，也不要把人钉在错的位置上。
 */
export function resolveAskCursorIndex(
  questionIds: readonly string[],
  cursorId: string | undefined,
  fallback = 0,
): number {
  const safeFallback =
    questionIds.length === 0 ? 0 : Math.min(Math.max(fallback, 0), questionIds.length - 1);
  if (cursorId === undefined || cursorId === '') return safeFallback;
  const found = questionIds.indexOf(cursorId);
  return found >= 0 ? found : safeFallback;
}

/** 落盘形状（与 `ask-drafts.ts` 的 `PersistedAskDrafts` 同一套路：版本 + 载荷 + 容忍脏数据）。 */
export interface PersistedAskCursors {
  version: number;
  cursors: Record<string, AskCursorEntry>;
}

export function serializeAskCursors(cursors: AskCursors): string {
  const payload: PersistedAskCursors = {
    version: ASK_CURSOR_STORAGE_VERSION,
    cursors: { ...cursors },
  };
  return JSON.stringify(payload);
}

/** 解析落盘载荷；版本不符 / 形状不合法 / 全过期 ⇒ undefined（调用方当作「没有浏览位」）。 */
export function parseAskCursors(raw: string | null, now: number): AskCursors | undefined {
  if (raw === null || raw === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.version !== ASK_CURSOR_STORAGE_VERSION) return undefined;
  const rawCursors = parsed.cursors;
  if (!isRecord(rawCursors)) return undefined;
  const next: Record<string, AskCursorEntry> = {};
  for (const [requestId, value] of Object.entries(rawCursors)) {
    if (requestId === '' || !isRecord(value)) continue;
    const questionId = value.questionId;
    const savedAt = value.savedAt;
    if (typeof questionId !== 'string' || questionId === '') continue;
    if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) continue;
    if (now - savedAt > ASK_CURSOR_MAX_AGE_MS) continue;
    next[requestId] = { questionId, savedAt };
  }
  const ids = Object.keys(next);
  if (ids.length === 0) return undefined;
  return next;
}
