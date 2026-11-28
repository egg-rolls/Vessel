// biome-ignore-all lint/a11y/noSvgWithoutTitle: decorative icons are marked aria-hidden
/**
 * 引用种类图标（与宿主 MessageRefs.tsx 的 SVG 族同一形状；插件独立构建，
 * 不 import 宿主组件，形状在此复刻一份）。颜色继承 currentColor。
 */

export type RefKind = 'file' | 'image' | 'document';

export function RefIcon({ kind, size = 14 }: { kind: RefKind; size?: number }) {
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

export function CloseIcon() {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
    </svg>
  );
}

/** 扩展名 → 种类粗判（与宿主 addRef / node stage 同一口径）。 */
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'avif',
  'tiff',
  'tif',
]);
const DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'md',
  'txt',
  'csv',
  'rtf',
  'odt',
  'ods',
  'odp',
  'json',
  'yaml',
  'yml',
  'xml',
  'log',
]);

export function kindOfPath(path: string): RefKind {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  return 'file';
}

/** 路径 → 显示名（basename；Windows / Unix 分隔符都认）。 */
export function displayNameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}
