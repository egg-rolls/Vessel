/**
 * toolbar `action` 档处理器（G9/G10，file-ref P3）：插件自持「引用文件」弹层。
 *
 * 用户点 toolbar「引用文件」按钮 → AttachSheet（上传 / 粘贴 / 浏览三入口，S2b）：
 * - 上传：浏览器原生文件选择（showOpenFilePicker 能力探测；非 Chromium / 非安全
 *   上下文降级 input[type=file]）→ 共享暂存链路（瞬态占位卡 → port.stage →
 *   addRef → token 落定），插入位 = 当前光标位（与 drop 同口径）；
 * - 粘贴 / 浏览：addRef + insertAtomic（token 同形，节点路径引用模式）。
 *
 * 用户取消（AbortError / 空选择）⇒ 静默返回，不留占位卡。
 * embed 运行宿主同上下文（非 iframe），直调浏览器 API，无需宿主开放新能力。
 */

import type { ComposerToolbarActionHandler } from '@vessel-agent/plugin-sdk';
import { createRoot } from 'react-dom/client';
import { AttachSheet } from './AttachSheet';

/** File System Access API 最小结构类型（不依赖 lib.dom 是否收录该 API）。 */
interface FilePickerHandle {
  getFile(): Promise<File>;
}
type ShowOpenFilePicker = (options?: { multiple?: boolean }) => Promise<FilePickerHandle[]>;

/**
 * 浏览器 DOM 最小结构面（root tsc 程序里 bun-types 的全局 document/window 是
 * 受限形状；这里只声明本文件用到的成员，经 globalThis 结构化访问，不依赖
 * lib.dom / bun-types 的合并口径）。
 */
interface PickerInput {
  type: string;
  multiple: boolean;
  style: { display: string };
  files: ArrayLike<File> | null;
  addEventListener(type: string, listener: () => void): void;
  click(): void;
  remove(): void;
}
interface PickerDom {
  document: {
    createElement(tag: 'input'): PickerInput;
    createElement(tag: 'div'): { remove(): void };
    body: { appendChild(node: PickerInput | { remove(): void }): void };
  };
  setTimeout(callback: () => void, ms: number): number;
  addEventListener(type: 'focus', listener: () => void, options?: { once?: boolean }): void;
  showOpenFilePicker?: ShowOpenFilePicker;
}
const dom = globalThis as unknown as PickerDom;

/** input[type=file] 降级档：一次性隐藏 input，click 在用户手势内。 */
function pickViaInput(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = dom.document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    let done = false;
    const finish = (files: File[]) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    // 现代浏览器取消时发 cancel；旧浏览器兜底：窗口重新聚焦后收尾（空选择）。
    input.addEventListener('cancel', () => finish([]));
    dom.addEventListener(
      'focus',
      () => {
        dom.setTimeout(() => finish(Array.from(input.files ?? [])), 500);
      },
      { once: true },
    );
    dom.document.body.appendChild(input);
    input.click();
  });
}

/** 原生选择框（能力探测 + 降级）；取消 ⇒ 空数组。 */
async function pickFiles(): Promise<File[]> {
  const picker = dom.showOpenFilePicker;
  if (typeof picker === 'function') {
    try {
      const handles = await picker({ multiple: true });
      return Promise.all(handles.map((handle) => handle.getFile()));
    } catch (error) {
      // 用户取消（AbortError）静默；其它异常降级 input 档再试一次。
      if (error instanceof DOMException && error.name === 'AbortError') return [];
      return pickViaInput();
    }
  }
  return pickViaInput();
}

/** 单例守卫：同一时刻只开一个弹层（重复点击不叠第二层）。 */
let sheetOpen = false;

/**
 * embed 具名导出（contributes.toolbar[].action）：开插件自持弹层
 * （上传 / 粘贴 / 浏览三入口，S2b）。上传档 = 原生选择框 → 共享暂存链路；
 * 粘贴 / 浏览 = addRef + insertAtomic（token 同形）。焦点圈 / Esc / 归还焦点
 * 在 AttachSheet 内重建（宿主 ModalShell 不可 import）。
 */
export const onAttachClick: ComposerToolbarActionHandler = (port, host) => {
  if (sheetOpen) return;
  sheetOpen = true;
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const close = () => {
    root.unmount();
    container.remove();
    sheetOpen = false;
  };
  root.render(<AttachSheet port={port} host={host} onClose={close} pickFiles={pickFiles} />);
};
