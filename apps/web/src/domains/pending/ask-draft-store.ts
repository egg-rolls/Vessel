/**
 * ask 草稿的容器：内存 store + sessionStorage 镜像（切页 / 刷新 / 重连都不丢）。
 *
 * 为什么是 sessionStorage（不是 localStorage、也不是只靠内存）：
 * - 内存 store 能扛「切页」（组件卸载重挂），但刷新 / 重连后页面脚本从头跑一遍，
 *   纯内存必丢 —— 用户实测丢的就是这一层；
 * - 不写 localStorage：草稿里有**人正在打的字**（可能是私事、可能是路径、可能就是
 *   一句还没想好的话），永久层 + 跨标签页 + 跨设备共享是多余的暴露面。sessionStorage
 *   只在当前标签页的这次浏览器会话里有效，关掉标签页即清；刷新读回正好是我们要的那点
 *   （与 composerDraftStore 同一取舍，见它的头注释）。
 * - 隐私模式 / 被策略禁用：读 window.sessionStorage 属性本身可能抛错，全程 try/catch，
 *   失败静默降级成纯内存（等价于改动之前的行为，绝不因此让卡片打不开）。
 *
 * 落盘节流：写动作后 debounce 300ms；pagehide / beforeunload / 页面转后台时同步 flush。
 * 勾选与打字都是高频事件，每按键写一次 storage 既没必要也会拖慢输入。
 *
 * 清理（三条口径的形状由 ask-drafts.ts 定，这里只负责执行）：
 * - 本端提交成功后调用方 dropRequests；
 * - 请求从 pending 集合消失时 useAskDraftPrune 按差集删；
 * - 落盘载荷有上限与保质期（见 ask-drafts.ts 的常量）。
 *
 * 不存敏感内容的额外保证：槽里只有「选项文本 + 自定义答复 + 纳入勾选」，没有 token、
 * 没有 header、没有整条请求 —— 即使这份副本被落盘，能泄露的也只有人自己刚打的那句话
 * （这正是用户要求「刷新也不该丢」的那部分内容）。
 */
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { browserSessionStorage } from '../chat/session-selection';
import {
  askDraftKey,
  type AskDrafts,
  type AskDraftValue,
  ASK_DRAFT_STORAGE_VERSION,
  askDraftsPrunable,
  collectAskSlots,
  dropAskDrafts,
  EMPTY_ASK_DRAFTS,
  parseAskDraftKey,
  parseAskDrafts,
  type PersistedAskDrafts,
  setAskDraft,
  vanishedAskRequests,
} from './ask-drafts';

/** 落盘键：一个键装所有槽（形状见 ask-drafts.ts 的 PersistedAskDrafts）。 */
const STORAGE_KEY = 'vessel.askDraft.v1';
/** 写动作后的落盘去抖。 */
const PERSIST_DEBOUNCE_MS = 300;

/** 键 → 最后写入时间（ms）；只用于落盘排序 / 淘汰 / 保质期，不进 React state。 */
const savedAt: Record<string, number> = {};

const timers: { persist?: number } = {};
let hydrated = false;

/** 立即落盘（卸载 / 转后台 / debounce 到点）。只同步写一小段 JSON，不做重活。 */
function flushPersist(): void {
  if (timers.persist !== undefined && typeof window !== 'undefined') {
    window.clearTimeout(timers.persist);
    timers.persist = undefined;
  }
  const storage = browserSessionStorage();
  if (storage === null) return;
  const now = Date.now();
  const slots = collectAskSlots(useAskDraftStore.getState().drafts, savedAt, now);
  try {
    if (slots.length === 0) {
      storage.removeItem(STORAGE_KEY);
      return;
    }
    const payload: PersistedAskDrafts = { v: ASK_DRAFT_STORAGE_VERSION, slots };
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 配额满 / 隐私模式：静默降级为纯内存，当前页面里草稿照常可用。
  }
}

/** 写动作后节流落盘：勾选与打字都不该一按键一次 storage 写。 */
function schedulePersist(): void {
  if (typeof window === 'undefined') return;
  if (timers.persist !== undefined) window.clearTimeout(timers.persist);
  timers.persist = window.setTimeout(() => {
    timers.persist = undefined;
    flushPersist();
  }, PERSIST_DEBOUNCE_MS);
}

/** 页面转后台补一次 flush（移动端切走可能不触发 beforeunload）。 */
function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') flushPersist();
}

/**
 * 首次使用（读或写草稿）时 hydrate 一次。刻意**不在模块顶层**读 storage：
 * SSR 没有 window，导入期读会把整个模块带崩，也避免没人用草稿时白读一次。
 *
 * 这里会 setState，而读路径在组件 render 里调用 —— 安全的原因是不变量同 composer 的
 * 草稿 store：这是**首次**使用，此刻还没有任何订阅者（useSyncExternalStore 要到 commit
 * 才订阅）。不用 effect 兜的原因一样：那样首帧会先渲空卡片再补上，闪一下。
 */
function ensureHydrated(): void {
  if (hydrated) return;
  if (typeof window === 'undefined') return;
  hydrated = true;
  window.addEventListener('pagehide', flushPersist);
  window.addEventListener('beforeunload', flushPersist);
  document.addEventListener('visibilitychange', onVisibilityChange);
  const storage = browserSessionStorage();
  if (storage === null) return;
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  const restored = parseAskDrafts(raw, Date.now());
  if (restored === undefined) return;
  const keys = Object.keys(restored);
  if (keys.length === 0) return;
  for (const key of keys) {
    savedAt[key] = Date.now();
  }
  // 合并（而不是覆盖）：万一首次使用前已经有内存草稿，别把它抹掉。
  useAskDraftStore.setState((state) => ({ drafts: { ...restored, ...state.drafts } }));
}

interface AskDraftStoreState {
  drafts: AskDrafts;
  /** 写一题草稿；updater 与 React setState 同形，便于组件内直接改写。 */
  setDraft: (
    requestId: string,
    index: number,
    updater: (draft: AskDraftValue) => AskDraftValue,
  ) => void;
  /** 删掉若干条请求的全部草稿（提交成功 / 请求消失）。 */
  dropRequests: (requestIds: Iterable<string>) => void;
}

export const useAskDraftStore = create<AskDraftStoreState>()((set, get) => ({
  drafts: EMPTY_ASK_DRAFTS,

  setDraft: (requestId, index, updater) => {
    ensureHydrated();
    const key = askDraftKey(requestId, index);
    const current = get().drafts[key];
    const base: AskDraftValue = current ?? { selected: [], custom: '', include: false };
    const next = updater(base);
    if (
      current !== undefined &&
      next.selected === current.selected &&
      next.custom === current.custom &&
      next.include === current.include
    ) {
      return;
    }
    const drafts = setAskDraft(get().drafts, key, next);
    if (drafts === get().drafts) return;
    set({ drafts });
    if (drafts[key] === undefined) delete savedAt[key];
    else savedAt[key] = Date.now();
    schedulePersist();
  },

  dropRequests: (requestIds) => {
    ensureHydrated();
    const ids = [...requestIds];
    if (ids.length === 0) return;
    const drafts = dropAskDrafts(get().drafts, ids);
    if (drafts === get().drafts) return;
    set({ drafts });
    const gone = new Set(ids);
    for (const key of Object.keys(savedAt)) {
      const parsed = parseAskDraftKey(key);
      if (parsed !== undefined && gone.has(parsed.requestId)) delete savedAt[key];
    }
    schedulePersist();
  },
}));

/** 整个草稿表（组件一次订阅，逐题按键只重渲这一处；条目很少，成本可忽略）。 */
export function useAskDrafts(): AskDrafts {
  ensureHydrated();
  return useAskDraftStore((state) => state.drafts);
}

/** 写草稿的动作（引用稳定，不进依赖数组抖动）。 */
export function useSetAskDraft(): AskDraftStoreState['setDraft'] {
  ensureHydrated();
  return useAskDraftStore((state) => state.setDraft);
}

/** 删草稿的动作（提交成功后清这一批）。 */
export function useDropAskDrafts(): AskDraftStoreState['dropRequests'] {
  ensureHydrated();
  return useAskDraftStore((state) => state.dropRequests);
}

/**
 * 「请求消失 ⇒ 草稿一起走」的接线。
 *
 * 只在**本轮看到的 pending 集合里少了一个 id** 时删（差集），判据全在
 * `askDraftsPrunable`：首帧没有基线、断线 reset / 重连未 hydrate 造成的空集合都不算
 * 「请求消失」。`active` 由调用方给（连接是否正常），假的基线不推进。
 *
 * 调用方传「当前仍在 pending 的 requestId 全集」。
 */
export function useAskDraftPrune(liveRequestIds: readonly string[], active = true): void {
  const dropRequests = useDropAskDrafts();
  const previous = useRef<readonly string[] | null>(null);
  // 依赖用拼接后的字符串：调用方每次渲染都会新建数组，按引用比较会天天跑 effect。
  const liveKey = liveRequestIds.join(' ');
  // biome-ignore lint/correctness/useExhaustiveDependencies: 按 liveKey 判定「集合变了」，liveRequestIds 由 liveKey 唯一决定
  useEffect(() => {
    if (!active) return;
    const prev = previous.current;
    if (prev === null) {
      // 首帧只记基线；空集合不算基线（`askDraftsPrunable` 的第二条护栏）。
      if (liveRequestIds.length > 0) previous.current = liveRequestIds;
      return;
    }
    if (!askDraftsPrunable(prev, liveRequestIds)) return;
    previous.current = liveRequestIds;
    const vanished = vanishedAskRequests(prev, liveRequestIds);
    if (vanished.length > 0) dropRequests(vanished);
  }, [liveKey, active, dropRequests]);
}
