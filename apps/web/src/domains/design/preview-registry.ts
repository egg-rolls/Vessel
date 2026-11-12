/**
 * 组件 / 弹窗样例的**自动发现**（设计实验室的「自动添加」）。
 *
 * 契约（新增一个样例 = 新增一个文件，**不改本目录任何代码**）：
 *
 *   文件名： apps/web/src/**\/*.preview.tsx      ← 位置随组件走，放在组件旁边最好
 *   导出：   export default 渲染用的 React 组件（只读：不发 RPC、不改全局状态）
 *            export const preview: PreviewMeta = { title, titleKey?, descriptionKey?, group?, order? }
 *
 * 文案约定：样例的可见文案全部走 i18n，键名统一在 `designLab.preview.<样例 id>.*`
 * 下（`titleKey` / `descriptionKey` 与样例内的说明文字都是），本目录不再有
 * `designLab.sample.*` / `designLab.demo.*` 这两种历史写法。
 *
 * 发现手段是 Vite 的 `import.meta.glob('/src/**\/*.preview.tsx', { eager: false })`：
 * 编译期把匹配到的文件列成「路径 → 动态 import 函数」的表，样例代码因此**不进首屏
 * chunk**，只有打开设计实验室时才按需拉取；meta 与组件在同一个模块里，加载一次就同时
 * 拿到标题 / 说明 / 分组。
 *
 * 分组规则：
 *   1. `preview.group` 优先（值就是分组的 id，如 'chat' / 'nav' / 'overlays' / 'ui'）；
 *   2. 缺省用**所在目录名**（`.../previews/chat/queued.preview.tsx` → 'chat'）；
 *   3. 组名的中文标题来自 `PREVIEW_GROUP_RULES` 的映射表（同一张表也决定组的先后）；
 *      表里没有的组直接显示 id（语言无关的目录名），所以新目录里的样例也不会被丢掉。
 */
import type { ComponentType } from 'react';
import { useEffect, useState } from 'react';

export interface PreviewMeta {
  /** 组件名（语言无关，如 'QueuedNotice'）；没有 i18n key 时它就是标题。 */
  title: string;
  /** 可选本地化标题 key（`designLab.preview.*`），存在时优先于 title。 */
  titleKey?: string;
  /** 说明的 i18n key（`designLab.preview.*`）。 */
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
