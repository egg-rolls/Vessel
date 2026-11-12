/**
 * Design Lab token catalog —— **自动枚举版**（不再手写清单）。
 *
 * 唯一事实源是 document.documentElement 上**实际存在**的自定义属性：
 * 用 getComputedStyle(document.documentElement) 逐项枚举出所有 '--' 开头的属性，
 * 再按 TOKEN_GROUP_RULES 的**前缀规则**分组。于是：
 *
 * - 往 styles/tokens.css 里加一个 token，**不改本目录任何代码**，刷新设计实验室
 *   就能看到它（新前缀没被规则命中时落到「其它」组，也不会消失）；
 * - 值的来源是运行时计算值，light / dark 切换（data-theme 或系统主题）自动跟着变；
 * - 颜色类 token 额外采样一份**强制暗色**下的值（sampleDarkValues），这样在亮色主题
 *   下也能并排看到暗色档，不必真的切主题。
 *
 * 枚举走两条路：优先 getComputedStyle 的枚举（Chrome / Firefox / Safari 都会把
 * 自定义属性列在 computed style 里）；万一某个运行时枚举为空（旧引擎），退回到
 * 扫同源样式表的 :root 声明 —— 两条路都只读 DOM，不发任何请求。
 */
import { useEffect, useMemo, useState } from 'react';

export type TokenKind =
  | 'color'
  | 'shadow'
  | 'radius'
  | 'space'
  | 'type'
  | 'font'
  | 'motion'
  | 'size'
  | 'z'
  | 'other';

export interface TokenGroupRule {
  id: string;
  /** 组名的 i18n key（designLab.tokens.*）。 */
  titleKey: string;
  kind: TokenKind;
  /**
   * 命中规则：token 名 startsWith 任一项即归本组。**顺序即优先级**，
   * 空数组 = 兜底组（放最后）。新增 token 只可能落到已有组或兜底组，不会丢。
   */
  prefixes: readonly string[];
}

/**
 * 前缀 → 组的映射表（唯一需要手工维护的地方）。
 *
 * 规则按顺序匹配：更专的前缀写在前面，语义相近的家族用显式前缀分开
 * （字号家族的 --size-* 与尺寸组的容器宽度不是同一回事）。
 */
export const TOKEN_GROUP_RULES: readonly TokenGroupRule[] = [
  {
    id: 'color',
    titleKey: 'designLab.tokens.colors',
    kind: 'color',
    prefixes: [
      '--color',
      '--bg',
      '--surface',
      '--ink',
      '--muted',
      '--faint',
      '--line',
      '--accent',
      '--ok',
      '--warn',
      '--amber',
      '--danger',
      '--info',
      '--hover',
      '--press',
      '--scrim',
      '--overlay',
    ],
  },
  {
    id: 'shadow',
    titleKey: 'designLab.tokens.shadows',
    kind: 'shadow',
    prefixes: ['--shadow', '--elev', '--focus-ring'],
  },
  {
    id: 'radius',
    titleKey: 'designLab.tokens.radii',
    kind: 'radius',
    prefixes: ['--radius', '--shape'],
  },
  {
    id: 'space',
    titleKey: 'designLab.tokens.spacing',
    kind: 'space',
    prefixes: ['--space', '--gap'],
  },
  {
    id: 'type',
    titleKey: 'designLab.tokens.typography',
    kind: 'type',
    prefixes: ['--size', '--text', '--tracking', '--leading'],
  },
  {
    id: 'font',
    titleKey: 'designLab.tokens.fonts',
    kind: 'font',
    prefixes: ['--font'],
  },
  {
    id: 'motion',
    titleKey: 'designLab.tokens.motion',
    kind: 'motion',
    prefixes: ['--motion', '--ease', '--duration'],
  },
  {
    id: 'size',
    titleKey: 'designLab.tokens.sizes',
    kind: 'size',
    prefixes: [
      '--appbar',
      '--nav',
      '--sessions',
      '--team',
      '--dock',
      '--bottom',
      '--composer',
      '--modal',
      '--panel',
      '--palette',
      '--drawer',
      '--search',
      '--select',
      '--row',
      '--control',
      '--content',
      '--transcript',
      '--touch',
      '--msg-fold',
      '--vvh',
    ],
  },
  {
    id: 'z',
    titleKey: 'designLab.tokens.layers',
    kind: 'z',
    prefixes: ['--z'],
  },
  {
    id: 'other',
    titleKey: 'designLab.tokens.other',
    kind: 'other',
    prefixes: [],
  },
];

/** 兜底规则：任何前缀都没命中的 token 落在这里，所以「新的 token 不会消失」。 */
const FALLBACK_RULE = TOKEN_GROUP_RULES[TOKEN_GROUP_RULES.length - 1] as TokenGroupRule;

/** token 名 → 组规则（前缀顺序即优先级）。 */
export function groupRuleFor(name: string): TokenGroupRule {
  for (const rule of TOKEN_GROUP_RULES) {
    if (rule.prefixes.some((prefix) => name.startsWith(prefix))) return rule;
  }
  return FALLBACK_RULE;
}

export interface TokenGroup {
  id: string;
  titleKey: string;
  kind: TokenKind;
  tokens: readonly string[];
}

export type TokenValues = Readonly<Record<string, string>>;

/** 自定义属性名前缀。 */
const CUSTOM_PROPERTY = '--';

/** 一个 computed style 上枚举到的自定义属性（去重交给调用方）。 */
function customPropertiesOf(style: CSSStyleDeclaration): string[] {
  const names: string[] = [];
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index);
    if (name.startsWith(CUSTOM_PROPERTY)) names.push(name);
  }
  return names;
}

/**
 * 兜底枚举：扫同源样式表里顶层规则的自定义属性声明。
 * 跨域样式表读 cssRules 会抛，忽略即可（本应用的 CSS 都是同源打包产物）。
 */
function customPropertiesFromStyleSheets(): string[] {
  const names = new Set<string>();
  if (typeof document === 'undefined') return [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (rules === null) continue;
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      for (const name of customPropertiesOf(rule.style)) names.add(name);
    }
  }
  return [...names];
}

/**
 * 枚举 :root 上实际存在的自定义属性（已排序，数字感知：--space-2 排在 --space-10 前）。
 *
 * 这是验收点「新增一个 token 不改本页代码就能出现」的实现手段。
 */
export function enumerateTokenNames(): string[] {
  if (typeof document === 'undefined') return [];
  const computed = customPropertiesOf(getComputedStyle(document.documentElement));
  const names = computed.length > 0 ? computed : customPropertiesFromStyleSheets();
  return [...new Set(names)]
    .filter((name) => name.startsWith(CUSTOM_PROPERTY))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
}

function readValues(names: readonly string[], style: CSSStyleDeclaration): TokenValues {
  const values: Record<string, string> = {};
  for (const name of names) values[name] = style.getPropertyValue(name).trim();
  return values;
}

/**
 * 强制暗色采样：临时把 data-theme="dark" 挂到 <html>（**本仓已有的主题机制**，
 * 见 state/theme.ts 的 applyTheme），读一份值再还原。整个过程同步完成，浏览器不会
 * 在中间绘制，所以看不到闪烁；采样结果进程内缓存一次（暗色值不随用户切换主题而变）。
 */
let darkSample: TokenValues | null = null;
let darkSampleKey = '';

function sampleDarkValues(names: readonly string[]): TokenValues {
  const key = names.join(',');
  if (darkSample !== null && darkSampleKey === key) return darkSample;
  if (typeof document === 'undefined') return {};
  const root = document.documentElement;
  const previous = root.getAttribute('data-theme');
  root.setAttribute('data-theme', 'dark');
  const values = readValues(names, getComputedStyle(root));
  if (previous === null) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', previous);
  darkSample = values;
  darkSampleKey = key;
  return values;
}

interface TokenSnapshot {
  names: readonly string[];
  values: TokenValues;
  darkValues: TokenValues;
}

function readSnapshot(): TokenSnapshot {
  if (typeof document === 'undefined') return { names: [], values: {}, darkValues: {} };
  const names = enumerateTokenNames();
  const values = readValues(names, getComputedStyle(document.documentElement));
  return { names, values, darkValues: sampleDarkValues(names) };
}

/** 快照签名：值没变就不重渲染（主题无关的 DOM 变动也会触发 observer）。 */
function snapshotKey(snapshot: TokenSnapshot): string {
  let key = snapshot.names.join(',');
  for (const name of snapshot.names) key += '|' + (snapshot.values[name] ?? '');
  return key;
}

export interface TokenCatalog {
  groups: readonly TokenGroup[];
  values: TokenValues;
  darkValues: TokenValues;
  /** 枚举到的自定义属性总数（页面顶部显示「实际存在 N 个」）。 */
  total: number;
}

function buildGroups(names: readonly string[]): TokenGroup[] {
  const buckets = new Map<string, string[]>();
  for (const name of names) {
    const rule = groupRuleFor(name);
    const bucket = buckets.get(rule.id);
    if (bucket === undefined) buckets.set(rule.id, [name]);
    else bucket.push(name);
  }
  const groups: TokenGroup[] = [];
  for (const rule of TOKEN_GROUP_RULES) {
    const tokens = buckets.get(rule.id);
    if (tokens === undefined) continue;
    groups.push({ id: rule.id, titleKey: rule.titleKey, kind: rule.kind, tokens });
  }
  return groups;
}

/**
 * 订阅 :root 的 token 快照：主题属性 / class / style 变化与系统配色变化都会重读，
 * 所以切主题后设计实验室里的色块与数值立刻跟上。
 */
export function useTokenCatalog(): TokenCatalog {
  const [snapshot, setSnapshot] = useState<TokenSnapshot>(readSnapshot);

  useEffect(() => {
    const update = () => {
      const next = readSnapshot();
      setSnapshot((previous) => (snapshotKey(previous) === snapshotKey(next) ? previous : next));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style'],
    });
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    media?.addEventListener('change', update);
    return () => {
      observer.disconnect();
      media?.removeEventListener('change', update);
    };
  }, []);

  return useMemo(
    () => ({
      groups: buildGroups(snapshot.names),
      values: snapshot.values,
      darkValues: snapshot.darkValues,
      total: snapshot.names.length,
    }),
    [snapshot],
  );
}

/** Font stacks / calc 值会带多余空白与换行；展示前折叠一下。 */
export function formatTokenValue(kind: TokenKind, raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (value === '') return '—';
  return kind === 'font' || kind === 'size' || kind === 'shadow'
    ? value.replace(/\s+/g, ' ')
    : value;
}
