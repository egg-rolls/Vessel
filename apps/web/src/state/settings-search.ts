/**
 * 设置搜索（VSCode 式，vscode-settings-design §3.3）：纯函数，不 import React。
 *
 * 匹配域：title + description + id/key 键路径 + keywords + enum 选项。
 * 大小写不敏感；中文按子串；多词空格分词取 AND。
 * 筛选 token（VSCode @ 语法子集）：@modified / @plugin:<id> / @local / @user / @project。
 */
import type { SettingDef, SettingScope } from './settings-registry';

export type SearchFilter =
  | { kind: 'modified' }
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'scope'; scope: SettingScope };

export interface ParsedSearch {
  /** 小写化的自由文本（空格分词）。 */
  text: string;
  filters: SearchFilter[];
}

const SCOPE_TOKENS: ReadonlySet<string> = new Set(['local', 'user', 'project']);

export function parseSearch(raw: string): ParsedSearch {
  const filters: SearchFilter[] = [];
  const words: string[] = [];
  for (const token of raw.trim().split(/\s+/)) {
    if (!token) continue;
    if (token === '@modified') {
      filters.push({ kind: 'modified' });
    } else if (token.startsWith('@plugin:')) {
      const pluginId = token.slice('@plugin:'.length);
      if (pluginId) filters.push({ kind: 'plugin', pluginId });
    } else if (token.startsWith('@') && SCOPE_TOKENS.has(token.slice(1))) {
      filters.push({ kind: 'scope', scope: token.slice(1) as SettingScope });
    } else {
      words.push(token);
    }
  }
  return { text: words.join(' ').toLowerCase(), filters };
}

/** 一项的搜索草堆（构建一次，useMemo 缓存；§3.3 索引）。 */
export function buildSearchHaystack(def: SettingDef, title: string, description: string): string {
  return [title, description, def.id, def.key, ...(def.keywords ?? []), ...(def.options ?? [])]
    .join(' ')
    .toLowerCase();
}

export interface SearchContext {
  haystacks: ReadonlyMap<string, string>;
  isModified: (def: SettingDef) => boolean;
}

export function matchesSearch(def: SettingDef, parsed: ParsedSearch, ctx: SearchContext): boolean {
  for (const filter of parsed.filters) {
    if (filter.kind === 'modified' && !ctx.isModified(def)) return false;
    if (filter.kind === 'plugin' && def.pluginId !== filter.pluginId) return false;
    if (filter.kind === 'scope' && def.scope !== filter.scope) return false;
  }
  if (!parsed.text) return true;
  const haystack = ctx.haystacks.get(def.id) ?? '';
  return parsed.text.split(/\s+/).every((word) => haystack.includes(word));
}

/**
 * @modified 判定（§7.3）：值 ≠ 契约默认；无 default 回退 fallback；
 * 两者皆无 → 显式非空即视为已修改。view / 只读说明行不参与。
 */
export function isSettingModified(def: SettingDef, value: string | undefined): boolean {
  if (def.type === 'view' || def.readOnly) return false;
  const baseline = def.default ?? def.fallback;
  if (baseline === undefined) return value !== undefined && value !== '';
  return (value ?? '') !== baseline;
}

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 命中文字 <mark> 高亮分段（多词 OR，大小写不敏感；无查询词整段不命中）。 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || !text) return [{ text, hit: false }];
  const pattern = new RegExp(`(${words.map(escapeRegExp).join('|')})`, 'gi');
  const segments: HighlightSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ text: text.slice(last, index), hit: false });
    segments.push({ text: match[0], hit: true });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), hit: false });
  return segments;
}
