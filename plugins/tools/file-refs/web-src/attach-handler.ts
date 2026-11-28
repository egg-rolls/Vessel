/**
 * toolbar `action` 档处理器（G9/G10，file-ref P3）：原生选择框上传入口。
 *
 * 插件自持点击动作（宿主零功能名）：用户点 toolbar「引用文件」按钮 → 浏览器
 * 原生文件选择（showOpenFilePicker，能力探测；非 Chromium / 非安全上下文降级
 * input[type=file]）→ 复用 drop 槽同一条上传链路（瞬态占位卡 → port.stage →
 * addRef → token 落定），插入位 = 当前光标位（与 drop 同口径）。
 *
 * 用户取消（AbortError / 空选择）⇒ 静默返回，不留占位卡。
 * embed 运行宿主同上下文（非 iframe），直调浏览器 API，无需宿主开放新能力。
 */

import type { ComposerToolbarActionHandler } from '@vessel-agent/plugin-sdk';
import { stageFiles } from './staging';

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
    body: { appendChild(node: PickerInput): void };
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

/** embed 具名导出（contributes.toolbar[].action）。 */
export const onAttachClick: ComposerToolbarActionHandler = async (port, _host) => {
  const files = await pickFiles();
  if (files.length === 0) return;
  // 与 drop 完全同形（共享 staging 链路）：逐文件瞬态占位卡 → stage → addRef → token 落定。
  stageFiles(files, port, { offset: port.getCaretOffset() });
};
