/**
 * link 槽卡片（消息正文 vessel-ref 链接）：只读卡片（缩略图 / ICON + 名称），
 * 点击 = 复制路径（绝不导航）；hover 全路径；暂存「临时」徽标 + 过期态。
 * AI 产出的同形 markdown 链接也走这里（A6 双向闭环）。
 */

import type { ComposerLinkCardProps, ComposerPreviewResult } from '@vessel-agent/plugin-sdk';
import { useEffect, useMemo, useState } from 'react';
import { translator } from './i18n';
import { displayNameOf, kindOfPath, RefIcon } from './icons';
import { makeThumbnail } from './thumbnail';

const SCHEME_PREFIX = 'vessel-ref:';

function useHostLang(host: ComposerLinkCardProps['host']): string {
  const [theme, setTheme] = useState(() => host.theme.get());
  useEffect(() => host.theme.subscribe(setTheme), [host]);
  return theme.lang;
}

export function FileRefLinkCard({ href, text, host }: ComposerLinkCardProps) {
  const lang = useHostLang(host);
  const t = useMemo(() => translator(lang), [lang]);
  const path = href.startsWith(SCHEME_PREFIX) ? href.slice(SCHEME_PREFIX.length) : href;
  const [preview, setPreview] = useState<ComposerPreviewResult | null>(null);
  const [thumb, setThumb] = useState<string | undefined>(undefined);
  const kind = kindOfPath(path);
  const displayName = text || displayNameOf(path);

  useEffect(() => {
    let active = true;
    void host.attachments
      .preview(path)
      .then((result) => {
        if (!active) return;
        setPreview(result);
        // 缩略图只对图片尝试（PDF 字节解不出 Image；q-pdf-preview-channel）。
        // 点击契约保持复制路径（A6）——是否改预览候 main 裁，见批次报告。
        if (
          result.status === 'ok' &&
          result.dataUrl !== undefined &&
          kindOfPath(path) === 'image'
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
  }, [path, host]);

  const expired = preview?.status === 'gone';
  const staging = preview?.staging === true;

  const copyPath = () => {
    void navigator.clipboard
      .writeText(path)
      .then(() => host.toast({ kind: 'success', text: t('card.path-copied') }))
      .catch(() => host.toast({ kind: 'error', text: t('card.copy-path') }));
  };

  return (
    <button
      type="button"
      className={`file-ref-link${expired ? ' is-expired' : ''}`}
      title={path}
      aria-label={`${displayName} — ${t('card.copy-path')}`}
      onClick={copyPath}
    >
      {thumb !== undefined && !expired ? (
        <img className="file-ref-thumb" src={thumb} alt="" width={36} height={36} />
      ) : (
        <span className="file-ref-icon">
          <RefIcon kind={kind} />
        </span>
      )}
      <span className="file-ref-name">{displayName}</span>
      {expired ? (
        <span className="file-ref-badge is-expired">{t('card.expired')}</span>
      ) : (
        staging && <span className="file-ref-badge is-temp">{t('card.temporary')}</span>
      )}
    </button>
  );
}
