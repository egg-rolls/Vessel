// biome-ignore-all lint/a11y/noSvgWithoutTitle: decorative icons are marked aria-hidden
import type { MessageRef } from '../../gateway/types';
import { t } from '../../i18n';

/**
 * 附件引用的一行 chip（输入框上方 / 已发消息上方共用）。
 *
 * 只有**路径**：组件不读文件、不请求解析、不显示任何正文，也不判断路径存在性。
 * 全路径只放在 `title` 里（hover 可见），列表里显示文件名。
 */
export function refDisplayName(ref: MessageRef): string {
  const named = ref.name?.trim();
  if (named !== undefined && named.length > 0) return named;
  // 不引入 node:path：Windows / Unix 分隔符都认。
  const parts = ref.path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? ref.path;
}

/** 引用种类文案（aria-label / 空文件名兜底用）。 */
export function refKindLabel(ref: MessageRef): string {
  switch (ref.kind) {
    case 'image':
      return t('chat.refs.kind.image');
    case 'document':
      return t('chat.refs.kind.document');
    default:
      return t('chat.refs.kind.file');
  }
}

/** 种类图标：内联 SVG，颜色继承 currentColor（与 DomainIcon 同一口径）。 */
function RefIcon({ kind }: { kind: MessageRef['kind'] }) {
  const common = {
    width: 13,
    height: 13,
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

/**
 * 引用 chip 行。`onRemove` 缺省即只读（已发消息一侧不传）。
 *
 * 缺省 / 空数组渲染 `null`（不占位、不留空行）。
 */
export function MessageRefs({
  refs,
  onRemove,
  className = '',
}: {
  refs?: readonly MessageRef[];
  /** 传了才可删；参数是 refs 里的下标。 */
  onRemove?: (index: number) => void;
  className?: string;
}) {
  if (refs === undefined || refs.length === 0) return null;
  // key 用「同一路径的第几次引用」：在渲染前建表，既不用数组下标，也不会因为
  // 同一路径被引用多次而撞 key（列表本身不排序、不重排）。
  const occurrence = new Map<string, number>();
  return (
    <ul className={`msg-refs ${className}`.trim()} aria-label={t('chat.refs.label')}>
      {refs.map((ref, index) => {
        const seen = occurrence.get(ref.path) ?? 0;
        occurrence.set(ref.path, seen + 1);
        const name = refDisplayName(ref);
        return (
          <li key={`${ref.path}#${seen}`} className="msg-ref" title={ref.path}>
            <span className="msg-ref-icon" aria-hidden="true">
              <RefIcon kind={ref.kind} />
            </span>
            {/* 图标是装饰：种类以 sr-only 文本保留可访问名。 */}
            <span className="sr-only">{refKindLabel(ref)}</span>
            <span className="msg-ref-name">{name}</span>
            {onRemove !== undefined && (
              <button
                type="button"
                className="msg-ref-remove"
                onClick={() => onRemove(index)}
                aria-label={t('chat.refs.remove', { name })}
                title={t('chat.refs.remove', { name })}
              >
                <svg
                  width={11}
                  height={11}
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
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
