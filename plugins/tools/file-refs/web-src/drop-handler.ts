/**
 * drop 槽处理器（A2/A3）：OS 文件（拖拽 / 截图粘贴）→ 上传暂存 → 指针位置插卡。
 *
 * 链路：每个文件先插一个**瞬态占位卡**（上传中，不参与序列化）→ port.stage
 * 上传落 node 暂存副本 → addRef（结构化引用，单一真相源）→ 占位卡落定为
 * markdown 族 token `[name](<vessel-ref:path>)`（A6 正文投影）。
 * 失败 ⇒ 占位卡变错误态（可重试 / 删除），不静默吞。
 */

import type { ComposerDropHandler, ComposerEditorPort } from '@vessel-agent/plugin-sdk';

/** 构造规范 token（与宿主 buildAtomicToken 同形；插件独立构建不 import 宿主）。 */
function buildToken(name: string, path: string): string {
  const label = name.replace(/[[\]\n]/g, '').trim() || path;
  return `[${label}](<vessel-ref:${path}>)`;
}

interface TransientData {
  status: 'uploading' | 'error';
  name: string;
  error?: string;
  retry?: () => void;
}

/** 单文件上传 + 落定（重试复用同一路径）。 */
async function stageOne(
  file: File,
  port: ComposerEditorPort,
  at: { offset: number | null },
  transient: ReturnType<ComposerEditorPort['insertTransient']>,
  notify: (kind: 'error' | 'success', text: string) => void,
  copy: (key: 'drop.limit' | 'drop.failed', vars?: Record<string, string | number>) => string,
): Promise<void> {
  const settle = (result: {
    path: string;
    name: string;
    kind: 'file' | 'image' | 'document';
    mime?: string;
    bytes: number;
    sha256: string;
  }) => {
    const added = port.addRef({
      kind: result.kind,
      path: result.path,
      name: result.name,
      ...(result.mime !== undefined ? { mime: result.mime } : {}),
      bytes: result.bytes,
      sha256: result.sha256,
    });
    if (!added) {
      transient?.remove();
      notify('error', copy('drop.limit'));
      return;
    }
    const token = buildToken(result.name, result.path);
    if (transient !== null) transient.settle(token);
    else port.insertAtomic(token, at.offset ?? undefined);
  };

  const [result] = await port.stage([file]);
  if (result !== undefined && result.ok) {
    settle(result);
    return;
  }
  const error = result !== undefined && !result.ok ? result.error : 'empty result';
  const data: TransientData = {
    status: 'error',
    name: file.name,
    error,
    retry: () => {
      transient?.update({ status: 'uploading', name: file.name } satisfies TransientData);
      void stageOne(file, port, at, transient, notify, copy).catch(() => undefined);
    },
  };
  if (transient !== null) transient.update(data);
  notify('error', copy('drop.failed', { name: file.name }));
}

/** embed 具名导出（contributes.composer drop 槽）。 */
export const onFilesDropped: ComposerDropHandler = (files, port, at) => {
  // 文案：drop 处理器拿不到 React 上下文，用 host 无关的英文兜底 + 卡片侧 i18n。
  const copy = (key: 'drop.limit' | 'drop.failed', vars?: Record<string, string | number>) => {
    const en = key === 'drop.limit' ? 'Reference limit reached (32)' : 'Could not upload {name}';
    let text = en;
    if (vars !== undefined) {
      for (const [name, value] of Object.entries(vars)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  };
  const notify = (_kind: 'error' | 'success', _text: string) => {
    // 占位卡自身已显示错误态；toast 由卡片侧重试面承担，这里不重复打扰。
  };
  for (const file of files) {
    const transient = port.insertTransient(
      'vessel-ref',
      {
        status: 'uploading',
        name: file.name,
      } satisfies TransientData,
      at.offset ?? undefined,
    );
    void stageOne(file, port, at, transient, notify, copy).catch(() => undefined);
  }
};
