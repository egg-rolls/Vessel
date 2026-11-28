/**
 * 上传暂存共享链路（G10，file-ref P3 S2a 自 drop-handler 抽出，零行为变更）：
 * OS 文件 / 原生选择框 → 瞬态占位卡 → port.stage → addRef → token 落定。
 *
 * 链路：每个文件先插一个**瞬态占位卡**（上传中，不参与序列化）→ port.stage
 * 上传落 node 暂存副本 → addRef（结构化引用，单一真相源）→ 占位卡落定为
 * markdown 族 token `[name](<vessel-ref:path>)`（A6 正文投影）。
 * 失败 ⇒ 占位卡变错误态（可重试 / 删除），不静默吞。
 *
 * drop 槽（onFilesDropped）与 toolbar action 档（onAttachClick）共用这一条。
 */

import type { ComposerEditorPort } from '@vessel-agent/plugin-sdk';

/** 构造规范 token（与宿主 buildAtomicToken 同形；插件独立构建不 import 宿主）。 */
export function buildToken(name: string, path: string): string {
  const label = name.replace(/[[\]\n]/g, '').trim() || path;
  return `[${label}](<vessel-ref:${path}>)`;
}

export interface TransientData {
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
    // A1 收口（file-ref-ux M4）：图片 ref **不携带 sha256**——stager 虽已落 blob
    // 去重，但 ref 带 sha 会被 vision plan 直接内联，绕过 inline 闸（默认关形同虚设）。
    // 默认路径-only；用户开「随消息发送图像」⇒ refs[].inline=true，发送时经 ingest
    // 读暂存路径入池（TTL 内有效；过期诚实降级 not_ingested）。非图片 kind 的 sha
    // 与视觉无关，保留作对账元信息。
    const added = port.addRef({
      kind: result.kind,
      path: result.path,
      name: result.name,
      ...(result.mime !== undefined ? { mime: result.mime } : {}),
      bytes: result.bytes,
      ...(result.kind !== 'image' ? { sha256: result.sha256 } : {}),
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

/**
 * 逐文件：瞬态占位卡 → stageOne。drop / picker 两入口同形（at = 指针 / 光标位）。
 * 文案：处理器拿不到 React 上下文，用 host 无关的英文兜底 + 卡片侧 i18n。
 */
export function stageFiles(
  files: readonly File[],
  port: ComposerEditorPort,
  at: { offset: number | null },
): void {
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
}
