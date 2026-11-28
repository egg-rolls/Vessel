// biome-ignore-all lint/a11y/noSvgWithoutTitle: decorative icons are marked aria-hidden
/**
 * 引用种类图标（宿主唯一实现，块 P0 消重复矩阵）。
 *
 * 收编自 MessageRefs 的私有 RefIcon 与 ToolImageCard 的 ImageIcon（同一形状、
 * 同一 currentColor 口径）。`size` 保留两处原有几何：chip 13px / 图片卡头 14px ——
 * DOM 等价是验收口径，不借统一之名改尺寸。
 */
import type { MessageRef } from '../../gateway/types';

export function RefIcon({ kind, size = 13 }: { kind: MessageRef['kind']; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: 'false' as const,
  };
  if (kind === 'image') {
    return (
      <svg {...common}>
        <rect x="3" y="4" width="14" height="12" rx="2" />
        <circle cx="7.5" cy="8" r="1.3" />
        <path d="M4 14.5 8.5 10l3 3 2-2 2.5 2.5" />
      </svg>
    );
  }
  if (kind === 'document') {
    return (
      <svg {...common}>
        <path d="M5 3.5h6.5L15.5 8v8.5H5z" />
        <path d="M11.5 3.5V8h4" />
        <path d="M7.5 11h5M7.5 13.5h3.5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M5 3.5h6.5L15.5 8v8.5H5z" />
      <path d="M11.5 3.5V8h4" />
    </svg>
  );
}
