/**
 * ask 草稿：人正在勾选 / 正在输入、但**还没提交**的那部分状态（纯逻辑）。
 *
 * 为什么要单独一层：草稿以前只活在组件的 useState 里（PromptSlots / AskCard /
 * PendingClusterCard），切页 / 刷新 / 重连就是组件卸载，勾好的选项与打了一半的自定义
 * 答复全部蒸发 —— 用户实测「切页 / 刷新后，正在勾选但还没提交的选项没了」，成因全在
 * 这一层。所以草稿必须离开组件，落进一个按请求寻址、能持久化的容器
 * （内存 + sessionStorage 实现在 ask-draft-store.ts；本文件只做纯函数，供门禁探针直测）。
 *
 * 匹配键：requestId + 题号（见 ASK_DRAFT_KEY_SEPARATOR）。
 * - 必须带 requestId：同时可能压着多条 ask（待批页一簇里就有多条），只按题号或按
 *   题目正文匹配一定会串台；
 * - 题号是唯一稳定的「每题 id」：协议里的 AskUserQuestion 没有 id，header 被截到
 *   12 字且可重复、正文可能很长，只有**同一请求内的下标**稳定
 *   （见 docs/dev/reports/0.51/ask-interaction-design.md 2.1）。一条请求的问题数组
 *   在落定前不会变，所以下标就是题的身份。
 *
 * 清理口径（三条，缺一条就会无界增长）：
 * 1. 本端提交成功：调用方显式 dropAskDrafts（那时请求通常也随即消失）；
 * 2. 请求从 pending 集合里消失（别处已答 / run 终态 / 服务端 not_found）：调用方把
 *    「上一轮见到的 pending id」与「这一轮」交给 vanishedAskRequests 算差集再删；
 *    刻意**不**用「不在 pending 里就删」—— 刷新后 pending 集合在 hydration 完成前是空的，
 *    那会把刚恢复的草稿当成孤儿剃掉；
 * 3. 落盘载荷封顶：超过 MAX_ASK_DRAFT_SLOTS 按最后写入时间淘汰最旧，超过
 *    ASK_DRAFT_MAX_AGE_MS 的槽直接丢弃（浏览器会话恢复会带回上个会话的记录）。
 *
 * 空草稿既不留在内存也不落盘（setAskDraft 直接删键），所以「勾上又取消」不留垃圾。
 */

/** 草稿键的分隔符；requestId 是 UUID，不含它。 */
export const ASK_DRAFT_KEY_SEPARATOR = '#';

/** 落盘载荷版本：形状变了就抬版本，旧载荷整份丢弃（宁可从空开始，也不要解析出半份）。 */
export const ASK_DRAFT_STORAGE_VERSION = 1;

/** 最多保留的槽数（一题一个槽）；超出按最后写入时间淘汰最旧。 */
export const MAX_ASK_DRAFT_SLOTS = 200;

/** 单题已选选项条数上限（选项是模型给的，理论上可以很长；落盘副本没有理由跟着涨）。 */
export const MAX_ASK_DRAFT_SELECTED = 32;

/** 自定义答复的字符上限；超出截断保前缀（恢复后至少能看到自己写的开头）。 */
export const MAX_ASK_DRAFT_CUSTOM_CHARS = 2048;

/** 槽的保质期：超过这个时间的草稿不再恢复（prompt 不会等这么久，sessionStorage 也可能跨会话存活）。 */
export const ASK_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const EMPTY_SELECTED: readonly string[] = Object.freeze([]);

/** 单题草稿：已选选项 + 自定义答复 + 待批页「本次回复带上这题」的勾选。 */
export interface AskDraftValue {
  readonly selected: readonly string[];
  readonly custom: string;
  /** 待批页的纳入勾选；Composer 槽位的单题卡不用这个字段（恒为 false）。 */
  readonly include: boolean;
}

/** 未命中时的稳定空草稿（组件按引用比较快照，不能每次渲染新建）。 */
export const EMPTY_ASK_DRAFT: AskDraftValue = Object.freeze({
  selected: EMPTY_SELECTED,
  custom: '',
  include: false,
});

/** 键 → 单题草稿。 */
export type AskDrafts = Readonly<Record<string, AskDraftValue>>;

export const EMPTY_ASK_DRAFTS: AskDrafts = Object.freeze({});

/** 草稿键：同一请求内题号稳定，跨请求靠 requestId 隔开。 */
export function askDraftKey(requestId: string, index: number): string {
  return `${requestId}${ASK_DRAFT_KEY_SEPARATOR}${index}`;
}

/** 反解草稿键；形状不对返回 undefined（落盘载荷可能被手改 / 跨版本残留）。 */
export function parseAskDraftKey(key: string): { requestId: string; index: number } | undefined {
  const at = key.lastIndexOf(ASK_DRAFT_KEY_SEPARATOR);
  if (at <= 0 || at === key.length - 1) return undefined;
  const rawIndex = key.slice(at + 1);
  if (!/^[0-9]+$/.test(rawIndex)) return undefined;
  const index = Number(rawIndex);
  if (!Number.isSafeInteger(index)) return undefined;
  return { requestId: key.slice(0, at), index };
}

/** 单题是否已作答（勾了选项或写了非空自定义答复）。 */
export function isAskDraftAnswered(draft: {
  selected: readonly string[];
  custom: string;
}): boolean {
  return draft.selected.length > 0 || draft.custom.trim().length > 0;
}

/** 空草稿 = 什么都不该留：不占内存槽、不落盘。 */
export function isAskDraftEmpty(draft: AskDraftValue): boolean {
  return draft.selected.length === 0 && draft.custom.length === 0 && !draft.include;
}

/** 读一题草稿；未命中回退冻结空值。 */
export function askDraftOf(drafts: AskDrafts, requestId: string, index: number): AskDraftValue {
  return drafts[askDraftKey(requestId, index)] ?? EMPTY_ASK_DRAFT;
}

/** 写一题草稿；空草稿删键（保持内存与落盘同一口径）。 */
export function setAskDraft(drafts: AskDrafts, key: string, value: AskDraftValue): AskDrafts {
  if (isAskDraftEmpty(value)) {
    if (drafts[key] === undefined) return drafts;
    const next = { ...drafts };
    delete next[key];
    return next;
  }
  return { ...drafts, [key]: value };
}

/** 删掉若干条请求的全部草稿（提交成功 / 请求消失）。 */
export function dropAskDrafts(drafts: AskDrafts, requestIds: Iterable<string>): AskDrafts {
  const drop = new Set(requestIds);
  if (drop.size === 0) return drafts;
  const next: Record<string, AskDraftValue> = {};
  let removed = false;
  for (const [key, value] of Object.entries(drafts)) {
    const parsed = parseAskDraftKey(key);
    if (parsed !== undefined && drop.has(parsed.requestId)) {
      removed = true;
      continue;
    }
    next[key] = value;
  }
  return removed ? next : drafts;
}

/** 草稿里出现过的请求 id（去重；用于自省与探针）。 */
export function askDraftRequestIds(drafts: AskDrafts): string[] {
  const ids = new Set<string>();
  for (const key of Object.keys(drafts)) {
    const parsed = parseAskDraftKey(key);
    if (parsed !== undefined) ids.add(parsed.requestId);
  }
  return [...ids];
}

/**
 * 上一轮见过、这一轮不在的请求 id（= 刚刚落定 / 失效的那些）。
 *
 * 刻意只认「之前见过」：组件刚挂载时 previous 为空，此时什么都不算消失，
 * 刷新 / 重连后恢复的草稿不会被空集合误删。
 */
export function vanishedAskRequests(
  previous: readonly string[],
  next: readonly string[],
): string[] {
  const live = new Set(next);
  return [...new Set(previous)].filter((requestId) => !live.has(requestId));
}

/**
 * 这一轮该不该按差集删草稿（两条「集合不可信」的护栏）。
 *
 * - 没有基线（组件刚挂载）：不删 —— 刷新 / 切页回来时 pending 集合还没 hydrate，
 *   把恢复出来的草稿当孤儿剃掉正是要防的那个坑；
 * - 这一轮 pending 集合为空、上一轮非空：不删 —— 断线 / 换 token / 节点切换会把
 *   interactionStore 整个 reset（`ConnectionProvider` 的 `!canConnect` 分支），重连后
 *   hydration 还没回来时集合也是空的。这两种「空」都不是「请求都答完了」。
 *
 * 代价：请求真的全部答完时草稿会留到保质期 / 槽位淘汰（本端提交成功那条路径另有
 * 显式 dropAskDrafts，所以常见情形并不依赖这里）。宁可有界地留，也不要静默丢字。
 */
export function askDraftsPrunable(
  previous: readonly string[] | null,
  next: readonly string[],
): boolean {
  if (previous === null) return false;
  if (next.length === 0 && previous.length > 0) return false;
  return true;
}

/** 只留仍在 pending 集合里的请求草稿（live 必须是**已知可信**的 pending 全集）。 */
export function pruneAskDrafts(drafts: AskDrafts, liveRequestIds: Iterable<string>): AskDrafts {
  const live = new Set(liveRequestIds);
  const stale = new Set<string>();
  for (const requestId of askDraftRequestIds(drafts)) {
    if (!live.has(requestId)) stale.add(requestId);
  }
  return dropAskDrafts(drafts, stale);
}

/** 落盘的一条槽。 */
export interface PersistedAskSlot {
  key: string;
  selected: string[];
  custom: string;
  include: boolean;
  /** 最后写入时间（ms）：用于淘汰与保质期。 */
  savedAt: number;
}

/** 落盘载荷。 */
export interface PersistedAskDrafts {
  v: number;
  slots: PersistedAskSlot[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 选项列表收口：只收非空字符串，按上限截断，去重（同一选项勾两次没有意义）。 */
function clampSelected(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const option of value) {
    if (selected.length >= MAX_ASK_DRAFT_SELECTED) break;
    if (typeof option !== 'string' || option.length === 0 || seen.has(option)) continue;
    seen.add(option);
    selected.push(option);
  }
  return selected;
}

/** 自定义答复收口：只留前 MAX_ASK_DRAFT_CUSTOM_CHARS 个字符。 */
function clampCustom(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.length > MAX_ASK_DRAFT_CUSTOM_CHARS
    ? value.slice(0, MAX_ASK_DRAFT_CUSTOM_CHARS)
    : value;
}

/**
 * 内存草稿 → 落盘载荷：空槽 / 过期槽不写，按最后写入时间保留最新的 MAX_ASK_DRAFT_SLOTS 个。
 *
 * savedAt 由 store 维护（纯内存），不在 AskDraftValue 里 —— 组件只关心「选了什么」，
 * 不该因为一次时间戳更新而重渲染。
 */
export function collectAskSlots(
  drafts: AskDrafts,
  savedAt: Readonly<Record<string, number>>,
  now: number,
): PersistedAskSlot[] {
  const slots: PersistedAskSlot[] = [];
  for (const [key, draft] of Object.entries(drafts)) {
    if (isAskDraftEmpty(draft)) continue;
    const at = savedAt[key] ?? now;
    if (!Number.isFinite(at) || now - at > ASK_DRAFT_MAX_AGE_MS) continue;
    slots.push({
      key,
      selected: clampSelected(draft.selected),
      custom: clampCustom(draft.custom),
      include: draft.include,
      savedAt: at,
    });
  }
  slots.sort((a, b) => a.savedAt - b.savedAt);
  return slots.slice(-MAX_ASK_DRAFT_SLOTS);
}

/**
 * 落盘载荷 → 内存草稿。形状不对 / 版本不符返回 undefined（调用方按「没有存过」处理），
 * 单条坏槽逐条丢弃，不让一条脏数据毁掉整份草稿。
 */
export function parseAskDrafts(raw: string | null, now: number): AskDrafts | undefined {
  if (raw === null || raw === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.v !== ASK_DRAFT_STORAGE_VERSION) return undefined;
  const slots = parsed.slots;
  if (!Array.isArray(slots)) return undefined;
  const drafts: Record<string, AskDraftValue> = {};
  for (const slot of slots) {
    if (!isRecord(slot)) continue;
    const { key, savedAt } = slot;
    if (typeof key !== 'string' || parseAskDraftKey(key) === undefined) continue;
    if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) continue;
    if (now - savedAt > ASK_DRAFT_MAX_AGE_MS) continue;
    const draft: AskDraftValue = {
      selected: clampSelected(slot.selected),
      custom: clampCustom(slot.custom),
      include: slot.include === true,
    };
    if (isAskDraftEmpty(draft)) continue;
    drafts[key] = draft;
  }
  return drafts;
}
