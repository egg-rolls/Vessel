/**
 * Minimal DOM surface used by the package.
 *
 * The repo's root tsconfig compiles with `lib: ["ES2022"]` only; consumers
 * (browsers / plugin apps) have the real DOM lib. This file lets the shared
 * package typecheck under the root program without pulling `lib.dom` in
 * globally (which changes Bun/WebSocket types for unrelated packages).
 */
interface DOMRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface EventTarget {
  /** Marker so the interface is non-empty; merges with lib.dom / @types/react. */
  readonly __vesselEventTarget?: never;
}

interface Node {
  contains(other: Node | null): boolean;
}

interface Element extends Node {
  getBoundingClientRect(): DOMRect;
  scrollIntoView(options?: { block?: 'nearest' | 'start' | 'center' | 'end' }): void;
  /** 菜单焦点管理用（additive，q-thinking-plugin P3）。 */
  querySelector<E extends Element = Element>(selectors: string): E | null;
  querySelectorAll<E extends Element = Element>(selectors: string): NodeListOf<E>;
}

/** querySelectorAll 返回值的最小数组_like 形状（可迭代 / 可索引）。 */
interface NodeListOf<TNode extends Node> {
  readonly length: number;
  item(index: number): TNode | null;
  [index: number]: TNode;
  [Symbol.iterator](): IterableIterator<TNode>;
}

interface HTMLElement extends Element {
  focus(): void;
}

interface HTMLButtonElement extends HTMLElement {
  disabled: boolean;
}

interface HTMLInputElement extends HTMLElement {
  value: string;
  selectionStart: number | null;
  setSelectionRange(start: number | null, end: number | null, direction?: string): void;
}

interface HTMLTextAreaElement extends HTMLElement {
  value: string;
  selectionStart: number;
  setSelectionRange(start: number, end: number): void;
}

interface HTMLDivElement extends HTMLElement {}
interface HTMLSpanElement extends HTMLElement {}
interface HTMLDListElement extends HTMLElement {}

interface MouseEvent {
  target: EventTarget | null;
}

/** 键盘事件最小形状（菜单方向键 / Esc，additive P3）。 */
interface KeyboardEvent {
  key: string;
  target: EventTarget | null;
  preventDefault(): void;
}

interface Window {
  innerWidth: number;
  innerHeight: number;
  addEventListener(
    type: string,
    listener: (event: MouseEvent) => void,
    options?: boolean | { capture?: boolean },
  ): void;
  removeEventListener(
    type: string,
    listener: (event: MouseEvent) => void,
    options?: boolean | { capture?: boolean },
  ): void;
}

declare var Node: { new (): Node; prototype: Node };
declare var window: Window;
declare var document: {
  body: HTMLElement;
  documentElement: HTMLElement;
  activeElement: Element | null;
  addEventListener(
    type: string,
    listener: (event: MouseEvent) => void,
    options?: boolean | { capture?: boolean },
  ): void;
  addEventListener(
    type: string,
    listener: (event: KeyboardEvent) => void,
    options?: boolean | { capture?: boolean },
  ): void;
  removeEventListener(
    type: string,
    listener: (event: MouseEvent) => void,
    options?: boolean | { capture?: boolean },
  ): void;
  removeEventListener(
    type: string,
    listener: (event: KeyboardEvent) => void,
    options?: boolean | { capture?: boolean },
  ): void;
};
