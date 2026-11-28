/**
 * refs 槽卡片（输入框内原子节点）：行内 text-height chip —— 1em 缩略图 /
 * 种类 ICON + 文件名 + 「临时」徽标 + 过期态 + ×删除。hover 显全路径。
 * 数据源：port.preview（过期探针 + 缩略图字节）。
 *
 * q-image-chip-inline：图片 kind 落定态 chip 体 = 真 button（原生键盘可达），
 * 点击经 host.attachments.openPreview 开宿主标准弹窗（既有 ImageLightbox：
 * 大图 + 完整路径 + 复制 + 临时态）。× 是兄弟 button，不嵌套、不冒泡误触。
 * q-pdf-preview-channel：PDF 同走 openPreview（宿主分流 PdfLightbox 原生查看器）。
 */

import type { ComposerCardProps, ComposerPreviewResult } from '@vessel-agent/plugin-sdk';
import { useEffect, useMemo, useState } from 'react';
import { translator } from './i18n';
import { CloseIcon, displayNameOf, isPdfPath, kindOfPath, RefIcon } from './icons';
import { makeThumbnail } from './thumbnail';

function useHostLang(host: ComposerCardProps['host']): string {
  const [theme, setTheme] = useState(() => host.theme.get());
  useEffect(() => host.theme.subscribe(setTheme), [host]);
  return theme.lang;
}

interface TransientData {
  status?: 'uploading' | 'error';
  name?: string;
  error?: string;
  retry?: () => void;
}

export function FileRefCard({ name, target, data, onRemove, port, host }: ComposerCardProps) {
  const lang = useHostLang(host);
  const t = useMemo(() => translator(lang), [lang]);
  const transient = data as TransientData | undefined;
  const isTransient = target === '';
  const [preview, setPreview] = useState<ComposerPreviewResult | null>(null);
  const [thumb, setThumb] = useState<string | undefined>(undefined);

  // 过期探针 + 缩略图（落定节点才探；瞬态节点只显示上传态）。
  useEffect(() => {
    if (isTransient) return;
    let active = true;
    const probe = port !== undefined ? port.preview(target) : host.attachments.preview(target);
    void probe
      .then((result) => {
        if (!active) return;
        setPreview(result);
        // 缩略图只对图片尝试（PDF 字节解不出 Image，不浪费解码；q-pdf-preview-channel）。
        if (
          result.status === 'ok' &&
          result.dataUrl !== undefined &&
          kindOfPath(target) === 'image'
        ) {
          void makeThumbnail(result.dataUrl).then((url) => {
            if (active) setThumb(url);
          });
        }
      })
      .catch(() => {
        if (active) setPreview({ status: 'denied' });
      });
    return () => {
      active = false;
    };
  }, [isTransient, target, port, host]);

  const displayName = isTransient ? (transient?.name ?? name) : name || displayNameOf(target);
  const kind = kindOfPath(isTransient ? (transient?.name ?? '') : target);
  const expired = preview?.status === 'gone';
  const staging = preview?.staging === true;

  const remove = () => {
    if (port !== undefined && !isTransient) {
      const index = port.refs().findIndex((ref) => ref.path === target);
      if (index >= 0) port.removeRef(index);
    }
    onRemove();
  };

  // 宿主标准预览弹窗（大图 + 路径 + 复制）；字节不可用 ⇒ 插件侧 toast。
  const openPreview = () => {
    void host.attachments.openPreview(target).catch(() => {
      host.toast({ kind: 'error', text: t('card.preview-failed') });
    });
  };

  if (isTransient && transient?.status === 'error') {
    return (
      <span className="file-ref-card is-error" title={transient.error ?? t('card.failed')}>
        <span className="file-ref-icon">
          <RefIcon kind={kind} size={12} />
        </span>
        <span className="file-ref-name">{displayName}</span>
        <span className="file-ref-badge is-expired">{t('card.failed')}</span>
        {transient.retry !== undefined && (
          <button type="button" className="file-ref-action" onClick={transient.retry}>
            {t('card.retry')}
          </button>
        )}
        <button
          type="button"
          className="file-ref-remove"
          aria-label={t('card.remove', { name: displayName })}
          onClick={onRemove}
        >
          <CloseIcon />
        </button>
      </span>
    );
  }

  if (isTransient) {
    return (
      <span className="file-ref-card is-uploading" title={t('card.uploading')}>
        <span className="file-ref-icon is-spin" aria-hidden="true">
          <RefIcon kind={kind} size={12} />
        </span>
        <span className="file-ref-name">{displayName}</span>
        <span className="file-ref-badge">{t('card.uploading')}</span>
      </span>
    );
  }

  const body = (
    <>
      {thumb !== undefined && !expired ? (
        <img className="file-ref-thumb" src={thumb} alt="" width={12} height={12} />
      ) : (
        <span className="file-ref-icon">
          <RefIcon kind={kind} size={12} />
        </span>
      )}
      <span className="file-ref-name">{displayName}</span>
      {expired ? (
        <span className="file-ref-badge is-expired">{t('card.expired')}</span>
      ) : (
        staging && <span className="file-ref-badge is-temp">{t('card.temporary')}</span>
      )}
    </>
  );

  return (
    <span
      className={`file-ref-card${expired ? ' is-expired' : ''}`}
      title={target}
      data-kind={kind}
    >
      {(kind === 'image' || isPdfPath(target)) && !expired ? (
        <button
          type="button"
          className="file-ref-body"
          onClick={openPreview}
          aria-label={t('card.preview', { name: displayName })}
        >
          {body}
        </button>
      ) : (
        body
      )}
      <button
        type="button"
        className="file-ref-remove"
        aria-label={t('card.remove', { name: displayName })}
        title={t('card.remove', { name: displayName })}
        onClick={remove}
      >
        <CloseIcon />
      </button>
    </span>
  );
}
