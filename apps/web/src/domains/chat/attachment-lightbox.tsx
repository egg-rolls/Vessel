/**
 * 宿主标准附件预览弹窗（q-image-chip-inline）：插件 embed 经
 * `host.attachments.openPreview(path)` 打开，宿主决定形态 —— 图片复用既有
 * ImageLightbox（大图 object-contain + 完整路径 + 复制 + 临时态），不另造。
 * q-pdf-preview-channel：同 store 分流 PDF（PdfLightbox，浏览器原生查看器），
 * 取值接缝 openAttachmentPreview 与 host-factory / RefCard 共用一份。
 *
 * 模块级单例 store（与 state/theme 同一 subscribe/getSnapshot 模式）：
 * 同一时刻只有一张预览；App 根挂一个 <AttachmentLightbox/> 消费。
 * 字节由调用侧先取好再开弹窗 —— 这里只渲染。
 */

import { useSyncExternalStore } from 'react';
import type { AttachmentPreviewResult } from '../../gateway/node/attachments';
import { ImageLightbox } from './image-preview';
import { refDisplayName } from './MessageRefs';
import { PdfLightbox } from './pdf-preview';

export interface AttachmentLightboxState {
  /** 预览字节（data URL）。 */
  url: string;
  /** 显示名（basename）。 */
  name: string;
  /** 完整绝对路径（弹窗路径行 + 复制键）。 */
  path: string;
  /** 暂存未入池（「临时」badge）。 */
  staging?: boolean;
  /** 预览形态（缺省 image，旧调用零回归）；pdf = 浏览器原生查看器。 */
  kind?: 'image' | 'pdf';
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

/** 最小 RPC 面（GatewayClient 满足；与 attachments.ts AttachmentStageRpc 同思路）。 */
export interface AttachmentPreviewRpc {
  previewAttachment(path: string): Promise<AttachmentPreviewResult>;
}

/**
 * 共享取值接缝：`attachments.preview` 取字节 → 按 mime 分流开弹窗
 * （application/pdf ⇒ PdfLightbox，其余 ⇒ ImageLightbox）。
 * 字节不可用 ⇒ reject（`attachment_preview_unavailable: <status>`），
 * 调用侧自行降级（host-factory 插件 toast / RefCard 复制路径）。
 */
export async function openAttachmentPreview(
  client: AttachmentPreviewRpc,
  path: string,
): Promise<AttachmentPreviewResult> {
  const result = await client.previewAttachment(path);
  if (result.status !== 'ok' || result.dataUrl === undefined) {
    throw new Error(`attachment_preview_unavailable: ${result.status}`);
  }
  openAttachmentLightbox({
    url: result.dataUrl,
    name: refDisplayName({ kind: 'file', path }),
    path,
    staging: result.staging === true,
    kind: result.mime === 'application/pdf' ? 'pdf' : 'image',
  });
  return result;
}

/** App 根挂载一次：有预览才渲染（ModalShell 自带 Esc / 焦点圈 / 滚动锁）。 */
export function AttachmentLightbox() {
  const state = useSyncExternalStore(subscribe, () => current);
  if (state === null) return null;
  if (state.kind === 'pdf') {
    return (
      <PdfLightbox
        url={state.url}
        name={state.name}
        path={state.path}
        staging={state.staging}
        onClose={closeAttachmentLightbox}
      />
    );
  }
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
