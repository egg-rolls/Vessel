/**
 * 组件 / 弹窗展区：样例表由 preview-registry 的 glob **自动发现**，本文件不认识任何
 * 具体样例 —— 加一个 *.preview.tsx 就自动出现在这里（连标题、说明、分组都是文件自己
 * 声明的）。所有样例都是只读静态数据，不发任何 RPC。
 */
import { Badge, SearchInput, Section } from '@vessel-agent/plugin-ui';
import { Component, type ReactNode, useState } from 'react';
import { ErrorState } from '../../components/States';
import { t } from '../../i18n';
import {
  buildPreviewGroups,
  groupTitleKeyOf,
  PREVIEW_ENTRIES,
  type PreviewItem,
  usePreviewLibrary,
} from './preview-registry';

/**
 * 单个样例渲染失败只坏这一张卡（某个样例的静态数据写错不该让整页白屏）。
 * React 的错误边界目前只有类组件一种实现。
 */
class PreviewBoundary extends Component<
  { message: string; children: ReactNode },
  { failed: boolean }
> {
  override state: { failed: boolean } = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) return <ErrorState message={this.props.message} />;
    return this.props.children;
  }
}

/** 一张样例卡：统一外框（标题 + 说明 + 内容区 + 源码路径）。 */
function PreviewCard({ item }: { item: PreviewItem }) {
  const { Component: Sample, entry, meta } = item;
  const title = meta.titleKey === undefined ? meta.title : t(meta.titleKey);
  const description = meta.descriptionKey === undefined ? undefined : t(meta.descriptionKey);
  return (
    <Section
      title={title}
      description={description}
      actions={
        <span
          className="ml-auto min-w-0 max-w-full truncate font-mono text-2xs text-faint"
          title={entry.path}
        >
          {t('designLab.components.sourcePath')} {entry.path}
        </span>
      }
    >
      <div className="rounded-sm bg-sunken p-3">
        <PreviewBoundary message={t('designLab.components.renderError')}>
          <Sample />
        </PreviewBoundary>
      </div>
    </Section>
  );
}

function matchesNeedle(item: PreviewItem, needle: string): boolean {
  if (needle === '') return true;
  const parts = [
    item.meta.title,
    item.meta.titleKey === undefined ? '' : t(item.meta.titleKey),
    item.meta.descriptionKey === undefined ? '' : t(item.meta.descriptionKey),
    item.entry.path,
    item.meta.group ?? item.entry.dirGroup,
  ];
  return parts.some((part) => part.toLowerCase().includes(needle));
}

/** 组件区：自动收集全部 *.preview.tsx，按 preview.group（缺省目录名）分组展示。 */
export function PreviewSection() {
  const library = usePreviewLibrary();
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  const groups = buildPreviewGroups(library)
    .map((group) => ({ group, items: group.items.filter((item) => matchesNeedle(item, needle)) }))
    .filter((entry) => entry.items.length > 0);

  const total = groups.reduce((sum, entry) => sum + entry.items.length, 0);
  // 三种「空」要分清：没发现样例文件 / 还没加载完 / 过滤没命中。
  const emptyMessage =
    PREVIEW_ENTRIES.length === 0
      ? t('designLab.components.none')
      : library.size === 0
        ? t('designLab.components.loading')
        : t('designLab.components.empty');

  return (
    <section className="flex flex-col gap-5" aria-labelledby="design-lab-components">
      <div className="flex flex-col gap-1.5">
        <h2 id="design-lab-components" className="font-serif text-xl leading-snug text-ink">
          {t('designLab.components.title')}
        </h2>
        <p className="max-w-prose text-md leading-normal text-muted">
          {t('designLab.components.subtitle')}
        </p>
        <p className="max-w-prose text-sm leading-normal text-muted">
          {t('designLab.components.autoNote')}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={t('designLab.components.filterPlaceholder')}
          ariaLabel={t('designLab.components.filter')}
          className="grow basis-60 max-w-search"
        />
        <Badge tone="neutral">{t('designLab.components.count', { count: total })}</Badge>
      </div>

      {groups.length === 0 ? (
        <p className="text-md text-muted">{emptyMessage}</p>
      ) : (
        groups.map(({ group, items }) => {
          const titleKey = group.titleKey ?? groupTitleKeyOf(group.id);
          return (
            <div key={group.id} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="text-md font-semibold text-ink">
                  {titleKey === undefined ? group.id : t(titleKey)}
                </h3>
                <span className="font-mono text-2xs text-faint">
                  {t('designLab.components.count', { count: items.length })}
                </span>
              </div>
              {items.map((item) => (
                <PreviewCard key={item.entry.path} item={item} />
              ))}
            </div>
          );
        })
      )}
    </section>
  );
}
