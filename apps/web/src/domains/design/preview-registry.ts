/**
 * 组件 / 弹窗样例的**自动发现**（设计实验室的「自动添加」）。
 *
 * 契约（新增一个样例 = 新增一个文件，**不改本目录任何代码**）：
 *
 *   文件名： apps/web/src/**\/*.preview.tsx      ← 位置随组件走，放在组件旁边最好
 *   导出：   export default 渲染用的 React 组件
 *            export const preview: PreviewMeta = { title, titleKey?, descriptionKey?, group?, order? }
 *
 * 发现手段是 Vite 的 `import.meta.glob('/src/**\/*.preview.tsx', { eager: false })`：
 * 编译期把匹配到的文件列成「路径 → 动态 import 函数」的表，样例代码因此**不进首屏
 * chunk**，只有打开设计实验室时才按需拉取。
 *
 * 分组规则：
 *   1. `preview.group` 优先（值就是分组的 id，如 'chat' / 'nav' / 'overlays' / 'ui'）；
 *   2. 缺省用**所在目录名**（`.../previews/chat/queued.preview.tsx` → 'chat'）；
 *   3. 组名的中文标题来自 `PREVIEW_GROUP_RULES` 的映射表；表里没有的组直接显示 id
 *      （语言无关的目录名），所以新目录里的样例也不会被丢掉。
 *
 * ## 变体枚举契约（定论，与 token 展览馆同一条原则：不复制事实）
 *
 * **有运行时变体表的组件，预览必须枚举那张表，不许手写清单。**
 *
 * 也就是说：组件把变体名导出成运行时数组（`BUTTON_VARIANTS` / `BUTTON_SIZES` /
 * `BADGE_TONES` / `COUNT_BADGE_TONES` / `CHIP_TONES` / `COMPOSER_ICON_TONES` /
 * `NAV_STATUS_TONES` …），类型由数组派生（`type X = (typeof ARR)[number]`），
 * cva 的 variant 键集合用 `satisfies Record<X, string>` 与之双向钉住；预览里写
 * `BUTTON_VARIANTS.map(...)`。于是「加一种变体」= 只改组件一处，设计实验室自动多一格，
 * 忘了加进数组则是**编译错误**，而不是预览里静默少一格。
 *
 * 组件若确实拿不到运行时表（变体只活在 class 串 / 外部数据里，没有可导出数组），
 * 预览可以保留手写清单，但**必须加穷举守卫**——`Record<ThatVariant, true>`、
 * `Record<ThatTone, string>` 之类的类型断言，保证「新增变体却忘了更新预览」会编译报错。
 * 不允许留下「预览列表比组件少一项」这种静默漂移。
 */
import type { ComponentType } from 'react';
import { useEffect, useState } from 'react';

export interface PreviewMeta {
  /** 组件名（语言无关，如 'QueuedNotice'）；有任何一种标题都必须能显示。 */
  title: string;
  /** 可选的中文/本地化标题 key（`designLab.*`），存在时优先于 title。 */
  titleKey?: string;
  /** 说明的 i18n key（`designLab.*`）。 */
  descriptionKey?: string;
  /** 分组 id；缺省 = 所在目录名。 */
  group?: string;
  /** 组内排序，小的在前；缺省 100。 */
  order?: number;
}

export interface PreviewModule {
  default: ComponentType;
  preview?: PreviewMeta;
}

export interface PreviewEntry {
  /** glob 给的模块路径，同时当作稳定 id 与「源码路径」展示。 */
  path: string;
  /** 去掉后缀的文件名（meta 缺失时的兜底标题）。 */
  file: string;
  /** 所在目录名（默认分组）。 */
  dirGroup: string;
  load: () => Promise<PreviewModule>;
}

const SUFFIX = '.preview.tsx';

/** 自动发现：`/src` 下任意位置的 `*.preview.tsx`，懒加载（eager: false）。 */
const MODULES: Record<string, () => Promise<PreviewModule>> = import.meta.glob<PreviewModule>(
  '/src/**/*.preview.tsx',
  { eager: false },
);

function entryOf(path: string, load: () => Promise<PreviewModule>): PreviewEntry {
  const segments = path.split('/');
  const filename = segments[segments.length - 1] ?? path;
  const dirGroup = segments[segments.length - 2] ?? '';
  const file = filename.endsWith(SUFFIX) ? filename.slice(0, -SUFFIX.length) : filename;
  return { path, file, dirGroup, load };
}

export const PREVIEW_ENTRIES: readonly PreviewEntry[] = Object.entries(MODULES)
  .map(([path, load]) => entryOf(path, load))
  .sort((left, right) => left.path.localeCompare(right.path, 'en'));

export interface PreviewGroupRule {
  id: string;
  /** 组名 i18n key（`designLab.groups.*`）。 */
  titleKey: string;
}

/** 已知分组的显示名与**排列顺序**（顺序即页面上组的先后）。 */
export const PREVIEW_GROUP_RULES: readonly PreviewGroupRule[] = [
  { id: 'chat', titleKey: 'designLab.groups.chat' },
  { id: 'nav', titleKey: 'designLab.groups.nav' },
  { id: 'overlays', titleKey: 'designLab.groups.overlays' },
  { id: 'ui', titleKey: 'designLab.groups.ui' },
];

export function groupTitleKeyOf(id: string): string | undefined {
  return PREVIEW_GROUP_RULES.find((rule) => rule.id === id)?.titleKey;
}

function groupRank(id: string): number {
  const index = PREVIEW_GROUP_RULES.findIndex((rule) => rule.id === id);
  return index < 0 ? PREVIEW_GROUP_RULES.length : index;
}

const EMPTY_LIBRARY: ReadonlyMap<string, PreviewModule> = new Map();

/**
 * 并行懒加载全部样例模块，**每加载好一个就出现在页面上**（不阻塞其它样例）。
 * 单个样例 import / 求值失败只丢它自己，不影响整页。
 */
export function usePreviewLibrary(
  entries: readonly PreviewEntry[] = PREVIEW_ENTRIES,
): ReadonlyMap<string, PreviewModule> {
  const [loaded, setLoaded] = useState<ReadonlyMap<string, PreviewModule>>(EMPTY_LIBRARY);

  useEffect(() => {
    let alive = true;
    for (const entry of entries) {
      entry
        .load()
        .then((module) => {
          if (!alive) return;
          setLoaded((previous) => {
            if (previous.has(entry.path)) return previous;
            const next = new Map(previous);
            next.set(entry.path, module);
            return next;
          });
        })
        .catch(() => {
          // 单个样例加载失败：跳过它，其它样例照常展示。
        });
    }
    return () => {
      alive = false;
    };
  }, [entries]);

  return loaded;
}

export interface PreviewItem {
  entry: PreviewEntry;
  meta: PreviewMeta;
  Component: ComponentType;
}

export interface PreviewGroup {
  id: string;
  titleKey?: string;
  items: readonly PreviewItem[];
}

const DEFAULT_ORDER = 100;

/**
 * 已加载的模块 → 分组（纯函数，无 i18n）。
 * 组顺序 = `PREVIEW_GROUP_RULES` 顺序，未知组按 id 排在后面。
 */
export function buildPreviewGroups(
  library: ReadonlyMap<string, PreviewModule>,
  entries: readonly PreviewEntry[] = PREVIEW_ENTRIES,
): PreviewGroup[] {
  const buckets = new Map<string, PreviewItem[]>();
  for (const entry of entries) {
    const module = library.get(entry.path);
    if (module === undefined || module.default === undefined) continue;
    const meta: PreviewMeta = module.preview ?? { title: entry.file };
    const groupId = meta.group ?? entry.dirGroup;
    const item: PreviewItem = { entry, meta, Component: module.default };
    const bucket = buckets.get(groupId);
    if (bucket === undefined) buckets.set(groupId, [item]);
    else bucket.push(item);
  }

  const groups: PreviewGroup[] = [];
  for (const [id, items] of buckets) {
    const sorted = [...items].sort((left, right) => {
      const byOrder = (left.meta.order ?? DEFAULT_ORDER) - (right.meta.order ?? DEFAULT_ORDER);
      if (byOrder !== 0) return byOrder;
      return left.meta.title.localeCompare(right.meta.title, 'en');
    });
    const titleKey = groupTitleKeyOf(id);
    groups.push({ id, ...(titleKey === undefined ? {} : { titleKey }), items: sorted });
  }

  return groups.sort(
    (left, right) =>
      groupRank(left.id) - groupRank(right.id) || left.id.localeCompare(right.id, 'en'),
  );
}
