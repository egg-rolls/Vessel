/**
 * 可复用图片预览件（q-media-image-card）：缩略图 + 放大预览 + blob 取值 hook。
 *
 * 与卡片基座（CardShell）/ 弹窗基座（ModalShell）同一复用判据：图片卡是第一个
 * 消费者，未来任何要显示「已入池图片」的卡（用户附件缩略图 / 其他工具卡）都走这里，
 * 不各造一套取字节 + 量尺寸 + 放大的逻辑。
 *
 * 字节来源：`images.blob`（内容寻址，只按 sha256）经 LRU 缓存（image-blob-cache.ts）。
 * 尺寸：浏览器解码后 naturalWidth/Height 实测（服务端不解图，不猜尺寸）。
 * 降级：拿不到字节 / 解不出码（旧 gateway / 缺 blob / TIFF 等浏览器不收的格式）⇒
 * 「预览不可用」占位 + 元数据照旧 —— 不显示破图，不吞文件名与投递状态。
 */
import { useContext, useEffect, useState } from 'react';
import { ModalShell } from '../../components/Modal';
import { Icon, useMessageCopy } from '../../components/ui';
import { ConnectionContext } from '../../gateway/connection-context';
import { t } from '../../i18n';
import { imageBlobUrl } from './image-blob-cache';

/** 一张图的预览取值状态（尺寸在解码完成后才有）。 */
export interface ImageBlobState {
  status: 'loading' | 'ready' | 'unavailable';
  /** data URL（ready 时有）。 */
  url?: string;
  width?: number;
  height?: number;
}

const UNAVAILABLE: ImageBlobState = { status: 'unavailable' };

/**
 * 按 sha256 取预览（缓存命中零 RPC）。无 sha256 / 无会话归属 / 无连接（设计预览 /
 * 未连 gateway）直接 unavailable —— 组件在这些环境里也要能渲染（只少了缩略图）。
 * `sessionId` 过服务端可见性闸（fail-closed，见 node/images.ts）。
 */
export function useImageBlob(
  sha256: string | undefined,
  sessionId: string | undefined,
): ImageBlobState {
  const connection = useContext(ConnectionContext);
  const client = connection?.client;
  const [state, setState] = useState<ImageBlobState>(UNAVAILABLE);

  useEffect(() => {
    if (
      sha256 === undefined ||
      sha256.length === 0 ||
      sessionId === undefined ||
      sessionId.length === 0 ||
      client === undefined
    ) {
      setState(UNAVAILABLE);
      return;
    }
    let stale = false;
    setState({ status: 'loading' });
    void (async () => {
      const url = await imageBlobUrl(client, sha256, sessionId);
      if (stale) return;
      if (url === undefined) {
        setState(UNAVAILABLE);
        return;
      }
      // 先给 url（缩略图可画），尺寸由解码回调补齐。
      setState({ status: 'ready', url });
      const probe = new Image();
      probe.onload = () => {
        if (stale) return;
        setState({ status: 'ready', url, width: probe.naturalWidth, height: probe.naturalHeight });
      };
      probe.onerror = () => {
        // 字节在但浏览器解不出（TIFF / 损坏）：退回占位，元数据不受影响。
        if (!stale) setState(UNAVAILABLE);
      };
      probe.src = url;
    })();
    return () => {
      stale = true;
    };
  }, [client, sha256, sessionId]);

  return state;
}

/**
 * 缩略图（可点放大）。loading 画骨架屏；unavailable 画占位（图标 + 一句话）。
 * 放大入口只在 ready 时给 —— 没有字节就没有可放大的东西。
 */
export function ImageThumb({
  state,
  name,
  onOpen,
}: {
  state: ImageBlobState;
  name: string;
  onOpen?: (url: string) => void;
}) {
  if (state.status === 'loading') {
    return (
      <div className="tool-image-thumb tool-image-thumb-loading animate-pulse" aria-busy="true">
        <span className="sr-only">{t('chat.toolImage.loading')}</span>
      </div>
    );
  }
  if (state.status !== 'ready' || state.url === undefined) {
    return (
      <div className="tool-image-thumb tool-image-thumb-unavailable">
        <svg
          width={20}
          height={20}
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="3" y="4" width="14" height="12" rx="2" />
          <circle cx="7.5" cy="8" r="1.3" />
          <path d="M4 14.5 8.5 10l3 3 2-2 2.5 2.5" />
        </svg>
        <span className="text-2xs">{t('chat.toolImage.unavailable')}</span>
      </div>
    );
  }
  const url = state.url;
  return (
    <button
      type="button"
      className="tool-image-thumb"
      onClick={() => onOpen?.(url)}
      title={t('chat.toolImage.preview')}
      aria-label={t('chat.toolImage.previewNamed', { name })}
    >
      <img src={url} alt={name} loading="lazy" decoding="async" />
    </button>
  );
}

/**
 * 放大预览：复用 ModalShell（Esc / 焦点圈 / 滚动锁 / portal 全套既有 a11y），
 * 不另造 lightbox。图片按视口收敛（object-contain），不裁不拉伸。
 *
 * 可选 `path`（q-image-chip-inline）：完整绝对路径行（可选中）+ 复制键
 * （既有 useMessageCopy：clipboard + toast）；`staging` = 暂存未入池「临时」
 * badge。两者缺省时形态与旧版完全一致（ToolImageCard 等既有消费零回归）。
 */
export function ImageLightbox({
  url,
  name,
  onClose,
  path,
  staging,
}: {
  url: string;
  name: string;
  onClose: () => void;
  /** 完整绝对路径（给了才渲染路径行 + 复制键）。 */
  path?: string;
  /** 暂存未入池（「临时」badge，与 composer chip 同一语义）。 */
  staging?: boolean;
}) {
  const copy = useMessageCopy(t('chat.toolImage.pathCopied'));
  return (
    <ModalShell
      label={t('chat.toolImage.previewNamed', { name })}
      closeLabel={t('chat.toolImage.close')}
      onClose={onClose}
      size="xl"
      className="tool-image-lightbox"
      bodyClassName="items-center"
    >
      <img src={url} alt={name} className="tool-image-lightbox-img" />
      <p className="m-0 w-full truncate text-center font-mono text-2xs text-faint" title={name}>
        {name}
        {staging === true && (
          <span className="tool-image-lightbox-staging">{t('chat.toolImage.staging')}</span>
        )}
      </p>
      {path !== undefined && (
        <div className="tool-image-lightbox-path">
          <code className="tool-image-lightbox-path-text" title={path}>
            {path}
          </code>
          <button
            type="button"
            className="tool-image-lightbox-copy"
            onClick={() => copy(path)}
            aria-label={t('chat.toolImage.copyPath')}
            title={t('chat.toolImage.copyPath')}
          >
            <Icon name="copy" size={13} />
          </button>
        </div>
      )}
    </ModalShell>
  );
}
