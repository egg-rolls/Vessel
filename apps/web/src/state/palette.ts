/** 命令面板的纯数据模型：过滤、排序、分组与索引移动（可单测）。 */

export type PaletteGroup = 'navigation' | 'entity' | 'action' | 'help';

export const PALETTE_GROUP_ORDER: readonly PaletteGroup[] = [
  'navigation',
  'entity',
  'action',
  'help',
];

export const PALETTE_GROUP_LABELS: Record<PaletteGroup, string> = {
  navigation: '导航',
  entity: '实体',
  action: '动作',
  help: '帮助',
};

/** 破坏性动作的二次确认（由 AppShell 渲染 ConfirmDialog）。 */
export interface PaletteConfirm {
  title: string;
  body: string;
  confirmLabel: string;
}

export interface PaletteItem {
  /** 稳定 id（测试与 aria-activedescendant 用）。 */
  id: string;
  group: PaletteGroup;
  label: string;
  keywords?: readonly string[];
  hint?: string;
  /** 破坏性/不可逆动作：必须二次确认，不允许在面板内直接执行。 */
  danger?: boolean;
  confirm?: PaletteConfirm;
  run: () => void;
}

export interface PaletteQuery {
  /** 是否为 `>` 动作模式。 */
  actionMode: boolean;
  needle: string;
}

/** `>` 前缀切换到动作模式；其余按普通搜索处理。 */
export function parsePaletteQuery(raw: string): PaletteQuery {
  const trimmed = raw.trim();
  if (trimmed.startsWith('>')) {
    return { actionMode: true, needle: trimmed.slice(1).trim().toLowerCase() };
  }
  return { actionMode: false, needle: trimmed.toLowerCase() };
}

function matchScore(item: PaletteItem, needle: string): number {
  if (!needle) return 0;
  const label = item.label.toLowerCase();
  if (label === needle) return 0;
  if (label.startsWith(needle)) return 1;
  if (label.split(/\s+/).some((word) => word.startsWith(needle))) return 2;
  if (label.includes(needle)) return 3;
  if (item.keywords?.some((keyword) => keyword.toLowerCase().includes(needle))) return 4;
  return -1;
}

/**
 * 过滤 + 稳定排序：分组顺序固定，组内先按匹配分、再按原顺序。
 * 动作模式下只保留 action/help。
 */
export function filterPaletteItems(
  items: readonly PaletteItem[],
  query: string | PaletteQuery,
): PaletteItem[] {
  const parsed = typeof query === 'string' ? parsePaletteQuery(query) : query;
  const candidates = parsed.actionMode
    ? items.filter((item) => item.group === 'action' || item.group === 'help')
    : [...items];

  if (!parsed.needle) {
    return candidates
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const groupDelta =
          PALETTE_GROUP_ORDER.indexOf(a.item.group) - PALETTE_GROUP_ORDER.indexOf(b.item.group);
        return groupDelta !== 0 ? groupDelta : a.index - b.index;
      })
      .map(({ item }) => item);
  }

  return candidates
    .map((item, index) => ({ item, index, score: matchScore(item, parsed.needle) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      const groupDelta =
        PALETTE_GROUP_ORDER.indexOf(a.item.group) - PALETTE_GROUP_ORDER.indexOf(b.item.group);
      return groupDelta !== 0 ? groupDelta : a.index - b.index;
    })
    .map(({ item }) => item);
}

export interface PaletteSection {
  group: PaletteGroup;
  label: string;
  items: PaletteItem[];
}

/** 按固定顺序分组；空组不输出。 */
export function groupPaletteItems(items: readonly PaletteItem[]): PaletteSection[] {
  return PALETTE_GROUP_ORDER.map((group) => ({
    group,
    label: PALETTE_GROUP_LABELS[group],
    items: items.filter((item) => item.group === group),
  })).filter((section) => section.items.length > 0);
}

/** 循环移动选中索引；空列表返回 -1。 */
export function moveIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  const current = index < 0 ? (delta > 0 ? -1 : 0) : index;
  const next = (current + delta) % count;
  return next < 0 ? next + count : next;
}
