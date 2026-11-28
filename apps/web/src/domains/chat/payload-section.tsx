import { useId, useMemo, useState } from 'react';
import { CopyButton } from '../../components/CopyButton';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import type { Verbosity } from '../../state/visibility';
import { PAYLOAD_CHUNK_BYTES, PREVIEW_LINES, previewPayload, valueText } from './tool-cards';

/**
 * 一段原始文本的完整能力：折叠预览（20 行 / 8 KiB）+ 展开分块加载 + 复制 + debug 行列字节。
 *
 * spec = `docs/specs/projection-card-spec.md`（0.54 投影卡规格；早期 design 稿已退场）。
 *
 * 0.54 从 `ToolCard.tsx` 里搬出来单独成文件（**行为一字未改**）：投影卡的两个视角面板
 * 要复用它（spec §3.3「两个面板都是 PayloadSection，零新渲染逻辑」），而 `ToolCard` 又要
 * import 投影卡组件 —— 留在原文件会绕成循环 import。搬出来是唯一不复制那份渲染逻辑的走法。
 */

export interface SectionProps {
  label: string;
  value: unknown;
  defaultOpen?: boolean;
  tone?: 'error';
  verbosity: Verbosity;
  /**
   * 复制按钮文案（缺省 `chat.tool.copy`）。
   *
   * 投影卡用它把两个按钮分清楚：「复制原文」与「复制模型看到的文本」—— 后者复制的是
   * **模型真正看到的那一字节**，两者一眼不能混（spec §3.4）。
   */
  copyLabel?: string;
}

/**
 * 独立折叠的 payload 分区：折叠时只渲染 20 行 / 8KB 预览，不挂载完整 DOM；
 * 展开后超过 200KB 分段加载。保留原始换行与行首空格。
 */
export function PayloadSection({
  label,
  value,
  defaultOpen = false,
  tone,
  verbosity,
  copyLabel,
}: SectionProps) {
  // JSON.stringify(pretty) 对 512KiB payload 约 1ms；卡片每次重渲都会走一次（流式 20Hz），
  // 而 value 的引用是稳定的，按引用 memo 就够了。
  const text = useMemo(() => valueText(value), [value]);
  const [open, setOpen] = useState(defaultOpen);
  const [loadedBytes, setLoadedBytes] = useState(PAYLOAD_CHUNK_BYTES);
  const id = useId();
  if (!text) return null;

  const preview = previewPayload(text);
  const shown = open ? text.slice(0, loadedBytes) : preview.preview;
  const hasMore = open && text.length > loadedBytes;
  const hiddenLines = preview.truncated && !open;

  return (
    <section className={`tool-section ${tone === 'error' ? 'tool-section-error' : ''}`.trim()}>
      <div className="tool-section-head">
        <button
          type="button"
          className="tool-section-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="tool-section-label">{label}</span>
          {!open && hiddenLines && (
            <span className="tool-section-meta">
              {t('chat.tool.previewLines', {
                shown: Math.min(preview.totalLines, PREVIEW_LINES),
                total: preview.totalLines,
              })}
            </span>
          )}
        </button>
        <CopyButton
          text={text}
          label={copyLabel ?? t('chat.tool.copy')}
          className="tool-section-copy"
        />
      </div>
      <pre className={`tool-section-body ${open ? '' : 'tool-section-preview'}`.trim()} id={id}>
        {shown}
      </pre>
      {hasMore && (
        <Button
          variant="link"
          className="tool-section-more"
          onClick={() => setLoadedBytes((value) => value + PAYLOAD_CHUNK_BYTES)}
        >
          {t('chat.tool.loadMore', {
            loaded: Math.round(loadedBytes / 1024),
            total: Math.round(text.length / 1024),
          })}
        </Button>
      )}
      {!open && preview.truncated && (
        <Button variant="link" className="tool-section-more" onClick={() => setOpen(true)}>
          {t('chat.tool.showAll', { total: preview.totalLines })}
        </Button>
      )}
      {verbosity === 'debug' && (
        <div className="tool-section-debug font-mono tabular-nums">
          {preview.totalLines} lines · {preview.totalBytes} bytes
        </div>
      )}
    </section>
  );
}
