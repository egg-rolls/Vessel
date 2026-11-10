/**
 * Composer 草稿缓存（纯内存）：输入框正文 + mention chips 按 key 保存，切走再回来原样恢复。
 *
 * - 生命周期 = 页面内存活，不落 `localStorage`：草稿可能含敏感 prompt，也不需要跨刷新；
 * - key：会话 `chat:new` / `chat:<sessionId>`，团队 `team:<nodeKey>:<teamId>`；
 * - stores 在下层：chips 只用结构类型，不 import `domains/**` 的 `MentionChip`；
 * - 发送成功后由调用方 `clear(key)`；空草稿不留条目，选择器回退到冻结空值
 *   （`useStore` 按 `Object.is` 比较快照，回退引用必须稳定）。
 */
import { create } from 'zustand';

/** 结构上兼容 `domains/team/mention` 的 `MentionChip`（stores 不反向依赖 domains）。 */
export interface ComposerChip {
  readonly agentId: string;
  readonly label: string;
}

export interface ComposerDraft {
  readonly text: string;
  readonly chips: readonly ComposerChip[];
}

export const EMPTY_CHIPS: readonly ComposerChip[] = Object.freeze([]);

/** 未命中 key 时的稳定引用，不能每次渲染新建。 */
export const EMPTY_DRAFT: ComposerDraft = Object.freeze({ text: '', chips: EMPTY_CHIPS });

/** 草稿态（还没建 session）的槽位。 */
export const NEW_CHAT_DRAFT_KEY = 'chat:new';

/** 会话草稿 key；`null` / `undefined` / 路由占位 `new` 都落到草稿态槽。 */
export function chatDraftKey(sessionId: string | null | undefined): string {
  if (!sessionId || sessionId === 'new') return NEW_CHAT_DRAFT_KEY;
  return `chat:${sessionId}`;
}

/** 团队草稿 key：同一 `teamId` 在不同 node 上是不同团队，必须带 node。 */
export function teamDraftKey(nodeKey: string, teamId: string): string {
  return `team:${nodeKey}:${teamId}`;
}

interface ComposerDraftState {
  drafts: Record<string, ComposerDraft>;
  /** 写正文；支持函数式更新，与 React `useState` 的 setter 同形，便于直接顶替。 */
  setText: (key: string, value: string | ((prev: string) => string)) => void;
  setChips: (key: string, chips: readonly ComposerChip[]) => void;
  /** 发送成功后清空该 key（正文与 chips 一起）。 */
  clear: (key: string) => void;
}

function isEmpty(draft: ComposerDraft): boolean {
  return draft.text.length === 0 && draft.chips.length === 0;
}

/** 写入（或按需删除）一条草稿；空草稿删条目，避免长期挂着一堆空槽。 */
function withDraft(
  drafts: Record<string, ComposerDraft>,
  key: string,
  next: ComposerDraft,
): Record<string, ComposerDraft> {
  if (!isEmpty(next)) return { ...drafts, [key]: next };
  const pruned = { ...drafts };
  delete pruned[key];
  return pruned;
}

export const useComposerDraftStore = create<ComposerDraftState>()((set) => ({
  drafts: {},

  setText: (key, value) => {
    set((state) => {
      const current = state.drafts[key] ?? EMPTY_DRAFT;
      const text = typeof value === 'function' ? value(current.text) : value;
      // 同值写入直接返回原 state：`set` 用 `Object.is` 短路，不触发重渲染。
      if (text === current.text) return state;
      // 只换正文时保留 chips 引用，chips 订阅者不因敲字重渲染。
      return { drafts: withDraft(state.drafts, key, { text, chips: current.chips }) };
    });
  },

  setChips: (key, chips) => {
    set((state) => {
      const current = state.drafts[key] ?? EMPTY_DRAFT;
      return { drafts: withDraft(state.drafts, key, { text: current.text, chips }) };
    });
  },

  clear: (key) => {
    set((state) => {
      if (state.drafts[key] === undefined) return state;
      const drafts = { ...state.drafts };
      delete drafts[key];
      return { drafts };
    });
  },
}));

/** 读 key 的正文；未命中回退空串（原始值，引用天然稳定）。 */
export function useComposerDraftText(key: string): string {
  return useComposerDraftStore((state) => state.drafts[key]?.text ?? '');
}

/** 读 key 的 chips；未命中回退冻结空数组。 */
export function useComposerChips(key: string): readonly ComposerChip[] {
  return useComposerDraftStore((state) => state.drafts[key]?.chips ?? EMPTY_CHIPS);
}
