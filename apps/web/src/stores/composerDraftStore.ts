/**
 * Composer 草稿缓存：输入框正文 + mention chips + 待发送引用按 key 保存 ——
 * 切页面 / 切会话 / **刷新**都恢复。
 *
 * - 存储：`sessionStorage`（**不是** localStorage）。刷新同一标签页能恢复；关标签页即清，
 *   不跨标签、不跨设备、不跨重启。
 *   **隐私提醒**：草稿因此多了一份浏览器磁盘副本（会话恢复时 sessionStorage 可能被落盘），
 *   比纯内存多一处暴露面 —— 这是用户明确要求的取舍（「刷新也不该丢」）。
 *   0.52 起待发送的**引用路径**也在这份副本里（只有路径与种类，没有正文）。
 * - key（沿用既有语义）：会话 `chat:new` / `chat:<sessionId>`，团队 `team:<nodeKey>:<teamId>`；
 * - 有界：单条正文 ≤ 32 KiB（UTF-8，超出截断保前缀）、最多**落盘** 50 个槽（按最后写入时间
 *   淘汰最旧；当前页面内存里仍保留全部）、空草稿不落盘（内存里也仍是「空即删条目」）；
 *   引用单槽 ≤ 32 条（与 core `Message.refs` 同一上限）；
 * - 落盘节流：写动作后 debounce 300ms；`pagehide` / `beforeunload` / 页面转后台时同步 flush；
 * - SSR / 隐私模式：模块顶层不碰 storage，首次使用时懒 hydrate；读写全程 try/catch，
 *   失败静默降级成纯内存（等价于之前的行为）；
 * - stores 在下层：chips / refs 只用结构类型，不 import `domains/**`；
 * - 发送成功后由调用方 `clear(key)`；选择器未命中回退冻结空值
 *   （`useStore` 按 `Object.is` 比较快照，回退引用必须稳定）。
 */
import { create } from 'zustand';
import type { MessageRef } from '../gateway/types';

/** 结构上兼容 `domains/team/mention` 的 `MentionChip`（stores 不反向依赖 domains）。 */
export interface ComposerChip {
  readonly agentId: string;
  readonly label: string;
}

export interface ComposerDraft {
  readonly text: string;
  readonly chips: readonly ComposerChip[];
  /**
   * 待发送的附件引用（只传路径，0.52）。顺序即发送顺序，也是删除时的下标来源：
   * 同一路径可以出现两次（两个 chip、删一个只删对应下标）。
   */
  readonly refs: readonly MessageRef[];
}

export const EMPTY_CHIPS: readonly ComposerChip[] = Object.freeze([]);

/** 未命中 key 时的稳定引用，不能每次渲染新建。 */
export const EMPTY_DRAFT: ComposerDraft = Object.freeze({
  text: '',
  chips: EMPTY_CHIPS,
  refs: Object.freeze([]) as readonly MessageRef[],
});

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

/** 落盘键：一个键装所有槽（形状见 `PersistedPayload`），不按会话各用一个 storage key。 */
const STORAGE_KEY = 'vessel.composerDraft.v2';
/** v2（0.52）：槽里多了待发送引用（`refs`）。v1 的旧槽整份丢弃 —— 正文另有会话可查。 */
const STORAGE_VERSION = 2;
/** 单条正文的 UTF-8 字节上限；超出截断保前缀（恢复后用户能看到自己写的开头）。 */
const MAX_DRAFT_BYTES = 32 * 1024;
/** 单槽引用条数上限：与 core `Message.refs` 同一口径（32 条）。 */
const MAX_DRAFT_REFS = 32;
/** 最多保留的槽数；超出按最后写入时间淘汰最旧。 */
const MAX_SLOTS = 50;
const PERSIST_DEBOUNCE_MS = 300;

interface PersistedSlot {
  key: string;
  text: string;
  chips: ComposerChip[];
  /** 待发送引用（只有路径与种类）；没有引用时不写该键。 */
  refs?: MessageRef[];
}

/** 落盘形状：数组顺序 = 由旧到新（淘汰直接切头部）。 */
interface PersistedPayload {
  v: number;
  slots: PersistedSlot[];
}

/** key → 最近一次写入序号；只用于落盘排序与淘汰最旧，不进 storage。 */
const recency = new Map<string, number>();
let recencySeq = 0;

/** 隐私模式 / 被策略禁用时，读 `window.sessionStorage` 属性本身就会抛错。 */
function browserStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * 按 UTF-8 字节截断（宽字符按 2/3 字节估）；不劈开代理对，保证恢复出来的前缀是完整字符。
 * 只求上限，不追求编码器级精确 —— 差几十字节没有意义。
 */
function truncateDraftText(text: string): string {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (bytes > MAX_DRAFT_BYTES) {
      const cut = index > 0 && isHighSurrogate(text.charCodeAt(index - 1)) ? index - 1 : index;
      return text.slice(0, cut);
    }
  }
  return text;
}

function markTouched(key: string): void {
  recencySeq += 1;
  recency.set(key, recencySeq);
}

function forget(key: string): void {
  recency.delete(key);
}

/** 内存草稿 → 落盘载荷（空草稿不写；按最后写入时间保留最新的 `MAX_SLOTS` 个）。 */
function collectSlots(): PersistedSlot[] {
  const { drafts } = useComposerDraftStore.getState();
  const slots: PersistedSlot[] = [];
  for (const [key, draft] of Object.entries(drafts)) {
    if (isEmpty(draft)) continue;
    slots.push({
      key,
      text: truncateDraftText(draft.text),
      chips: draft.chips.map((chip) => ({ agentId: chip.agentId, label: chip.label })),
      ...(draft.refs.length > 0 ? { refs: draft.refs.map((ref) => ({ ...ref })) } : {}),
    });
  }
  slots.sort((a, b) => (recency.get(a.key) ?? 0) - (recency.get(b.key) ?? 0));
  return slots.slice(-MAX_SLOTS);
}

/**
 * 宽松解析引用：只认 `{kind, path}` 形状，逐条丢弃坏数据（与 core 投影同一口径）。
 *
 * 上限 `MAX_DRAFT_REFS`：条数是 token 税，落盘副本没有理由比服务端更宽。
 */
function parseRefs(value: unknown): MessageRef[] {
  if (!Array.isArray(value)) return [];
  const refs: MessageRef[] = [];
  for (const entry of value) {
    if (refs.length >= MAX_DRAFT_REFS) break;
    if (!isRecord(entry)) continue;
    const { kind, path } = entry;
    if (kind !== 'file' && kind !== 'image' && kind !== 'document') continue;
    if (typeof path !== 'string' || path.length === 0) continue;
    const ref: MessageRef = { kind, path };
    if (typeof entry.name === 'string') ref.name = entry.name;
    if (typeof entry.mime === 'string') ref.mime = entry.mime;
    if (typeof entry.bytes === 'number' && Number.isFinite(entry.bytes) && entry.bytes >= 0) {
      ref.bytes = Math.floor(entry.bytes);
    }
    refs.push(ref);
  }
  return refs;
}

function parseChips(value: unknown): ComposerChip[] {
  if (!Array.isArray(value)) return [];
  const chips: ComposerChip[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { agentId, label } = entry;
    if (typeof agentId !== 'string' || typeof label !== 'string') continue;
    chips.push({ agentId, label });
  }
  return chips;
}

/** 宽松解析：形状不对的槽逐条丢弃，不因为一条坏数据丢掉整份草稿。 */
function parseDrafts(raw: string | null): Record<string, ComposerDraft> | null {
  if (raw === null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== STORAGE_VERSION) return null;
  const slots = parsed.slots;
  if (!Array.isArray(slots)) return null;
  const drafts: Record<string, ComposerDraft> = {};
  for (const slot of slots) {
    if (!isRecord(slot)) continue;
    const { key, text } = slot;
    if (typeof key !== 'string' || key.length === 0 || typeof text !== 'string') continue;
    const draft: ComposerDraft = {
      text: truncateDraftText(text),
      chips: parseChips(slot.chips),
      refs: parseRefs(slot.refs),
    };
    if (isEmpty(draft)) continue;
    drafts[key] = draft;
  }
  return drafts;
}

let persistTimer: number | undefined;

/** 立即落盘（卸载 / 转后台 / debounce 到点）。只同步写一小段 JSON，不做重活。 */
function flushPersist(): void {
  if (persistTimer !== undefined) {
    window.clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  const storage = browserStorage();
  if (storage === null) return;
  const slots = collectSlots();
  try {
    if (slots.length === 0) {
      storage.removeItem(STORAGE_KEY);
      return;
    }
    const payload: PersistedPayload = { v: STORAGE_VERSION, slots };
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 配额满 / 隐私模式：静默降级为纯内存，草稿在当前页面里照常可用。
  }
}

/** 写动作后节流落盘：每敲一个字都写一次 storage 没必要。 */
function schedulePersist(): void {
  if (typeof window === 'undefined') return;
  if (persistTimer !== undefined) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = undefined;
    flushPersist();
  }, PERSIST_DEBOUNCE_MS);
}

let hydrated = false;

/** 页面转后台补一次 flush（移动端切走可能不触发 beforeunload）。 */
function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') flushPersist();
}

/**
 * 首次使用（读或写草稿）时 hydrate 一次。刻意**不在模块顶层**读 storage：
 * SSR 没有 window，导入期读会把整个模块带崩，也避免没人用草稿时白读一次。
 *
 * 这里会 `setState`，而读路径（`useComposerDraftText`）是在组件 render 里调用的 ——
 * 安全的原因：这是**首次**使用，此刻还没有任何订阅者（`useSyncExternalStore` 要到
 * commit 才订阅），所以不存在「渲染另一个组件期间更新它」；之后只是一次布尔判断。
 * 不用 effect 兜的原因：那样首帧会先渲染空输入框再补上，闪一下。
 */
function ensureHydrated(): void {
  if (hydrated) return;
  // SSR 里不置位：同构环境下客户端那次还得真正 hydrate。
  if (typeof window === 'undefined') return;
  hydrated = true;
  window.addEventListener('pagehide', flushPersist);
  window.addEventListener('beforeunload', flushPersist);
  document.addEventListener('visibilitychange', onVisibilityChange);
  const storage = browserStorage();
  if (storage === null) return;
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  const restored = parseDrafts(raw);
  if (restored === null) return;
  const keys = Object.keys(restored);
  if (keys.length === 0) return;
  // 恢复顺序即「由旧到新」，让后续淘汰沿用同一口径。
  for (const key of keys) markTouched(key);
  // 合并（而不是覆盖）：万一首次使用前已经有内存草稿，别把它抹掉。
  useComposerDraftStore.setState((state) => ({ drafts: { ...restored, ...state.drafts } }));
}

interface ComposerDraftState {
  drafts: Record<string, ComposerDraft>;
  /** 写正文；支持函数式更新，与 React `useState` 的 setter 同形，便于直接顶替。 */
  setText: (key: string, value: string | ((prev: string) => string)) => void;
  setChips: (key: string, chips: readonly ComposerChip[]) => void;
  /** 写待发送引用（整组替换；顺序即发送顺序）。 */
  setRefs: (key: string, refs: readonly MessageRef[]) => void;
  /**
   * 加一条引用（尾部追加，不查重）：同一路径两次引用就是两个 chip，
   * 删除按下标回写，与 `MessageRefs` 的渲染口径一致。超过上限返回 `false`。
   */
  addRef: (key: string, ref: MessageRef) => boolean;
  /** 删一条引用（下标即 refs 里的位置）。 */
  removeRef: (key: string, index: number) => void;
  /** 发送成功后清空该 key（正文、chips 与引用一起）。 */
  clear: (key: string) => void;
}

function isEmpty(draft: ComposerDraft): boolean {
  return draft.text.length === 0 && draft.chips.length === 0 && draft.refs.length === 0;
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

export const useComposerDraftStore = create<ComposerDraftState>()((set, get) => ({
  drafts: {},

  setText: (key, value) => {
    ensureHydrated();
    const current = get().drafts[key] ?? EMPTY_DRAFT;
    const text = typeof value === 'function' ? value(current.text) : value;
    // 同值写入不写 state（`Object.is` 短路，不触发重渲染），也不落盘。
    if (text === current.text) return;
    // 只换正文时保留 chips / refs 引用，那两个订阅者不因敲字重渲染。
    const drafts = withDraft(get().drafts, key, {
      text,
      chips: current.chips,
      refs: current.refs,
    });
    set({ drafts });
    if (drafts[key] === undefined) forget(key);
    else markTouched(key);
    schedulePersist();
  },

  setChips: (key, chips) => {
    ensureHydrated();
    const current = get().drafts[key] ?? EMPTY_DRAFT;
    const drafts = withDraft(get().drafts, key, {
      text: current.text,
      chips,
      refs: current.refs,
    });
    set({ drafts });
    if (drafts[key] === undefined) forget(key);
    else markTouched(key);
    schedulePersist();
  },

  setRefs: (key, refs) => {
    ensureHydrated();
    const current = get().drafts[key] ?? EMPTY_DRAFT;
    const capped = refs.slice(0, MAX_DRAFT_REFS);
    const drafts = withDraft(get().drafts, key, {
      text: current.text,
      chips: current.chips,
      refs: capped,
    });
    set({ drafts });
    if (drafts[key] === undefined) forget(key);
    else markTouched(key);
    schedulePersist();
  },

  addRef: (key, ref) => {
    ensureHydrated();
    const current = get().drafts[key] ?? EMPTY_DRAFT;
    if (current.refs.length >= MAX_DRAFT_REFS) return false;
    const drafts = withDraft(get().drafts, key, {
      text: current.text,
      chips: current.chips,
      refs: [...current.refs, ref],
    });
    set({ drafts });
    markTouched(key);
    schedulePersist();
    return true;
  },

  removeRef: (key, index) => {
    ensureHydrated();
    const current = get().drafts[key];
    if (current === undefined) return;
    const refs = current.refs.filter((_, position) => position !== index);
    if (refs.length === current.refs.length) return;
    const drafts = withDraft(get().drafts, key, {
      text: current.text,
      chips: current.chips,
      refs,
    });
    set({ drafts });
    if (drafts[key] === undefined) forget(key);
    else markTouched(key);
    schedulePersist();
  },

  clear: (key) => {
    ensureHydrated();
    if (get().drafts[key] === undefined) return;
    const drafts = { ...get().drafts };
    delete drafts[key];
    set({ drafts });
    forget(key);
    schedulePersist();
  },
}));

/** 读 key 的正文；未命中回退空串（原始值，引用天然稳定）。 */
export function useComposerDraftText(key: string): string {
  // 首次使用才碰 storage（模块顶层不读）；之后只是一次布尔判断。
  ensureHydrated();
  return useComposerDraftStore((state) => state.drafts[key]?.text ?? '');
}

/** 读 key 的 chips；未命中回退冻结空数组。 */
export function useComposerChips(key: string): readonly ComposerChip[] {
  ensureHydrated();
  return useComposerDraftStore((state) => state.drafts[key]?.chips ?? EMPTY_CHIPS);
}

/** 未命中 key 时的稳定空引用（`Object.is` 比较快照，不能每次渲染新建）。 */
const EMPTY_REFS: readonly MessageRef[] = Object.freeze([]);

/** 读 key 的待发送引用；未命中回退冻结空数组（顺序即发送顺序）。 */
export function useComposerRefs(key: string): readonly MessageRef[] {
  ensureHydrated();
  return useComposerDraftStore((state) => state.drafts[key]?.refs ?? EMPTY_REFS);
}

/** 引用条数上限（与 `addRef` / 落盘解析共用一份）。 */
export const MAX_COMPOSER_REFS = MAX_DRAFT_REFS;

/**
 * 把草稿态（`chat:new`）的正文继承给目标会话槽。
 *
 * 会话页的自动恢复会在进入 `#/chat`（无 sessionId）后导航到上次的真实会话：
 * 草稿若只留在 `chat:new`，路由一换就读不到，「换页回来草稿没了」。这里在导航前
 * 把正文搬过去，避免丢字。目标槽已有正文时不覆盖（那份也同样是用户的字，不能丢），
 * 此时源槽原样保留 —— 用户回到「新建会话」仍能看到它。
 */
export function adoptNewChatDraft(sessionId: string): void {
  ensureHydrated();
  const { drafts, setText, setRefs, clear } = useComposerDraftStore.getState();
  const source = drafts[NEW_CHAT_DRAFT_KEY];
  const text = source?.text ?? '';
  if (text.length === 0) return;
  const targetKey = chatDraftKey(sessionId);
  if ((drafts[targetKey]?.text ?? '').length > 0) return;
  setText(targetKey, text);
  // 引用与正文同族：草稿态攒的附件跟正文一起搬到目标会话槽（目标槽已有引用时不覆盖）。
  const refs = source?.refs ?? EMPTY_REFS;
  if (refs.length > 0 && (drafts[targetKey]?.refs ?? EMPTY_REFS).length === 0) {
    setRefs(targetKey, refs);
  }
  clear(NEW_CHAT_DRAFT_KEY);
}
