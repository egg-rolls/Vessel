/**
 * 宿主编辑端口（ComposerEditorPort）的页面侧装配（file-ref-ux）。
 *
 * 把 RichComposer 开放接口 + 草稿槽 refs 动作 + 宿主 attachments 域能力
 * （stage / preview）包成 plugin-sdk 契约的端口，交给 composer 贡献插件。
 * 插件拿不到宿主 DOM / store 原对象，只有这一面。
 */

import type { ComposerEditorPort } from '@vessel-agent/plugin-sdk';
import { type RefObject, useMemo, useRef } from 'react';
import type { RichComposerHandle } from '../../components/ui/RichComposer';
import { useConnection } from '../../gateway/ConnectionProvider';
import { stageFiles } from '../../gateway/node/attachments';
import type { MessageRef } from '../../gateway/types';

export function useComposerEditorPort({
  editorRef,
  refs,
  onAddRef,
  onRemoveRef,
  onUpdateRef,
}: {
  editorRef: RefObject<RichComposerHandle | null>;
  refs: readonly MessageRef[];
  onAddRef?: (ref: MessageRef) => boolean;
  onRemoveRef?: (index: number) => void;
  onUpdateRef?: (index: number, patch: { inline?: boolean }) => boolean;
}): ComposerEditorPort | undefined {
  const { client } = useConnection();
  // live ref：端口对象稳定，能力读最新值（草稿 refs 每次渲染都变）。
  const live = useRef({ refs, onAddRef, onRemoveRef, onUpdateRef, client });
  live.current = { refs, onAddRef, onRemoveRef, onUpdateRef, client };
  const available = onAddRef !== undefined && onRemoveRef !== undefined;

  return useMemo(() => {
    if (!available) return undefined;
    const port: ComposerEditorPort = {
      refs: () => live.current.refs,
      addRef: (ref) => live.current.onAddRef?.(ref as MessageRef) ?? false,
      removeRef: (index) => live.current.onRemoveRef?.(index),
      updateRef: (index, patch) => live.current.onUpdateRef?.(index, patch) ?? false,
      insertText: (text, at) => editorRef.current?.insertText(text, at),
      insertAtomic: (token, at) => editorRef.current?.insertAtomic(token, at),
      insertTransient: (scheme, data, at) =>
        editorRef.current?.insertTransient(scheme, data, at) ?? null,
      getCaretOffset: () => editorRef.current?.getCaretOffset() ?? 0,
      caretOffsetFromPoint: (x, y) => editorRef.current?.caretOffsetFromPoint(x, y) ?? null,
      stage: (files) => stageFiles(live.current.client, files),
      preview: (path) => live.current.client.previewAttachment(path),
    };
    return port;
    // biome-ignore lint/correctness/useExhaustiveDependencies: editorRef / available 是稳定身份，能力经 live ref 读现值
  }, [editorRef, available]);
}
