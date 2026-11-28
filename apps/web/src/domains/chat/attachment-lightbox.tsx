/**
 * 宿主标准附件预览弹窗（q-image-chip-inline）：插件 embed 经
 * `host.attachments.openPreview(path)` 打开，宿主决定形态 —— 图片复用既有
 * ImageLightbox（大图 object-contain + 完整路径 + 复制 + 临时态），不另造。
 *
 * 模块级单例 store（与 state/theme 同一 subscribe/getSnapshot 模式）：
 * 同一时刻只有一张预览；App 根挂一个 <AttachmentLightbox/> 消费。
 * 字节由调用侧（host-factory 适配器）先取好再开弹窗 —— 这里只渲染。
 */

import { useSyncExternalStore } from 'react';
import { ImageLightbox } from './image-preview';

export interface AttachmentLightboxState {
  /** 预览字节（data URL）。 */
  url: string;
  /** 显示名（basename）。 */
  name: string;
  /** 完整绝对路径（弹窗路径行 + 复制键）。 */
  path: string;
  /** 暂存未入池（「临时」badge）。 */
  staging?: boolean;
}

let current: AttachmentLightboxState | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** 打开（替换）当前预览。 */
export function openAttachmentLightbox(state: AttachmentLightboxState): void {
  current = state;
  emit();
}

/** 关闭当前预览。 */
export function closeAttachmentLightbox(): void {
  if (current === null) return;
  current = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** App 根挂载一次：有预览才渲染（ModalShell 自带 Esc / 焦点圈 / 滚动锁）。 */
export function AttachmentLightbox() {
  const state = useSyncExternalStore(subscribe, () => current);
  if (state === null) return null;
  return (
    <ImageLightbox
      url={state.url}
      name={state.name}
      path={state.path}
      staging={state.staging}
      onClose={closeAttachmentLightbox}
    />
  );
}
