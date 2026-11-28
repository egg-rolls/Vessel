/**
 * PDF 预览弹窗（q-pdf-preview-channel）：复用 ModalShell（Esc / 焦点圈 /
 * 滚动锁 / reduced-motion 全套既有 a11y）+ LightboxMeta（文件名 + 完整路径行
 * + 复制键 + 暂存 badge，与 ImageLightbox 同一份），不另造壳。
 *
 * 查看器 = 浏览器原生 PDF 查看器（iframe），不引 pdf.js 重依赖（裁定：原生够用）。
 * 字节来自 `attachments.preview` 的 dataUrl（与图片同一条 RPC / 边界闸 / size
 * 上限）；这里转成 blob: URL 再喂 iframe —— data: URL 在各家浏览器 iframe /
 * embed 里有兼容坑（顶层导航拦截 / 查看器不启动），blob: 同源稳定。
 * object URL 随卸载 revoke，不泄漏。
 */
import { useEffect, useState } from 'react';
import { ModalShell } from '../../components/Modal';
import { t } from '../../i18n';
import { LightboxMeta } from './image-preview';

/** dataUrl → blob: URL（卸载 revoke）；解码失败返 undefined（占位降级）。 */
function usePdfBlobUrl(dataUrl: string): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    let objectUrl: string | undefined;
    try {
      const comma = dataUrl.indexOf(',');
      if (comma < 0) throw new Error('malformed data url');
      const binary = atob(dataUrl.slice(comma + 1));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      setUrl(objectUrl);
    } catch {
      setUrl(undefined);
    }
    return () => {
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [dataUrl]);
  return url;
}

/**
 * PDF 放大预览：iframe 原生查看器 + 共享元信息行。`path` / `staging` 语义与
 * ImageLightbox 完全一致（路径行 + 复制键 / 「临时」badge）。
 */
export function PdfLightbox({
  url,
  name,
  onClose,
  path,
  staging,
}: {
  /** PDF 字节（attachments.preview 的 dataUrl）。 */
  url: string;
  name: string;
  onClose: () => void;
  /** 完整绝对路径（给了才渲染路径行 + 复制键）。 */
  path?: string;
  /** 暂存未入池（「临时」badge）。 */
  staging?: boolean;
}) {
  const blobUrl = usePdfBlobUrl(url);
  const label = t('chat.pdf.previewNamed', { name });
  return (
    <ModalShell
      label={label}
      closeLabel={t('chat.toolImage.close')}
      onClose={onClose}
      size="xl"
      className="tool-image-lightbox pdf-lightbox"
    >
      {blobUrl !== undefined ? (
        <iframe src={blobUrl} title={label} className="pdf-lightbox-frame" />
      ) : (
        <p className="m-0 w-full text-center text-2xs text-faint">
          {t('chat.toolImage.unavailable')}
        </p>
      )}
      <LightboxMeta name={name} path={path} staging={staging} />
    </ModalShell>
  );
}
