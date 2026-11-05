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
};
