/**
 * RichComposer：contenteditable 富编辑输入框（file-ref-ux A8，宿主通用基建）。
 *
 * 取代 `AutoGrowTextarea` 的两处使用面（会话 Composer / 团队 TeamComposer）：
 * - 文本流中可内嵌**原子卡片节点**（`contenteditable=false` 的 span），与文本混排；
 * - 卡片内容由**贡献插件**经 `atomicSchemes` 注册渲染器（宿主不认识任何具体功能）；
 * - 序列化口径：文本原样 + 卡片 → markdown 族 token `[name](<scheme:target>)`，
 *   token 就在用户插入的位置（A6 正文投影；结构化 refs 仍是单一真相源）；
 * - IME composition 守卫（composition 期间不同步外部值、不序列化）、
 *   粘贴纯文本化（clipboard 文件交 `onPasteFiles`；文本里的 token 解析还原卡片）、
 *   自管 undo 栈（覆盖原子节点插入/删除）、选区保持、自动增高、placeholder、disabled。
 *
 * 开放接口（`RichComposerHandle`）：focus / 取光标偏移 / 指针位置取偏移 /
 * 插入文本 / 插入原子节点 / 插入瞬态节点（上传占位，不参与序列化）。
 * 宿主端口（ComposerEditorPort）经此接口把能力交给插件，插件拿不到宿主 DOM。
 *
 * @module @vessel-agent/web/components/ui
 */

import {
  type ComponentType,
  forwardRef,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

/** 原子卡片渲染器收到的 props（插件组件；宿主只传形状，不认识内容）。 */
export interface AtomicCardProps {
  scheme: string;
  /** token 里的显示名。 */
  name: string;
  /** token 里的目标（如文件路径）；瞬态节点为空串。 */
  target: string;
  /** 瞬态节点附加数据（上传中 / 失败态等）；已落定 token 节点缺省。 */
  data?: unknown;
  /** 宿主编辑端口（不透明；贡献插件经 plugin-sdk 契约消费）。 */
  port?: unknown;
  /** 删除本节点（宿主回写序列化值）。 */
  onRemove: () => void;
}

/** 一个已注册的原子 scheme：token 前缀 → 卡片渲染器。 */
export interface AtomicScheme {
  scheme: string;
  render: ComponentType<AtomicCardProps>;
}

/** 瞬态节点句柄（上传占位 → 落定 / 更新 / 删除）。 */
export interface TransientHandle {
  /** 落定为真实 token（进入序列化）。 */
  settle(token: string): void;
  /** 更新附加数据（重渲染卡片）。 */
  update(data: unknown): void;
  /** 删除节点。 */
  remove(): void;
}

export interface RichComposerHandle {
  focus(): void;
  element(): HTMLDivElement | null;
  /** 当前光标在序列化文本里的偏移。 */
  getCaretOffset(): number;
  /** 指针位置 → 序列化文本偏移（拖拽指针插入用）；不在编辑面内 = null。 */
  caretOffsetFromPoint(x: number, y: number): number | null;
  insertText(text: string, at?: number): void;
  insertAtomic(token: string, at?: number): void;
  insertTransient(scheme: string, data: unknown, at?: number): TransientHandle | null;
}

export interface RichComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** 光标偏移变化（mention 等按序列化文本定位的功能用）。 */
  onCaretChange?: (offset: number) => void;
  /** 外部请求把光标放到指定偏移（nonce 变化触发；mention 选中后用）。 */
  caretRequest?: { offset: number; nonce: number } | null;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  maxHeightVar?: string;
  spellCheck?: boolean;
  enterKeyHint?: 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send';
  'aria-label'?: string;
  role?: string;
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
  'aria-autocomplete'?: 'none' | 'list' | 'inline' | 'both';
  'aria-activedescendant'?: string;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  /** clipboard 文件（截图粘贴）；给了才接管，否则走浏览器默认。 */
  onPasteFiles?: (files: File[]) => void;
  /** 已注册的原子 scheme（缺省 = 纯文本编辑，token 按原文显示）。 */
  atomicSchemes?: readonly AtomicScheme[];
  /** 传给卡片渲染器的宿主编辑端口（不透明）。 */
  atomicPort?: unknown;
}

const FALLBACK_MAX_PX = 200;

/** 解析出的片段：纯文本或原子 token。 */
type Segment =
  | { type: 'text'; text: string }
  | { type: 'atomic'; token: string; scheme: string; name: string; target: string };

/** token 形状：`[name](<scheme:target>)`（尖括号目标形，容空格 / 圆括号）。 */
const TOKEN_RE = /\[([^\]\n]*)\]\(<([A-Za-z][A-Za-z0-9+.-]*):([^>\n]*)>\)/g;

/** 构造规范 token（name 里的方括号剔除；target 含 `>` / 换行时返回 null）。 */
export function buildAtomicToken(name: string, scheme: string, target: string): string | null {
  if (target.length === 0 || /[>\n]/.test(target)) return null;
  const label = name.replace(/[[\]\n]/g, '').trim() || target;
  return `[${label}](<${scheme}:${target}>)`;
}

/** 按已注册 scheme 把文本切成片段；未注册 scheme 的 token 原样留作文本。 */
export function parseSegments(value: string, schemes: readonly AtomicScheme[]): Segment[] {
  if (schemes.length === 0 || value.length === 0) return [{ type: 'text', text: value }];
  const known = new Set(schemes.map((entry) => entry.scheme));
  const segments: Segment[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let match = TOKEN_RE.exec(value); match !== null; match = TOKEN_RE.exec(value)) {
    const token = match[0];
    const name = match[1] ?? '';
    const scheme = match[2] ?? '';
    const target = match[3] ?? '';
    if (!known.has(scheme)) continue;
    if (match.index > last) segments.push({ type: 'text', text: value.slice(last, match.index) });
    segments.push({ type: 'atomic', token, scheme, name, target });
    last = match.index + token.length;
  }
  if (last < value.length) segments.push({ type: 'text', text: value.slice(last) });
  return segments;
}

/** 从 token 反解 {scheme,name,target}；形状不对 = null。 */
export function parseAtomicToken(
  token: string,
): { scheme: string; name: string; target: string } | null {
  TOKEN_RE.lastIndex = 0;
  const match = TOKEN_RE.exec(token);
  if (match === null || match[0] !== token) return null;
  return { scheme: match[2] ?? '', name: match[1] ?? '', target: match[3] ?? '' };
} // ── DOM ⇄ 序列化 ────────────────────────────────────────────────────────

function isAtomicSpan(node: Node): node is HTMLSpanElement {
  return node instanceof HTMLSpanElement && node.dataset.token !== undefined;
}

function isTransientSpan(node: Node): node is HTMLSpanElement {
  return node instanceof HTMLSpanElement && node.dataset.transient !== undefined;
}

/** 节点序列化长度（文本 = 字数；原子 = token 长；瞬态 = 0；BR = 1）。 */
function nodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
  if (isAtomicSpan(node)) return node.dataset.token?.length ?? 0;
  if (isTransientSpan(node)) return 0;
  if (node instanceof HTMLBRElement) return 1;
  let total = 0;
  node.childNodes.forEach((child) => {
    total += nodeLength(child);
  });
  return total;
}

/** DOM → 序列化文本（瞬态节点跳过；块级边界补换行）。 */
function serializeRoot(root: HTMLElement): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (isAtomicSpan(node)) {
      parts.push(node.dataset.token ?? '');
      return;
    }
    if (isTransientSpan(node)) return;
    if (node instanceof HTMLBRElement) {
      parts.push('\n');
      return;
    }
    if (node instanceof HTMLDivElement || node instanceof HTMLParagraphElement) {
      const joined = parts.join('');
      if (joined.length > 0 && !joined.endsWith('\n')) parts.push('\n');
    }
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return parts.join('');
}

/** 序列化 + 光标偏移（光标不在编辑面内时回退 fallback）。 */
function serializeWithCaret(root: HTMLElement, fallback: number): { text: string; caret: number } {
  const selection = window.getSelection();
  let caret = fallback;
  if (selection !== null && selection.rangeCount > 0) {
    const anchorNode = selection.anchorNode;
    if (anchorNode !== null && root.contains(anchorNode)) {
      let offset = 0;
      let found = false;
      const walk = (node: Node): void => {
        if (found) return;
        if (node === anchorNode) {
          if (node.nodeType === Node.TEXT_NODE) {
            offset += Math.min(selection.anchorOffset, node.textContent?.length ?? 0);
          } else {
            // 元素锚点：offset 是子节点下标，累加其前子节点长度。
            const limit = Math.min(selection.anchorOffset, node.childNodes.length);
            for (let index = 0; index < limit; index += 1) {
              const child = node.childNodes[index];
              if (child !== undefined) offset += nodeLength(child);
            }
          }
          found = true;
          return;
        }
        if (
          node.nodeType === Node.TEXT_NODE ||
          isAtomicSpan(node) ||
          node instanceof HTMLBRElement
        ) {
          offset += nodeLength(node);
          return;
        }
        if (isTransientSpan(node)) return;
        node.childNodes.forEach(walk);
      };
      root.childNodes.forEach(walk);
      if (found) caret = offset;
    }
  }
  return { text: serializeRoot(root), caret };
}

/** 把光标放到序列化偏移处（原子 token 边界落在 span 前/后）。 */
function setCaretOffset(root: HTMLElement, offset: number): void {
  const selection = window.getSelection();
  if (selection === null) return;
  const range = document.createRange();
  let remaining = Math.max(0, offset);
  let placed = false;
  const walk = (node: Node): void => {
    if (placed) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) {
        range.setStart(node, remaining);
        placed = true;
        return;
      }
      remaining -= length;
      return;
    }
    if (isAtomicSpan(node)) {
      const length = node.dataset.token?.length ?? 0;
      if (remaining <= 0) {
        range.setStartBefore(node);
        placed = true;
        return;
      }
      if (remaining < length) {
        // 落在 token 内部：放到 span 之后（原子不可分割）。
        range.setStartAfter(node);
        placed = true;
        return;
      }
      remaining -= length;
      return;
    }
    if (isTransientSpan(node)) return;
    if (node instanceof HTMLBRElement) {
      if (remaining <= 0) {
        range.setStartBefore(node);
        placed = true;
        return;
      }
      remaining -= 1;
      return;
    }
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  if (!placed) {
    range.selectNodeContents(root);
    range.collapse(false);
  } else {
    range.collapse(true);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

/** 指针坐标 → 编辑面内序列化偏移（Chrome caretRangeFromPoint / FF caretPositionFromPoint）。 */
function caretOffsetFromPoint(root: HTMLElement, x: number, y: number): number | null {
  let node: Node | null = null;
  let nodeOffset = 0;
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    if (range === null) return null;
    node = range.startContainer;
    nodeOffset = range.startOffset;
  } else if (typeof doc.caretPositionFromPoint === 'function') {
    const position = doc.caretPositionFromPoint(x, y);
    if (position === null) return null;
    node = position.offsetNode;
    nodeOffset = position.offset;
  }
  if (node === null || !root.contains(node)) return null;
  let offset = 0;
  let found = false;
  const walk = (current: Node): void => {
    if (found) return;
    if (current === node) {
      if (current.nodeType === Node.TEXT_NODE) {
        offset += Math.min(nodeOffset, current.textContent?.length ?? 0);
      } else if (isAtomicSpan(current)) {
        offset += nodeLength(current);
      } else {
        const limit = Math.min(nodeOffset, current.childNodes.length);
        for (let index = 0; index < limit; index += 1) {
          const child = current.childNodes[index];
          if (child !== undefined) offset += nodeLength(child);
        }
      }
      found = true;
      return;
    }
    if (
      current.nodeType === Node.TEXT_NODE ||
      isAtomicSpan(current) ||
      current instanceof HTMLBRElement
    ) {
      offset += nodeLength(current);
      return;
    }
    if (isTransientSpan(current)) return;
    current.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return found ? offset : null;
}

function parsePx(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed.endsWith('px')) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function resolveMaxPx(element: HTMLElement, maxHeightVar: string): number {
  const declared = getComputedStyle(element).getPropertyValue(maxHeightVar);
  const direct = parsePx(declared);
  if (direct !== null) return direct;
  return parsePx(getComputedStyle(element).maxHeight) ?? FALLBACK_MAX_PX;
}

/** portal 条目：一个原子 / 瞬态 span 的渲染描述。 */
interface PortalEntry {
  key: string;
  el: HTMLSpanElement;
  scheme: string;
  name: string;
  target: string;
  data?: unknown;
}

interface UndoEntry {
  value: string;
  caret: number;
}

const UNDO_COALESCE_MS = 800;
const UNDO_LIMIT = 200;
export const RichComposer = forwardRef<RichComposerHandle, RichComposerProps>(function RichComposer(
  {
    value,
    onChange,
    onCaretChange,
    caretRequest = null,
    placeholder,
    disabled = false,
    className,
    maxHeightVar = '--composer-input-max-h',
    spellCheck = false,
    enterKeyHint,
    onKeyDown,
    onCompositionStart,
    onCompositionEnd,
    onPasteFiles,
    atomicSchemes = [],
    atomicPort,
    ...aria
  },
  forwardedRef,
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  const pendingValueRef = useRef<string | null>(null);
  /** 最近一次「已发出 / 已同步」的序列化值（外部 value 与它相同就不重建 DOM）。 */
  const lastValueRef = useRef<string | null>(null);
  const caretRef = useRef(0);
  const lastNonceRef = useRef(0);
  const portalSeqRef = useRef(0);
  const undoRef = useRef<{ entries: UndoEntry[]; index: number; lastPush: number }>({
    entries: [],
    index: -1,
    lastPush: 0,
  });
  const [portals, setPortals] = useState<PortalEntry[]>([]);
  /** key → portal 条目（瞬态句柄 / 删除按 key 直查，不在 setState updater 里碰 DOM）。 */
  const portalMapRef = useRef(new Map<string, PortalEntry>());

  // live ref：imperative handle / 事件回调永远读最新 props（不重建句柄）。
  const live = useRef({
    onChange,
    onCaretChange,
    onKeyDown,
    onPasteFiles,
    atomicSchemes,
    disabled,
  });
  live.current = { onChange, onCaretChange, onKeyDown, onPasteFiles, atomicSchemes, disabled };

  const resize = useCallback(() => {
    const element = rootRef.current;
    if (element === null) return;
    element.style.height = 'auto';
    const extra = element.offsetHeight - element.clientHeight;
    const maxPx = resolveMaxPx(element, maxHeightVar);
    element.style.height = `${Math.min(element.scrollHeight + extra + 1, maxPx)}px`;
  }, [maxHeightVar]);

  const updateEmpty = useCallback(() => {
    const element = rootRef.current;
    if (element === null) return;
    element.dataset.empty = serializeRoot(element) === '' ? 'true' : 'false';
  }, []);

  const registerPortal = useCallback((entry: PortalEntry) => {
    portalMapRef.current.set(entry.key, entry);
    setPortals((current) => [...current, entry]);
  }, []);

  const unregisterPortal = useCallback((key: string) => {
    portalMapRef.current.delete(key);
    setPortals((current) => current.filter((item) => item.key !== key));
  }, []);

  /** 建一个原子 span（同时登记 portal 条目）。 */
  const makeAtomicSpan = useCallback(
    (segment: {
      token: string;
      scheme: string;
      name: string;
      target: string;
    }): {
      el: HTMLSpanElement;
      entry: PortalEntry;
    } => {
      const el = document.createElement('span');
      el.contentEditable = 'false';
      el.className = 'rich-atomic';
      el.dataset.token = segment.token;
      el.dataset.scheme = segment.scheme;
      portalSeqRef.current += 1;
      const entry: PortalEntry = {
        key: `a${String(portalSeqRef.current)}`,
        el,
        scheme: segment.scheme,
        name: segment.name,
        target: segment.target,
      };
      return { el, entry };
    },
    [],
  );

  /** 全量重建 DOM（外部值变化 / 初始化 / undo 应用）。 */
  const rebuild = useCallback(
    (nextValue: string, caret: number) => {
      const root = rootRef.current;
      if (root === null) return;
      root.textContent = '';
      portalMapRef.current.clear();
      const entries: PortalEntry[] = [];
      for (const segment of parseSegments(nextValue, live.current.atomicSchemes)) {
        if (segment.type === 'text') {
          root.appendChild(document.createTextNode(segment.text));
        } else {
          const { el, entry } = makeAtomicSpan(segment);
          root.appendChild(el);
          entries.push(entry);
          portalMapRef.current.set(entry.key, entry);
        }
      }
      setPortals(entries);
      lastValueRef.current = nextValue;
      caretRef.current = caret;
      setCaretOffset(root, caret);
      updateEmpty();
      resize();
    },
    [makeAtomicSpan, resize, updateEmpty],
  );

  /** 序列化结果发出 + undo 入栈（coalesce：连续敲字合并成一条）。 */
  const emit = useCallback(
    (text: string, caret: number, coalesce: boolean) => {
      const undo = undoRef.current;
      const now = Date.now();
      const top = undo.entries[undo.index];
      if (
        coalesce &&
        undo.index === undo.entries.length - 1 &&
        top !== undefined &&
        now - undo.lastPush < UNDO_COALESCE_MS
      ) {
        undo.entries[undo.index] = { value: text, caret };
      } else {
        undo.entries = undo.entries.slice(0, undo.index + 1);
        undo.entries.push({ value: text, caret });
        if (undo.entries.length > UNDO_LIMIT) undo.entries.shift();
        undo.index = undo.entries.length - 1;
      }
      undo.lastPush = now;
      lastValueRef.current = text;
      caretRef.current = caret;
      live.current.onChange(text);
      live.current.onCaretChange?.(caret);
      updateEmpty();
      resize();
    },
    [resize, updateEmpty],
  );

  /** 从当前 DOM 序列化并发出（input / compositionend / 节点增删后）。 */
  const emitFromDom = useCallback(
    (coalesce: boolean) => {
      const root = rootRef.current;
      if (root === null) return;
      const { text, caret } = serializeWithCaret(root, caretRef.current);
      emit(text, caret, coalesce);
    },
    [emit],
  );
  const applySnapshot = useCallback(
    (entry: UndoEntry) => {
      rebuild(entry.value, entry.caret);
      live.current.onChange(entry.value);
      live.current.onCaretChange?.(entry.caret);
    },
    [rebuild],
  );

  const undo = useCallback(() => {
    const state = undoRef.current;
    if (state.index <= 0) return;
    state.index -= 1;
    const entry = state.entries[state.index];
    if (entry !== undefined) applySnapshot(entry);
  }, [applySnapshot]);

  const redo = useCallback(() => {
    const state = undoRef.current;
    if (state.index >= state.entries.length - 1) return;
    state.index += 1;
    const entry = state.entries[state.index];
    if (entry !== undefined) applySnapshot(entry);
  }, [applySnapshot]);

  /** 在指定偏移插入节点（先删选区内容），光标落到插入内容之后。 */
  const insertNodesAt = useCallback(
    (offset: number, nodes: Node[], insertedLength: number, entries: PortalEntry[]) => {
      const root = rootRef.current;
      if (root === null) return;
      root.focus();
      setCaretOffset(root, offset);
      const selection = window.getSelection();
      if (selection !== null && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        // insertNode 逐个插入会逆序：用 fragment 一次插入保持顺序。
        const fragment = document.createDocumentFragment();
        for (const node of nodes) fragment.appendChild(node);
        range.insertNode(fragment);
      } else {
        for (const node of nodes) root.appendChild(node);
      }
      for (const entry of entries) registerPortal(entry);
      setCaretOffset(root, offset + insertedLength);
      emitFromDom(false);
    },
    [emitFromDom, registerPortal],
  );

  const insertText = useCallback(
    (text: string, at?: number) => {
      if (text.length === 0) return;
      const offset = at ?? caretRef.current;
      insertNodesAt(offset, [document.createTextNode(text)], text.length, []);
    },
    [insertNodesAt],
  );

  const insertAtomic = useCallback(
    (token: string, at?: number) => {
      const parsed = parseAtomicToken(token);
      const known =
        parsed !== null &&
        live.current.atomicSchemes.some((entry) => entry.scheme === parsed.scheme);
      if (parsed === null || !known) {
        insertText(token, at);
        return;
      }
      const { el, entry } = makeAtomicSpan({ token, ...parsed });
      insertNodesAt(at ?? caretRef.current, [el], token.length, [entry]);
    },
    [insertNodesAt, insertText, makeAtomicSpan],
  );

  /** 删除一个原子 / 瞬态 span（按 portal key）并发出序列化。 */
  const removeSpanByKey = useCallback(
    (key: string) => {
      const entry = portalMapRef.current.get(key);
      if (entry === undefined) return;
      entry.el.remove();
      unregisterPortal(key);
      emitFromDom(false);
    },
    [emitFromDom, unregisterPortal],
  );

  /** 瞬态节点（上传占位）：不参与序列化；settle 后落定为真实 token。 */
  const insertTransient = useCallback(
    (scheme: string, data: unknown, at?: number): TransientHandle | null => {
      const root = rootRef.current;
      if (root === null) return null;
      if (!live.current.atomicSchemes.some((entry) => entry.scheme === scheme)) return null;
      const el = document.createElement('span');
      el.contentEditable = 'false';
      el.className = 'rich-atomic';
      portalSeqRef.current += 1;
      const key = `t${String(portalSeqRef.current)}`;
      el.dataset.transient = key;
      el.dataset.scheme = scheme;
      const entry: PortalEntry = { key, el, scheme, name: '', target: '', data };
      // 插到指定偏移（drop 指针位置）或当前光标处；瞬态不参与序列化。
      setCaretOffset(root, at ?? caretRef.current);
      const selection = window.getSelection();
      if (selection !== null && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(el);
        range.setStartAfter(el);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        root.appendChild(el);
      }
      registerPortal(entry);
      updateEmpty();
      resize();
      return {
        settle(token: string) {
          const parsed = parseAtomicToken(token);
          if (parsed === null || !el.isConnected) return;
          delete el.dataset.transient;
          el.dataset.token = token;
          const current = portalMapRef.current.get(key);
          if (current !== undefined) {
            current.name = parsed.name;
            current.target = parsed.target;
            current.data = undefined;
            setPortals((items) => [...items]);
          }
          emitFromDom(false);
        },
        update(nextData: unknown) {
          const current = portalMapRef.current.get(key);
          if (current === undefined) return;
          current.data = nextData;
          setPortals((items) => [...items]);
        },
        remove() {
          removeSpanByKey(key);
        },
      };
    },
    [emitFromDom, registerPortal, removeSpanByKey, resize, updateEmpty],
  );
  useImperativeHandle(
    forwardedRef,
    () => ({
      focus() {
        rootRef.current?.focus();
      },
      element() {
        return rootRef.current;
      },
      getCaretOffset() {
        const root = rootRef.current;
        if (root === null) return caretRef.current;
        const { caret } = serializeWithCaret(root, caretRef.current);
        return caret;
      },
      caretOffsetFromPoint(x: number, y: number) {
        const root = rootRef.current;
        if (root === null) return null;
        return caretOffsetFromPoint(root, x, y);
      },
      insertText,
      insertAtomic,
      insertTransient,
    }),
    [insertText, insertAtomic, insertTransient],
  );

  // 外部 value / caretRequest 同步（IME 期间挂起，compositionend 后补）。
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    if (caretRequest !== null && caretRequest.nonce !== lastNonceRef.current) {
      lastNonceRef.current = caretRequest.nonce;
      if (value === lastValueRef.current) {
        setCaretOffset(root, caretRequest.offset);
        caretRef.current = caretRequest.offset;
        return;
      }
    }
    if (value === lastValueRef.current) return;
    if (composingRef.current) {
      pendingValueRef.current = value;
      return;
    }
    const initial = lastValueRef.current === null;
    const caret =
      caretRequest !== null && caretRequest.nonce === lastNonceRef.current
        ? caretRequest.offset
        : Math.min(caretRef.current, value.length);
    rebuild(value, caret);
    if (initial) {
      // undo 栈底 = 初始草稿（第一次敲字可撤回到这里）。
      undoRef.current = { entries: [{ value, caret }], index: 0, lastPush: 0 };
    }
  }, [value, caretRequest, rebuild]);

  // scheme 注册变化（插件加载 / 撤离）：按当前值重解析（token ⇄ 纯文本）。
  const schemesKey = atomicSchemes.map((entry) => entry.scheme).join(',');
  const firstSchemesRef = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: schemesKey 是 scheme 集合的身份（内容驱动重建）
  useLayoutEffect(() => {
    if (firstSchemesRef.current) {
      firstSchemesRef.current = false;
      return;
    }
    if (lastValueRef.current !== null) rebuild(lastValueRef.current, caretRef.current);
  }, [schemesKey, rebuild]);

  useLayoutEffect(() => {
    // value 变化 → 内容高度变化，需重算（与 AutoGrowTextarea 同一口径）。
    void value;
    resize();
  }, [value, resize]);

  useEffect(() => {
    const element = rootRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => resize());
    observer.observe(element);
    return () => observer.disconnect();
  }, [resize]);

  const syncCaret = useCallback(() => {
    const root = rootRef.current;
    if (root === null) return;
    const { caret } = serializeWithCaret(root, caretRef.current);
    caretRef.current = caret;
    live.current.onCaretChange?.(caret);
  }, []);

  const handleInput = useCallback(() => {
    if (composingRef.current) return;
    emitFromDom(true);
  }, [emitFromDom]);

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
    onCompositionStart?.();
  }, [onCompositionStart]);

  const handleCompositionEnd = useCallback(() => {
    composingRef.current = false;
    onCompositionEnd?.();
    const pending = pendingValueRef.current;
    pendingValueRef.current = null;
    if (pending !== null && pending !== lastValueRef.current) {
      rebuild(pending, Math.min(caretRef.current, pending.length));
      return;
    }
    emitFromDom(false);
  }, [emitFromDom, onCompositionEnd, rebuild]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (live.current.disabled) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && !event.shiftKey && key === 'z') {
        event.preventDefault();
        undo();
        return;
      }
      if ((mod && key === 'y') || (mod && event.shiftKey && key === 'z')) {
        event.preventDefault();
        redo();
        return;
      }
      live.current.onKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && !composingRef.current) {
        if (event.shiftKey) {
          event.preventDefault();
          insertText('\n');
        }
        return;
      }
      // Backspace 紧邻原子节点：整块删除（contenteditable=false 的原子语义）。
      if (event.key === 'Backspace' && !mod) {
        const root = rootRef.current;
        const selection = window.getSelection();
        if (root === null || selection === null || selection.rangeCount === 0) return;
        if (!selection.isCollapsed) return;
        const range = selection.getRangeAt(0);
        let candidate: Node | null = null;
        const node = range.startContainer;
        const offset = range.startOffset;
        if (node.nodeType === Node.TEXT_NODE && offset === 0) {
          candidate = node.previousSibling;
        } else if (node === root && offset > 0) {
          candidate = root.childNodes[offset - 1] ?? null;
        }
        if (candidate !== null && (isAtomicSpan(candidate) || isTransientSpan(candidate))) {
          event.preventDefault();
          const entry = [...portalMapRef.current.values()].find((item) => item.el === candidate);
          if (entry !== undefined) removeSpanByKey(entry.key);
          else {
            candidate.parentNode?.removeChild(candidate);
            emitFromDom(false);
          }
        }
      }
    },
    [emitFromDom, insertText, redo, removeSpanByKey, undo],
  );

  const handlePaste = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      if (live.current.disabled) return;
      const files = event.clipboardData?.files;
      if (files !== undefined && files.length > 0 && live.current.onPasteFiles !== undefined) {
        event.preventDefault();
        live.current.onPasteFiles(Array.from(files));
        return;
      }
      const text = event.clipboardData?.getData('text/plain');
      if (text === undefined || text === '') return;
      event.preventDefault();
      // 纯文本化 + token 还原卡片（卡片粘贴走 token 解析）。
      const root = rootRef.current;
      if (root === null) return;
      const offset = caretRef.current;
      const nodes: Node[] = [];
      const entries: PortalEntry[] = [];
      let length = 0;
      for (const segment of parseSegments(text, live.current.atomicSchemes)) {
        if (segment.type === 'text') {
          nodes.push(document.createTextNode(segment.text));
          length += segment.text.length;
        } else {
          const { el, entry } = makeAtomicSpan(segment);
          nodes.push(el);
          entries.push(entry);
          length += segment.token.length;
        }
      }
      insertNodesAt(offset, nodes, length, entries);
    },
    [insertNodesAt, makeAtomicSpan],
  );

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      // OS 文件 drop 交给卡片层（Composer onDrop → 插件 drop 处理器）；这里不接管。
      if (event.dataTransfer.files.length > 0) return;
      // 自定义 MIME（如会话引用 application/x-vessel-session-ref）交卡片层分流，
      // 编辑面不抢（否则会话卡拖拽会被当纯文本插入）。
      if (Array.from(event.dataTransfer.types).some((type) => type.startsWith('application/'))) {
        return;
      }
      const text = event.dataTransfer.getData('text/plain');
      if (text === '') return;
      event.preventDefault();
      const root = rootRef.current;
      const offset =
        root !== null
          ? (caretOffsetFromPoint(root, event.clientX, event.clientY) ?? caretRef.current)
          : caretRef.current;
      insertText(text, offset);
    },
    [insertText],
  );
  const { role: roleProp, ...restAria } = aria;
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: contenteditable 编辑面（role=textbox 动态传入），不是静态元素 */}
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-multiline 对 textbox 合法；role 是动态 prop，静态分析认不出 */}
      <div
        ref={rootRef}
        className={`rich-composer${className !== undefined && className !== '' ? ` ${className}` : ''}`}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role={roleProp ?? 'textbox'}
        aria-multiline="true"
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        spellCheck={spellCheck}
        enterKeyHint={enterKeyHint}
        data-rich-composer=""
        data-placeholder={placeholder}
        data-empty="true"
        style={{ maxHeight: `var(${maxHeightVar}, ${FALLBACK_MAX_PX}px)`, overflowY: 'auto' }}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onSelect={syncCaret}
        onClick={syncCaret}
        onKeyUp={syncCaret}
        onFocus={syncCaret}
        {...restAria}
      />
      {portals.map((entry) => {
        const registered = atomicSchemes.find((item) => item.scheme === entry.scheme);
        const Render = registered?.render;
        return createPortal(
          Render !== undefined ? (
            <Render
              scheme={entry.scheme}
              name={entry.name}
              target={entry.target}
              data={entry.data}
              port={atomicPort}
              onRemove={() => removeSpanByKey(entry.key)}
            />
          ) : (
            <span className="rich-atomic-fallback">{entry.name || entry.target}</span>
          ),
          entry.el,
          entry.key,
        );
      })}
    </>
  );
});
